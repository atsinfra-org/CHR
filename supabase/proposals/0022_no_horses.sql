-- Phase 7 — No horses in the system.
-- Requires 0016–0021. Runs in one transaction; safe to run more than once.
--
-- Why: the coach assigns horses in person at the ground. The software must not
-- record, show or imply which horse a rider gets — not to riders, not to staff.
-- A booking is simply a place in a class, limited by the class's capacity.
--
-- What changes
--  1. book_class(session) / reschedule_booking(booking, session): no horse is
--     chosen or stored. Capacity is enforced by counting places under the
--     session row lock (same lock as before), so a class can never overfill.
--  2. session_availability(): places left = capacity - booked.
--  3. admin_session_roster(): one row per rider, no horse columns.
--  4. admin_dashboard_metrics(): horse counts removed.
--  5. New admin_set_session_capacity(): staff set the places for one class
--     (e.g. fewer riders on a given day). Never below what is already booked.
--  6. Riders per class for new sessions comes from the setting
--     default_session_capacity (set to 3 here, editable in Admin > Settings).
--  7. Reminders and staff notifications no longer name a horse; old ones are trimmed.
--  8. REMOVED FOR GOOD: the horses table, bookings.horse_id, the horse-per-session
--     index, and the horse functions. There are no bookings yet, so no booking
--     data is lost; the horse list itself (names and descriptions) is deleted.

begin;

-- ─── 1. Riders per class is a setting, not a head-count of horses ───────────
insert into public.system_settings (key, value, description)
values ('default_session_capacity', '3'::jsonb, 'Riders per class for newly generated sessions (a schedule template can override it).')
on conflict (key) do nothing;

update public.system_settings
set value = '3'::jsonb
where key = 'default_session_capacity' and (value is null or jsonb_typeof(value) = 'null');

update public.system_settings
set description = 'Riders per class for newly generated sessions (a schedule template can override it).'
where key = 'default_session_capacity';

