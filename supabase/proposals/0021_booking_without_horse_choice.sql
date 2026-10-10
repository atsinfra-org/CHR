-- Phase 7 — Riders book a place, not a horse.
-- Requires 0016–0018. Safe to run more than once.
--
-- Why: if a named horse is ill or resting, a rider who "booked that horse" has
-- a grievance. So riders now choose a day and a time only; book_class() and
-- reschedule_booking() already allocate a free horse when none is passed
-- (unchanged), staff still see the horse on the Schedule and Attendance
-- screens, and nothing rider-facing names one.
--
-- 1. session_availability(date): places left per session, no horse details.
-- 2. book_class(): the rider's confirmation no longer names the horse
--    (the staff notification still does). Body is otherwise identical to 0017.
-- 3. Existing rider notifications are trimmed to the slot.
--
-- The older session_horse_availability() is left in place; the app no longer
-- shows its horse names and stops calling it once this is applied. It can be
-- dropped later with:  drop function public.session_horse_availability(date);

create or replace function public.session_availability(p_date date)
returns table (
  session_id uuid, session_date date, start_time time, end_time time, session_status text,
  capacity integer, places_left integer, is_bookable boolean, is_mine boolean
)
language sql stable security definer set search_path = public as $$
  with sess as (
    select cs.* from public.class_sessions cs
    where cs.session_date = p_date and auth.uid() is not null
  ),
  bk as (
    select b.session_id as sid, count(*)::int as booked, bool_or(b.user_id = auth.uid()) as mine
    from public.bookings b join sess on sess.id = b.session_id
    where b.status in ('held', 'confirmed')
    group by b.session_id
  ),
  fr as (
    select s.id as sid, count(*)::int as free_horses
    from sess s cross join public.horses h
    where h.is_active and h.status = 'available'
      and not exists (select 1 from public.bookings b
                      where b.session_id = s.id and b.horse_id = h.id and b.status in ('held', 'confirmed'))
    group by s.id
  )
  select s.id, s.session_date, s.start_time, s.end_time, s.status, s.capacity,
         greatest(least(s.capacity - coalesce(bk.booked, 0), coalesce(fr.free_horses, 0)), 0),
         (s.status = 'open'
           and (s.session_date + s.start_time) > (now() at time zone 'Asia/Kolkata')
           and s.session_date <= (now() at time zone 'Asia/Kolkata')::date
                 + coalesce((select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days'), 30)),
         coalesce(bk.mine, false)
  from sess s
  left join bk on bk.sid = s.id
  left join fr on fr.sid = s.id
  order by s.start_time;
$$;

revoke execute on function public.session_availability(date) from public, anon;
grant execute on function public.session_availability(date) to authenticated;

create or replace function public.book_class(p_session_id uuid, p_horse_id uuid default null)
returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.class_sessions;
  v_membership public.memberships;
  v_horse_id uuid;
  v_horse public.horses;
  v_balance int;
  v_booked_count int;
  v_booking public.bookings;
  v_block_days int;
  v_block_limit int;
  v_week_index int;
  v_week_count int;
  v_next_eligible_date date;
  v_booking_window_days int;
  v_constraint text;
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

  if p_horse_id is not null then
    select * into v_horse from public.horses where id = p_horse_id;
    if not found or not v_horse.is_active or v_horse.status <> 'available' then
      raise exception 'HORSE_NOT_AVAILABLE';
    end if;
    if exists (select 1 from public.bookings
               where session_id = p_session_id and horse_id = p_horse_id and status in ('held', 'confirmed')) then
      raise exception 'SLOT_NO_LONGER_AVAILABLE';
    end if;
    v_horse_id := p_horse_id;
  else
    select h.id into v_horse_id
    from public.horses h
    where h.is_active and h.status = 'available'
      and not exists (select 1 from public.bookings b
                      where b.session_id = p_session_id and b.horse_id = h.id and b.status in ('held', 'confirmed'))
    order by h.name
    limit 1;
    if v_horse_id is null then raise exception 'SESSION_FULL'; end if;
  end if;

  begin
    insert into public.bookings (user_id, membership_id, session_id, horse_id, status, booked_at)
    values (v_user_id, v_membership.id, p_session_id, v_horse_id, 'confirmed', now())
    returning * into v_booking;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'uq_bookings_active_horse_per_session' then
      raise exception 'SLOT_NO_LONGER_AVAILABLE';
    end if;
    raise exception 'DUPLICATE_BOOKING';
  end;

  insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type, description)
  values (v_user_id, v_membership.id, v_booking.id, -1, 'booking', 'Class booked');

  v_name := public._display_name(v_user_id);
  perform public._audit('bookings', v_booking.id, 'BOOKING_CREATED', null,
    jsonb_build_object('session_id', p_session_id, 'horse_id', v_horse_id, 'membership_id', v_membership.id));
  -- The rider is told WHEN, never WHICH HORSE: the yard allocates the horse
  -- and may change it (illness, rest), so nothing rider-facing names one.
  perform public._notify_user(v_user_id, 'booking_confirmed', 'Booking confirmed',
    public._fmt_slot(v_session),
    jsonb_build_object('booking_id', v_booking.id));
  perform public._notify_admins('booking_created', 'New class booking',
    v_name || ' · ' || public._fmt_slot(v_session) || ' · ' || (select name from public.horses where id = v_horse_id),
    jsonb_build_object('booking_id', v_booking.id, 'session_id', p_session_id, 'user_id', v_user_id));

  return v_booking;
end;
$$;

revoke execute on function public.book_class(uuid, uuid) from public, anon;
grant execute on function public.book_class(uuid, uuid) to authenticated;

-- Confirmations written before this change read "<slot> · <horse>"; keep the slot.
update public.notifications
set body = split_part(body, ' · ', 1)
where audience = 'user' and type = 'booking_confirmed' and body like '% · %';
