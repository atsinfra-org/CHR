-- ============================================================================
-- Phase 4.5 — IST timezone correctness for booking-domain functions.
-- Applied to production via Supabase MCP.
-- ============================================================================
-- FINDING (live inspection — `show timezone` / `now()` on the live DB):
-- The project's Postgres session timezone is UTC (Supabase's default), but
-- schedule_templates' times (06:00, 07:00, 16:00, 17:00 — two morning, two
-- evening sessions) are wall-clock India times, per the project's own
-- stated operating context. book_class()'s "has this session already
-- started" check, and cancel_booking()'s cutoff-hours calculation, both
-- compared against bare current_date/current_time — i.e. UTC — meaning a
-- "6am" session was only treated as started once the UTC clock reached
-- 06:00 (11:30am IST), and cancellation cutoff math was off by the same
-- 5.5 hours. Phase 4.5 §15 explicitly requires this not be left mixed.
--
-- Fixed by deriving IST wall-clock date/time explicitly via
-- `now() AT TIME ZONE 'Asia/Kolkata'` wherever booking eligibility depends
-- on "today"/"now", rather than relying on the session's ambient
-- timezone. No stored data changes — this is a read-time interpretation
-- fix in the functions that decide booking eligibility.
--
-- Scope note: the same UTC-vs-IST pattern exists in Phase 4.3/4.4's
-- initiate_membership_purchase()/eligible_membership_plan()/
-- activate_membership() (age math, membership start/end dates) — those are
-- payment/membership-purchase domain, out of this booking-phase's scope,
-- and their real-world impact is far smaller (only the ~5.5 hour
-- midnight–5:30am IST window, when the club isn't operating anyway).
-- Flagged in the Phase 4.5 report as a follow-up, not fixed here.
-- ============================================================================

create or replace function public.book_class(p_session_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
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
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_session from public.class_sessions where id = p_session_id for update;
  if not found then
    raise exception 'SESSION_NOT_FOUND';
  end if;
  if v_session.status <> 'open' then
    raise exception 'SESSION_NOT_AVAILABLE'
      using detail = format('This session is %s and not open for booking.', v_session.status);
  end if;
  if v_session.session_date < v_now_ist_date
     or (v_session.session_date = v_now_ist_date and v_session.start_time <= v_now_ist_time) then
    raise exception 'INVALID_SESSION_DATE'
      using detail = 'This session has already started or passed.';
  end if;

  v_booking_window_days := (select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days');
  if v_booking_window_days is not null and v_session.session_date > v_now_ist_date + v_booking_window_days then
    raise exception 'INVALID_SESSION_DATE'
      using detail = format('Bookings are only open up to %s days ahead.', v_booking_window_days);
  end if;

  select * into v_membership
  from public.memberships
  where user_id = v_user_id and status = 'active' and end_date >= v_now_ist_date
  order by end_date desc
  limit 1
  for update;

  if not found then
    raise exception 'NO_ACTIVE_MEMBERSHIP';
  end if;

  if v_session.session_date > v_membership.end_date then
    raise exception 'MEMBERSHIP_EXPIRED'
      using detail = format(
        'Your membership ends on %s. This class falls after that date.',
        to_char(v_membership.end_date, 'FMDD FMMonth YYYY')
      );
  end if;

  select coalesce(sum(amount), 0) into v_balance
  from public.credit_ledger
  where membership_id = v_membership.id;

  if v_balance <= 0 then
    raise exception 'NO_CREDITS_REMAINING';
  end if;

  if exists (
    select 1 from public.bookings
    where user_id = v_user_id and session_id = p_session_id and status in ('held', 'confirmed')
  ) then
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
      using
        detail = format(
          'You have reached the maximum of %s classes for this %s-day period. You can book another class from %s.',
          v_block_limit,
          v_block_days,
          to_char(v_next_eligible_date, 'FMMonth FMDD, YYYY')
        ),
        hint = v_next_eligible_date::text;
  end if;

  select count(*) into v_booked_count
  from public.bookings
  where session_id = p_session_id and status in ('held', 'confirmed');

  if v_booked_count >= v_session.capacity then
    raise exception 'SESSION_FULL';
  end if;

  begin
    insert into public.bookings (user_id, membership_id, session_id, status, booked_at)
    values (v_user_id, v_membership.id, p_session_id, 'confirmed', now())
    returning * into v_booking;
  exception when unique_violation then
    raise exception 'DUPLICATE_BOOKING';
  end;

  insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type, description)
  values (v_user_id, v_membership.id, v_booking.id, -1, 'booking', 'Class booked');

  return v_booking;
end;
$$;

-- cancel_booking() — v_session_starts_at now correctly interprets
-- session_date + start_time as IST wall-clock, converted to the true UTC
-- instant, before comparing against now() for the cutoff-hours math.
create or replace function public.cancel_booking(p_booking_id uuid, p_reason text default null)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_booking public.bookings;
  v_session public.class_sessions;
  v_cutoff_hours int;
  v_session_starts_at timestamptz;
  v_is_staff boolean := public.is_staff_or_admin();
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'BOOKING_NOT_FOUND';
  end if;
  if v_booking.user_id <> v_user_id and not v_is_staff then
    raise exception 'Not authorized to cancel this booking';
  end if;
  if v_booking.status not in ('held', 'confirmed') then
    raise exception 'BOOKING_NOT_CANCELLABLE'
      using detail = format('This booking is already %s.', v_booking.status);
  end if;

  select * into v_session from public.class_sessions where id = v_booking.session_id;
  v_session_starts_at := (
    (v_session.session_date::text || ' ' || v_session.start_time::text)::timestamp at time zone 'Asia/Kolkata'
  );

  select (value #>> '{}')::int into v_cutoff_hours
  from public.system_settings where key = 'cancellation_cutoff_hours';

  update public.bookings
  set status = 'cancelled', cancelled_at = now(), cancellation_reason = p_reason
  where id = p_booking_id
  returning * into v_booking;

  if v_cutoff_hours is null or v_session_starts_at - now() >= make_interval(hours => v_cutoff_hours) then
    insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type, description)
    values (v_booking.user_id, v_booking.membership_id, v_booking.id, 1, 'cancellation', 'Cancelled — credit returned');
  end if;

  return v_booking;
end;
$$;

-- member_current_block_usage() (Phase 4.2) and member_booking_eligibility()
-- (Phase 4.5) — "today" for block/window purposes must agree with what
-- book_class() itself just started using, or the dashboard could display
-- a different block/date range than what booking actually enforces.
create or replace function public.member_current_block_usage()
returns table (
  membership_id uuid,
  current_block_start date,
  current_block_end date,
  block_class_limit int,
  block_classes_used int,
  block_classes_remaining int
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_membership public.memberships;
  v_block_days int;
  v_block_limit int;
  v_block_index int;
  v_block_start date;
  v_block_end date;
  v_used int;
  v_today_ist date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_membership
  from public.memberships
  where user_id = v_user_id and status = 'active' and end_date >= v_today_ist
  order by end_date desc
  limit 1;

  if not found or v_membership.start_date is null then
    return;
  end if;

  v_block_days := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'membership_block_days'), 7);
  v_block_limit := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'weekly_class_limit'), 3);

  v_block_index := (v_today_ist - v_membership.start_date) / v_block_days;
  v_block_start := v_membership.start_date + v_block_index * v_block_days;
  v_block_end := least(
    v_membership.start_date + v_block_index * v_block_days + (v_block_days - 1),
    v_membership.end_date
  );

  select count(*) into v_used
  from public.bookings b
  join public.class_sessions cs on cs.id = b.session_id
  where b.membership_id = v_membership.id
    and b.status in ('held', 'confirmed', 'completed', 'no_show')
    and (cs.session_date - v_membership.start_date) / v_block_days = v_block_index;

  return query select
    v_membership.id,
    v_block_start,
    v_block_end,
    v_block_limit,
    v_used,
    greatest(v_block_limit - v_used, 0);