create or replace function public.admin_update_setting(p_key text, p_value jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  select value into v_old from public.system_settings where key = p_key for update;
  if not found then raise exception 'UNKNOWN_SETTING'; end if;

  if p_key in ('absence_credit_restore_enabled', 'cancellation_returns_credit') then
    if jsonb_typeof(p_value) is distinct from 'boolean' then raise exception 'INVALID_VALUE' using detail = 'Must be true or false.'; end if;
  elsif p_key = 'max_restored_absences' then
    if not (jsonb_typeof(p_value) = 'null' or public._int_in_range(p_value, 0, 1000)) then
      raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 0 to 1000, or leave empty for unlimited.'; end if;
  elsif p_key = 'weekly_class_limit' then
    if not public._int_in_range(p_value, 1, 14) then raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 1 to 14.'; end if;
  elsif p_key = 'default_session_capacity' then
    if not public._int_in_range(p_value, 1, 12) then raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 1 to 12.'; end if;
  elsif p_key = 'booking_window_days' then
    if not public._int_in_range(p_value, 1, 90) then raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 1 to 90.'; end if;
  elsif p_key = 'pending_order_expiry_hours' then
    if not public._int_in_range(p_value, 1, 720) then raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 1 to 720.'; end if;
  elsif p_key = 'class_reminder_hours' then
    if not public._int_in_range(p_value, 1, 168) then raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 1 to 168.'; end if;
  elsif p_key = 'membership_expiry_notice_days' then
    if not public._int_in_range(p_value, 1, 30) then raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 1 to 30.'; end if;
  else
    raise exception 'SETTING_NOT_EDITABLE';
  end if;

  update public.system_settings set value = p_value, updated_at = now() where key = p_key;
  perform public._audit('system_settings', gen_random_uuid(), 'SETTING_CHANGED',
    jsonb_build_object('key', p_key, 'value', v_old), jsonb_build_object('key', p_key, 'value', p_value));
  return p_value;
end;
$$;

create or replace function public.generate_sessions(p_from date, p_to date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_default_capacity int;
  v_inserted int;
begin
  if not public.is_staff_or_admin() then
    raise exception 'Not authorized';
  end if;

  -- Riders per class comes from the setting (a template can override it).
  -- Scalar subquery, not SELECT INTO, so a missing row falls through to 3.
  v_default_capacity := coalesce(
    (select (value #>> '{}')::int from public.system_settings where key = 'default_session_capacity'),
    3
  );

  insert into public.class_sessions (session_date, start_time, end_time, capacity, template_id)
  select d::date, t.start_time, t.end_time, coalesce(t.capacity, v_default_capacity), t.id
  from generate_series(p_from, p_to, interval '1 day') as d
  join public.schedule_templates t on t.day_of_week = extract(dow from d) and t.is_active
  on conflict (session_date, start_time, end_time) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

create or replace function public.generate_future_sessions()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_window int := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days'), 30);
  v_default_cap int := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'default_session_capacity'), 3);
  v_n int;
begin
  insert into public.class_sessions (session_date, start_time, end_time, capacity, template_id)
  select d::date, t.start_time, t.end_time, coalesce(t.capacity, v_default_cap), t.id
  from generate_series(v_today, v_today + v_window + 7, interval '1 day') as d
  join public.schedule_templates t on t.day_of_week = extract(dow from d) and t.is_active
  on conflict (session_date, start_time, end_time) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ─── 2. Booking and moving a class: a place, never a horse ──────────────────
drop function if exists public.book_class(uuid, uuid);

create or replace function public.book_class(p_session_id uuid)
returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.class_sessions;
  v_membership public.memberships;
  v_balance int;
  v_booked_count int;
  v_booking public.bookings;
  v_block_days int;
  v_block_limit int;
  v_week_index int;
  v_week_count int;
  v_next_eligible_date date;
  v_booking_window_days int;
  v_now_ist_date date := (now() at time zone 'Asia/Kolkata')::date;
  v_now_ist_time time := (now() at time zone 'Asia/Kolkata')::time;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  -- Row lock on the session serialises every booking/reschedule for it.
  select * into v_session from public.class_sessions where id = p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status <> 'open' then
    raise exception 'SESSION_NOT_AVAILABLE'
      using detail = format('This session is %s and not open for booking.', v_session.status);
  end if;
  if v_session.session_date < v_now_ist_date
     or (v_session.session_date = v_now_ist_date and v_session.start_time <= v_now_ist_time) then
    raise exception 'INVALID_SESSION_DATE' using detail = 'This session has already started or passed.';
  end if;

  v_booking_window_days := (select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days');
  if v_booking_window_days is not null and v_session.session_date > v_now_ist_date + v_booking_window_days then
    raise exception 'INVALID_SESSION_DATE'
      using detail = format('Bookings are only open up to %s days ahead.', v_booking_window_days);
  end if;

  -- Prefer a membership that is valid for this session date, has credits,
  -- and expires soonest.
  select * into v_membership
  from public.memberships
  where user_id = v_user_id and status = 'active'
    and end_date >= v_now_ist_date and end_date >= v_session.session_date
    and credits_remaining > 0
  order by end_date asc
  limit 1
  for update;

  if not found then
    if exists (select 1 from public.memberships
               where user_id = v_user_id and status = 'active' and end_date >= v_now_ist_date and credits_remaining > 0) then
      raise exception 'MEMBERSHIP_EXPIRED'
        using detail = 'Your membership ends before this class. Choose an earlier date.';
    elsif exists (select 1 from public.memberships
                  where user_id = v_user_id and status = 'active' and end_date >= v_now_ist_date) then
      raise exception 'NO_CREDITS_REMAINING';
    end if;
    raise exception 'NO_ACTIVE_MEMBERSHIP';
  end if;

  select coalesce(sum(amount), 0) into v_balance from public.credit_ledger where membership_id = v_membership.id;
  if v_balance <= 0 then raise exception 'NO_CREDITS_REMAINING'; end if;

  if exists (select 1 from public.bookings
             where user_id = v_user_id and session_id = p_session_id and status in ('held', 'confirmed')) then
    raise exception 'DUPLICATE_BOOKING';
  end if;

  v_block_days := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'membership_block_days'), 7);
  v_block_limit := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'weekly_class_limit'), 3);
  v_week_index := (v_session.session_date - v_membership.start_date) / v_block_days;

  select count(*) into v_week_count
  from public.bookings b
  join public.class_sessions cs on cs.id = b.session_id
  where b.membership_id = v_membership.id
    and b.status in ('held', 'confirmed', 'completed', 'no_show')
    and (cs.session_date - v_membership.start_date) / v_block_days = v_week_index;

  if v_week_count >= v_block_limit then
    v_next_eligible_date := v_membership.start_date + v_block_days * (v_week_index + 1);
    raise exception 'WEEKLY_LIMIT_REACHED'
      using detail = format('You have reached the maximum of %s classes for this %s-day period. You can book another class from %s.',
                            v_block_limit, v_block_days, to_char(v_next_eligible_date, 'FMMonth FMDD, YYYY')),
            hint = v_next_eligible_date::text;
  end if;

  select count(*) into v_booked_count from public.bookings
  where session_id = p_session_id and status in ('held', 'confirmed');
  if v_booked_count >= v_session.capacity then raise exception 'SESSION_FULL'; end if;

  -- A booking is a place in the class, nothing more. The count above is safe
  -- because the session row is locked.
  begin
    insert into public.bookings (user_id, membership_id, session_id, status, booked_at)
    values (v_user_id, v_membership.id, p_session_id, 'confirmed', now())
    returning * into v_booking;
  exception when unique_violation then
    raise exception 'DUPLICATE_BOOKING';
  end;

  insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type, description)
  values (v_user_id, v_membership.id, v_booking.id, -1, 'booking', 'Class booked');

  v_name := public._display_name(v_user_id);
  perform public._audit('bookings', v_booking.id, 'BOOKING_CREATED', null,
    jsonb_build_object('session_id', p_session_id, 'membership_id', v_membership.id));
  perform public._notify_user(v_user_id, 'booking_confirmed', 'Booking confirmed',
    public._fmt_slot(v_session),
    jsonb_build_object('booking_id', v_booking.id));
  perform public._notify_admins('booking_created', 'New class booking',
    v_name || ' · ' || public._fmt_slot(v_session),
    jsonb_build_object('booking_id', v_booking.id, 'session_id', p_session_id, 'user_id', v_user_id));

  return v_booking;
