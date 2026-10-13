-- Phase 10 — close the gaps found in the project audit.
-- Requires 0016–0024. Runs in one transaction; safe to run more than once.
--
--  1. max_future_bookings is enforced by book_class() and editable in Settings.
--  2. Waitlist: a rider can queue for a full class; when a place frees up the
--     longest-waiting riders are told (nobody is booked automatically, so no
--     class is spent without the rider choosing it). Switch: waitlist_enabled.
--  3. Weekly timetable: admins add, change and switch off timetable slots
--     (admin_save_template). New sessions are generated from it.
--  4. Enquiries: a status (new / answered), who handled it and when, and a bell
--     notification to the admins when one arrives.
--
-- The site works before and after this runs: the new screens only appear to
-- do something once their functions exist.

begin;

-- ─── 1. Settings the admin can edit ─────────────────────────────────────────
create or replace function public.admin_update_setting(p_key text, p_value jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  select value into v_old from public.system_settings where key = p_key for update;
  if not found then raise exception 'UNKNOWN_SETTING'; end if;

  if p_key in ('absence_credit_restore_enabled', 'cancellation_returns_credit', 'waitlist_enabled') then
    if jsonb_typeof(p_value) is distinct from 'boolean' then raise exception 'INVALID_VALUE' using detail = 'Must be true or false.'; end if;
  elsif p_key = 'max_restored_absences' then
    if not (jsonb_typeof(p_value) = 'null' or public._int_in_range(p_value, 0, 1000)) then
      raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 0 to 1000, or leave empty for unlimited.'; end if;
  elsif p_key = 'weekly_class_limit' then
    if not public._int_in_range(p_value, 1, 14) then raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 1 to 14.'; end if;
  elsif p_key = 'max_future_bookings' then
    if not public._int_in_range(p_value, 1, 50) then raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 1 to 50.'; end if;
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

update public.system_settings
set description = 'How many upcoming classes a rider can hold at once (booked, not yet ridden).'
where key = 'max_future_bookings';

update public.system_settings
set description = 'When a class is full, riders can join a waitlist and are told when a place frees up.'
where key = 'waitlist_enabled';

-- ─── 2. Waitlist ────────────────────────────────────────────────────────────
create table if not exists public.waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.class_sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  unique (session_id, user_id)
);
create index if not exists idx_waitlist_session_created on public.waitlist_entries (session_id, created_at);

alter table public.waitlist_entries enable row level security;

drop policy if exists "Members read own waitlist" on public.waitlist_entries;
create policy "Members read own waitlist" on public.waitlist_entries
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "Staff read waitlist" on public.waitlist_entries;
create policy "Staff read waitlist" on public.waitlist_entries
  for select to authenticated using (public.is_staff_or_admin());

-- Writes only through the functions below.
revoke all on public.waitlist_entries from anon, authenticated;
grant select on public.waitlist_entries to authenticated;