end;
$$;

create or replace function public.member_booking_eligibility()
returns table (
  has_active_membership boolean,
  membership_id uuid,
  membership_start_date date,
  membership_end_date date,
  credits_remaining int,
  min_bookable_date date,
  max_bookable_date date,
  block_class_limit int,
  block_classes_used int,
  block_classes_remaining int,
  current_block_start date,
  current_block_end date
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_membership public.memberships;
  v_booking_window_days int;
  v_block record;
  v_today_ist date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  v_booking_window_days := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days'), 30);

  select * into v_membership
  from public.memberships
  where user_id = v_user_id and status = 'active' and end_date >= v_today_ist
  order by end_date desc
  limit 1;

  if not found then
    return query select
      false, null::uuid, null::date, null::date, null::int,
      null::date, null::date, null::int, null::int, null::int, null::date, null::date;
    return;
  end if;

  select * into v_block from public.member_current_block_usage();

  return query select
    true,
    v_membership.id,
    v_membership.start_date,
    v_membership.end_date,
    v_membership.credits_remaining,
    v_today_ist,
    least(v_today_ist + v_booking_window_days, v_membership.end_date),
    v_block.block_class_limit,
    v_block.block_classes_used,
    v_block.block_classes_remaining,
    v_block.current_block_start,
    v_block.current_block_end;
end;
$$;