end;
$$;

revoke execute on function public.book_class(uuid) from public, anon;
grant execute on function public.book_class(uuid) to authenticated;

drop function if exists public.reschedule_booking(uuid, uuid, uuid);

create or replace function public.reschedule_booking(
  p_booking_id uuid, p_new_session_id uuid
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_old public.bookings;
  v_old_session public.class_sessions;
  v_new_session public.class_sessions;
  v_membership public.memberships;
  v_new public.bookings;
  v_booked int;
  v_block_days int;
  v_block_limit int;
  v_week_index int;
  v_week_count int;
  v_window int;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_now_time time := (now() at time zone 'Asia/Kolkata')::time;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;

  select * into v_old from public.bookings where id = p_booking_id for update;
  if not found or v_old.user_id <> v_user_id then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_old.status not in ('held', 'confirmed') then
    raise exception 'BOOKING_NOT_RESCHEDULABLE' using detail = format('This booking is already %s.', v_old.status);
  end if;
  if v_old.reschedule_count >= 1 then
    raise exception 'ALREADY_RESCHEDULED' using detail = 'A rescheduled class cannot be rescheduled again.';
  end if;

  -- Lock both sessions in a stable order (no deadlock between two users swapping).
  perform 1 from public.class_sessions where id in (v_old.session_id, p_new_session_id) order by id for update;
  select * into v_old_session from public.class_sessions where id = v_old.session_id;
  select * into v_new_session from public.class_sessions where id = p_new_session_id;
  if v_new_session.id is null then raise exception 'SESSION_NOT_FOUND'; end if;

  if v_old_session.session_date < v_today
     or (v_old_session.session_date = v_today and v_old_session.start_time <= v_now_time) then
    raise exception 'RESCHEDULE_WINDOW_CLOSED' using detail = 'This class has already started or passed.';
  end if;

  select * into v_membership from public.memberships where id = v_old.membership_id for update;
  if v_membership.status <> 'active' or v_membership.end_date < v_today then
    raise exception 'MEMBERSHIP_EXPIRED';
  end if;
  if v_membership.reschedules_used >= v_membership.reschedules_allowed then
    raise exception 'RESCHEDULE_LIMIT_REACHED'
      using detail = format('You have used all %s reschedules on this membership.', v_membership.reschedules_allowed);
  end if;

  if v_new_session.status <> 'open' then raise exception 'SESSION_NOT_AVAILABLE'; end if;
  if v_new_session.session_date < v_today
     or (v_new_session.session_date = v_today and v_new_session.start_time <= v_now_time) then
    raise exception 'INVALID_SESSION_DATE' using detail = 'That session has already started or passed.';
  end if;
  v_window := (select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days');
  if v_window is not null and v_new_session.session_date > v_today + v_window then
    raise exception 'INVALID_SESSION_DATE' using detail = format('Bookings are only open up to %s days ahead.', v_window);
  end if;
  if v_new_session.session_date > v_membership.end_date then
    raise exception 'MEMBERSHIP_EXPIRED' using detail = 'Your membership ends before that class.';
  end if;
  if p_new_session_id = v_old.session_id then
    raise exception 'SAME_SLOT';
  end if;

  -- Release the old slot first; everything below runs in this one transaction.
  update public.bookings set status = 'rescheduled' where id = v_old.id;

  v_block_days := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'membership_block_days'), 7);
  v_block_limit := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'weekly_class_limit'), 3);
  v_week_index := (v_new_session.session_date - v_membership.start_date) / v_block_days;
  select count(*) into v_week_count
  from public.bookings b join public.class_sessions cs on cs.id = b.session_id
  where b.membership_id = v_membership.id
    and b.status in ('held', 'confirmed', 'completed', 'no_show')
    and (cs.session_date - v_membership.start_date) / v_block_days = v_week_index;
  if v_week_count >= v_block_limit then raise exception 'WEEKLY_LIMIT_REACHED'; end if;

  if exists (select 1 from public.bookings
             where user_id = v_user_id and session_id = p_new_session_id and status in ('held', 'confirmed')) then
    raise exception 'DUPLICATE_BOOKING';
  end if;

  select count(*) into v_booked from public.bookings
  where session_id = p_new_session_id and status in ('held', 'confirmed');
  if v_booked >= v_new_session.capacity then raise exception 'SESSION_FULL'; end if;

  begin
    insert into public.bookings (user_id, membership_id, session_id, status, booked_at,
                                 original_booking_id, reschedule_count)
    values (v_user_id, v_membership.id, p_new_session_id, 'confirmed', now(),
            v_old.id, v_old.reschedule_count + 1)
    returning * into v_new;
  exception when unique_violation then
    raise exception 'DUPLICATE_BOOKING';
  end;

  update public.memberships set reschedules_used = reschedules_used + 1 where id = v_membership.id;

  -- Zero-amount ledger row: the audit trail shows the entitlement MOVED,
  -- and that no credit was consumed.
  insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type, description)
  values (v_user_id, v_membership.id, v_new.id, 0, 'reschedule',
          'Rescheduled ' || public._fmt_slot(v_old_session) || ' → ' || public._fmt_slot(v_new_session) || ' (no credit used)');

  perform public._audit('bookings', v_new.id, 'BOOKING_RESCHEDULED',
    jsonb_build_object('booking_id', v_old.id, 'session_id', v_old.session_id),
    jsonb_build_object('booking_id', v_new.id, 'session_id', v_new.session_id,
                       'reschedules_used', v_membership.reschedules_used + 1));
  perform public._notify_user(v_user_id, 'reschedule_confirmed', 'Class rescheduled',
    public._fmt_slot(v_old_session) || ' → ' || public._fmt_slot(v_new_session),
    jsonb_build_object('booking_id', v_new.id));
  perform public._notify_admins('booking_rescheduled', 'Class rescheduled',
    public._display_name(v_user_id) || ' · ' || public._fmt_slot(v_old_session) || ' → ' || public._fmt_slot(v_new_session),
    jsonb_build_object('old_booking_id', v_old.id, 'new_booking_id', v_new.id, 'user_id', v_user_id));

  return v_new;