-- Tell the longest-waiting riders when places are free. First come, first
-- served: the notice does not hold the place.
create or replace function public._waitlist_notify(p_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_session public.class_sessions;
  v_left int;
  r record;
begin
  if not coalesce((select (value #>> '{}')::boolean from public.system_settings where key = 'waitlist_enabled'), false) then
    return;
  end if;
  select * into v_session from public.class_sessions where id = p_session_id;
  if not found or v_session.status <> 'open'
     or (v_session.session_date + v_session.start_time) <= (now() at time zone 'Asia/Kolkata') then
    return;
  end if;
  select greatest(v_session.capacity - count(*), 0) into v_left
  from public.bookings where session_id = p_session_id and status in ('held', 'confirmed');
  if v_left <= 0 then return; end if;

  for r in
    select id, user_id from public.waitlist_entries
    where session_id = p_session_id and notified_at is null
    order by created_at
    limit v_left
    for update skip locked
  loop
    update public.waitlist_entries set notified_at = now() where id = r.id;
    perform public._notify_user(r.user_id, 'waitlist_place_free', 'A place has opened up',
      public._fmt_slot(v_session) || ' · book it now before it goes',
      jsonb_build_object('session_id', p_session_id));
  end loop;
end;
$$;

create or replace function public._trg_waitlist_after_booking()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status in ('held', 'confirmed') and new.status not in ('held', 'confirmed') then
    perform public._waitlist_notify(new.session_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_waitlist_after_booking on public.bookings;
create trigger trg_waitlist_after_booking after update of status on public.bookings
  for each row execute function public._trg_waitlist_after_booking();

create or replace function public._trg_waitlist_after_capacity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.capacity > old.capacity then
    perform public._waitlist_notify(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_waitlist_after_capacity on public.class_sessions;
create trigger trg_waitlist_after_capacity after update of capacity on public.class_sessions
  for each row execute function public._trg_waitlist_after_capacity();

revoke execute on function public._waitlist_notify(uuid) from public, anon, authenticated;
revoke execute on function public._trg_waitlist_after_booking() from public, anon, authenticated;
revoke execute on function public._trg_waitlist_after_capacity() from public, anon, authenticated;

create or replace function public.join_waitlist(p_session_id uuid)
returns public.waitlist_entries
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_session public.class_sessions;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_now_time time := (now() at time zone 'Asia/Kolkata')::time;
  v_window int;
  v_booked int;
  v_entry public.waitlist_entries;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  if not coalesce((select (value #>> '{}')::boolean from public.system_settings where key = 'waitlist_enabled'), false) then
    raise exception 'WAITLIST_DISABLED';
  end if;

  -- The same row lock book_class() takes, so a join and a booking never interleave.
  select * into v_session from public.class_sessions where id = p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status <> 'open' then raise exception 'SESSION_NOT_AVAILABLE'; end if;
  if v_session.session_date < v_today or (v_session.session_date = v_today and v_session.start_time <= v_now_time) then
    raise exception 'INVALID_SESSION_DATE' using detail = 'This session has already started or passed.';
  end if;
  v_window := (select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days');
  if v_window is not null and v_session.session_date > v_today + v_window then
    raise exception 'INVALID_SESSION_DATE' using detail = format('Bookings are only open up to %s days ahead.', v_window);
  end if;

  if not exists (select 1 from public.memberships
                 where user_id = v_user and status = 'active' and end_date >= v_session.session_date and credits_remaining > 0) then
    raise exception 'NO_ACTIVE_MEMBERSHIP';
  end if;
  if exists (select 1 from public.bookings where user_id = v_user and session_id = p_session_id and status in ('held', 'confirmed')) then
    raise exception 'DUPLICATE_BOOKING';
  end if;

  select count(*) into v_booked from public.bookings where session_id = p_session_id and status in ('held', 'confirmed');
  if v_booked < v_session.capacity then raise exception 'SESSION_NOT_FULL'; end if;

  select * into v_entry from public.waitlist_entries where session_id = p_session_id and user_id = v_user;
  if found then return v_entry; end if;

  if (select count(*) from public.waitlist_entries w join public.class_sessions cs on cs.id = w.session_id
      where w.user_id = v_user and (cs.session_date + cs.start_time) > (now() at time zone 'Asia/Kolkata')) >= 10 then
    raise exception 'WAITLIST_LIMIT';
  end if;

  insert into public.waitlist_entries (session_id, user_id) values (p_session_id, v_user) returning * into v_entry;
  return v_entry;
end;
$$;

create or replace function public.leave_waitlist(p_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  delete from public.waitlist_entries where session_id = p_session_id and user_id = auth.uid();
end;
$$;

revoke execute on function public.join_waitlist(uuid) from public, anon;
grant execute on function public.join_waitlist(uuid) to authenticated;
revoke execute on function public.leave_waitlist(uuid) from public, anon;
grant execute on function public.leave_waitlist(uuid) to authenticated;

-- ─── 3. book_class: the future-booking limit, and leave the waitlist on booking
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
  v_max_future int;
  v_future_count int;
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

  -- How many upcoming classes one rider may hold at once.
  v_max_future := (select (value #>> '{}')::int from public.system_settings where key = 'max_future_bookings');
  if v_max_future is not null then
    select count(*) into v_future_count
    from public.bookings b join public.class_sessions cs on cs.id = b.session_id
    where b.user_id = v_user_id and b.status in ('held', 'confirmed')
      and (cs.session_date + cs.start_time) > (now() at time zone 'Asia/Kolkata');
    if v_future_count >= v_max_future then
      raise exception 'FUTURE_BOOKING_LIMIT'
        using detail = format('You can hold up to %s upcoming classes at a time. Ride one, or move one, to book another.', v_max_future);
    end if;
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

  -- Booked: no longer waiting for this class.
  delete from public.waitlist_entries where session_id = p_session_id and user_id = v_user_id;

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

-- ─── 4. Weekly timetable ────────────────────────────────────────────────────
-- Admin only. Slots are switched off, never deleted: generated sessions point
-- at the slot they came from. Changes apply to sessions generated from now on;
-- classes already on the calendar keep their time (change those on Sessions).
create or replace function public.admin_save_template(
  p_id uuid, p_day integer, p_start time, p_end time, p_capacity integer, p_active boolean
) returns public.schedule_templates
language plpgsql security definer set search_path = public as $$
declare
  v_row public.schedule_templates;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if p_day is null or p_day < 0 or p_day > 6 then
    raise exception 'INVALID_VALUE' using detail = 'Choose a day of the week.';
  end if;
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'INVALID_VALUE' using detail = 'The class must end after it starts.';
  end if;
  if p_capacity is not null and (p_capacity < 1 or p_capacity > 12) then
    raise exception 'INVALID_VALUE' using detail = 'Use a whole number of riders from 1 to 12, or leave it empty for the default.';
  end if;

  if coalesce(p_active, true) and exists (
    select 1 from public.schedule_templates t
    where t.is_active and t.day_of_week = p_day and t.id is distinct from p_id
      and t.start_time < p_end and t.end_time > p_start
  ) then
    raise exception 'TEMPLATE_OVERLAP' using detail = 'Another active slot on that day overlaps this time.';
  end if;

  if p_id is null then
    insert into public.schedule_templates (day_of_week, start_time, end_time, capacity, is_active)
    values (p_day, p_start, p_end, p_capacity, coalesce(p_active, true))
    returning * into v_row;
    perform public._audit('schedule_templates', v_row.id, 'TEMPLATE_CREATED', null,
      jsonb_build_object('day', p_day, 'start', p_start, 'end', p_end, 'capacity', p_capacity, 'active', v_row.is_active));
  else
    update public.schedule_templates
    set day_of_week = p_day, start_time = p_start, end_time = p_end, capacity = p_capacity,
        is_active = coalesce(p_active, is_active), updated_at = now()
    where id = p_id
    returning * into v_row;
    if not found then raise exception 'TEMPLATE_NOT_FOUND'; end if;
    perform public._audit('schedule_templates', v_row.id, 'TEMPLATE_UPDATED', null,
      jsonb_build_object('day', p_day, 'start', p_start, 'end', p_end, 'capacity', p_capacity, 'active', v_row.is_active));
  end if;
  return v_row;
end;
$$;

revoke execute on function public.admin_save_template(uuid, integer, time, time, integer, boolean) from public, anon;
grant execute on function public.admin_save_template(uuid, integer, time, time, integer, boolean) to authenticated;

-- ─── 5. Enquiries ───────────────────────────────────────────────────────────
alter table public.enquiries
  add column if not exists status text not null default 'new',
  add column if not exists handled_at timestamptz,
  add column if not exists handled_by uuid references public.profiles (id) on delete set null,
  add column if not exists emailed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'enquiries_status_check') then
    alter table public.enquiries add constraint enquiries_status_check check (status in ('new', 'answered'));
  end if;
end $$;

create or replace function public.admin_set_enquiry_status(p_id uuid, p_status text)
returns public.enquiries
language plpgsql security definer set search_path = public as $$
declare
  v_row public.enquiries;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if p_status not in ('new', 'answered') then raise exception 'INVALID_VALUE'; end if;
  update public.enquiries
  set status = p_status,
      handled_at = case when p_status = 'answered' then now() else null end,
      handled_by = case when p_status = 'answered' then auth.uid() else null end
  where id = p_id
  returning * into v_row;
  if not found then raise exception 'ENQUIRY_NOT_FOUND'; end if;
  perform public._audit('enquiries', p_id, 'ENQUIRY_' || upper(p_status), null, jsonb_build_object('status', p_status));
  return v_row;
end;
$$;

revoke execute on function public.admin_set_enquiry_status(uuid, text) from public, anon;
grant execute on function public.admin_set_enquiry_status(uuid, text) to authenticated;

-- A new enquiry rings the admin bell. Never allowed to fail the enquiry itself.
create or replace function public._trg_enquiry_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public._notify_admins('enquiry_new', 'New enquiry',
      new.name || ' · ' || coalesce(nullif(trim(new.topic), ''), 'General') || ' · ' || new.phone,
      jsonb_build_object('enquiry_id', new.id));
  exception when others then
    null;
  end;
  return new;
end;
$$;

drop trigger if exists trg_enquiry_notify on public.enquiries;
create trigger trg_enquiry_notify after insert on public.enquiries
  for each row execute function public._trg_enquiry_notify();

revoke execute on function public._trg_enquiry_notify() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