end;
$$;

revoke execute on function public.reschedule_booking(uuid, uuid) from public, anon;
grant execute on function public.reschedule_booking(uuid, uuid) to authenticated;

-- ─── 3. What riders see: places left ────────────────────────────────────────
create or replace function public.session_availability(p_date date)
returns table (
  session_id uuid, session_date date, start_time time, end_time time, session_status text,
  capacity integer, places_left integer, is_bookable boolean, is_mine boolean
)
language sql stable security definer set search_path = public as $$
  select s.id, s.session_date, s.start_time, s.end_time, s.status, s.capacity,
         greatest(s.capacity - coalesce(bk.booked, 0), 0),
         (s.status = 'open'
           and (s.session_date + s.start_time) > (now() at time zone 'Asia/Kolkata')
           and s.session_date <= (now() at time zone 'Asia/Kolkata')::date
                 + coalesce((select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days'), 30)),
         coalesce(bk.mine, false)
  from public.class_sessions s
  left join lateral (
    select count(*)::int as booked, bool_or(b.user_id = auth.uid()) as mine
    from public.bookings b
    where b.session_id = s.id and b.status in ('held', 'confirmed')
  ) bk on true
  where s.session_date = p_date and auth.uid() is not null
  order by s.start_time;
$$;

revoke execute on function public.session_availability(date) from public, anon;
grant execute on function public.session_availability(date) to authenticated;

-- ─── 4. What staff see: who is riding in each class ─────────────────────────
drop function if exists public.admin_session_roster(date);

create or replace function public.admin_session_roster(p_date date)
returns table (
  session_id uuid, start_time time, end_time time, session_status text, capacity integer,
  booking_id uuid, booking_status text, user_id uuid, customer_name text, customer_email text,
  attendance_status text, plan_name text, credits_remaining integer,
  reschedules_used integer, reschedules_allowed integer, reschedule_count integer, original_booking_id uuid
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff_or_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  -- One row per rider; a class with nobody booked still returns one row (booking columns null).
  return query
  select s.id, s.start_time, s.end_time, s.status, s.capacity,
         b.id, b.status, b.user_id, p.full_name, p.email, a.status,
         pl.name, m.credits_remaining, m.reschedules_used, m.reschedules_allowed,
         b.reschedule_count, b.original_booking_id
  from public.class_sessions s
  left join public.bookings b
    on b.session_id = s.id and b.status in ('held', 'confirmed', 'completed', 'absent', 'no_show')
  left join public.profiles p on p.id = b.user_id
  left join public.attendance a on a.booking_id = b.id
  left join public.memberships m on m.id = b.membership_id
  left join public.membership_plans pl on pl.id = m.plan_id
  where s.session_date = p_date
  order by s.start_time, b.booked_at, b.id;
end;
$$;

revoke execute on function public.admin_session_roster(date) from public, anon;
grant execute on function public.admin_session_roster(date) to authenticated;

-- Places for one class. Staff use this when fewer riders can be taken that day.
create or replace function public.admin_set_session_capacity(p_session_id uuid, p_capacity integer)
returns public.class_sessions
language plpgsql security definer set search_path = public as $$
declare
  v_session public.class_sessions;
  v_old int;
  v_booked int;
begin
  if not public.is_staff_or_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if p_capacity is null or p_capacity < 1 or p_capacity > 12 then
    raise exception 'INVALID_CAPACITY' using detail = 'Use a whole number from 1 to 12.';
  end if;

  -- Same row lock as book_class(), so a booking cannot slip in while the number changes.
  select * into v_session from public.class_sessions where id = p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  v_old := v_session.capacity;

  select count(*) into v_booked from public.bookings
  where session_id = p_session_id and status in ('held', 'confirmed');
  if p_capacity < v_booked then
    raise exception 'CAPACITY_BELOW_BOOKINGS'
      using detail = format('%s rider(s) are already booked in this class. Cancel a booking first.', v_booked);
  end if;

  update public.class_sessions set capacity = p_capacity where id = p_session_id returning * into v_session;
  perform public._audit('class_sessions', p_session_id, 'SET_SESSION_CAPACITY',
    jsonb_build_object('capacity', v_old), jsonb_build_object('capacity', p_capacity));
  return v_session;
end;
$$;

revoke execute on function public.admin_set_session_capacity(uuid, integer) from public, anon;
grant execute on function public.admin_set_session_capacity(uuid, integer) to authenticated;

-- ─── 5. Dashboard numbers without horse counts ──────────────────────────────
drop function if exists public.admin_dashboard_metrics();

create or replace function public.admin_dashboard_metrics()
returns table (
  total_members integer, active_memberships integer, pending_payment_memberships integer,
  sessions_today integer, bookings_today integer, open_sessions_next_7d integer,
  capacity_next_7d bigint, booked_next_7d bigint, pending_payments integer, cancellations_7d integer,
  bookings_awaiting_attendance integer, enquiries_total integer, total_bookings integer,
  revenue_total numeric, revenue_30d numeric, revenue_prev_30d numeric
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_is_admin boolean := public.is_admin();
begin
  if not public.is_staff_or_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  return query
  select
    (select count(*)::int from public.profiles where role = 'member'),
    (select count(*)::int from public.memberships where status = 'active' and end_date >= v_today),
    (select count(*)::int from public.memberships where status = 'pending_payment'),
    (select count(*)::int from public.class_sessions where session_date = v_today),
    (select count(*)::int from public.bookings b
       join public.class_sessions s on s.id = b.session_id
       where s.session_date = v_today and b.status in ('confirmed', 'completed', 'no_show')),
    (select count(*)::int from public.class_sessions
       where session_date > v_today and session_date <= v_today + 7 and status = 'open'),
    (select coalesce(sum(s.capacity), 0) from public.class_sessions s
       where s.session_date > v_today and s.session_date <= v_today + 7 and s.status = 'open'),
    (select count(*) from public.bookings b
       join public.class_sessions s on s.id = b.session_id
       where s.session_date > v_today and s.session_date <= v_today + 7 and b.status = 'confirmed'),
    (select count(*)::int from public.payments where status in ('created', 'pending', 'processing')),
    (select count(*)::int from public.bookings
       where status = 'cancelled' and cancelled_at >= now() - interval '7 days'),
    (select count(*)::int from public.bookings b
       join public.class_sessions s on s.id = b.session_id
       where b.status = 'confirmed' and s.session_date < v_today
         and not exists (select 1 from public.attendance a where a.booking_id = b.id)),
    case when v_is_admin then (select count(*)::int from public.enquiries) else null end,
    (select count(*)::int from public.bookings where status in ('confirmed', 'completed', 'no_show')),
    (select coalesce(sum(amount), 0)::numeric from public.payments where status = 'success' and currency = 'INR'),
    (select coalesce(sum(amount), 0)::numeric from public.payments
       where status = 'success' and currency = 'INR'
         and paid_at is not null and (paid_at at time zone 'Asia/Kolkata')::date > v_today - 30),
    (select coalesce(sum(amount), 0)::numeric from public.payments
       where status = 'success' and currency = 'INR'
         and paid_at is not null
         and (paid_at at time zone 'Asia/Kolkata')::date > v_today - 60
         and (paid_at at time zone 'Asia/Kolkata')::date <= v_today - 30);
end;
$$;

revoke execute on function public.admin_dashboard_metrics() from public, anon;
grant execute on function public.admin_dashboard_metrics() to authenticated;

-- ─── 6. Notifications never name a horse ────────────────────────────────────
create or replace function public.send_lifecycle_notifications()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_now timestamp := now() at time zone 'Asia/Kolkata';
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_hours int := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'class_reminder_hours'), 24);
  v_days int := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'membership_expiry_notice_days'), 3);
  v_a int; v_b int;
begin
  insert into public.notifications (audience, user_id, type, title, body, data)
  select 'user', b.user_id, 'class_reminder', 'Upcoming class',
         public._fmt_slot(s), jsonb_build_object('booking_id', b.id)
  from public.bookings b
  join public.class_sessions s on s.id = b.session_id
  where b.status in ('held', 'confirmed')
    and (s.session_date + s.start_time) > v_now
    and (s.session_date + s.start_time) <= v_now + make_interval(hours => v_hours)
    and not exists (select 1 from public.notifications n
                    where n.type = 'class_reminder' and n.data ->> 'booking_id' = b.id::text);
  get diagnostics v_a = row_count;

  insert into public.notifications (audience, user_id, type, title, body, data)
  select 'user', m.user_id, 'membership_expiring', 'Membership ending soon',
         format('Your membership ends on %s with %s class%s left.', to_char(m.end_date, 'DD Mon YYYY'),
                m.credits_remaining, case when m.credits_remaining = 1 then '' else 'es' end),
         jsonb_build_object('membership_id', m.id)
  from public.memberships m
  where m.status = 'active' and m.credits_remaining > 0
    and m.end_date >= v_today and m.end_date <= v_today + v_days
    and not exists (select 1 from public.notifications n
                    where n.type = 'membership_expiring' and n.data ->> 'membership_id' = m.id::text);
  get diagnostics v_b = row_count;
  return v_a + v_b;
end;
$$;

-- Staff: "<rider> · <slot> · <horse>" becomes "<rider> · <slot>".
update public.notifications
set body = split_part(body, ' · ', 1) || ' · ' || split_part(body, ' · ', 2)
where audience = 'admin' and type = 'booking_created' and body like '% · % · %';

-- Riders: "<slot> · <horse>" becomes "<slot>".
update public.notifications
set body = split_part(body, ' · ', 1)
where audience = 'user' and type in ('booking_confirmed', 'class_reminder') and body like '% · %';

-- ─── 7. Remove the horse records themselves (permanent) ─────────────────────
-- No CASCADE on purpose: if anything unexpected still depends on these, the
-- whole migration stops and nothing is changed.
drop function if exists public.session_horse_availability(date);
drop function if exists public.admin_create_horse(text, text);
drop function if exists public.admin_set_horse_status(uuid, text, boolean);
drop index if exists public.uq_bookings_active_horse_per_session;
alter table public.bookings drop column if exists horse_id;
drop table if exists public.horses;

notify pgrst, 'reload schema';

commit;
