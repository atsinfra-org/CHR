-- 0035_platinum_weekly_limit.sql  (REVIEW: not applied. Apply in the Supabase SQL Editor; safe to run twice.)
--
-- Platinum members can hold 4 classes in a week (their recurring plan allowance), without raising the limit for
-- everyone. The weekly limit used by book_class, reschedule_booking and member_current_block_usage becomes:
--     greatest(system_settings.weekly_class_limit (3), membership_plans.recurring_slots_per_week of the member's plan)
-- Gold: max(3, 2) = 3 (unchanged).  Platinum: max(3, 4) = 4.  One-Time Ride: max(3, 0) = 3 (unchanged).
-- If the club later raises weekly_class_limit above a plan's allowance, the setting still wins.
-- Each function below is the exact production definition (read with pg_get_functiondef) with ONE line changed.
-- Nothing else (credits, capacity, windows, waitlist, notifications) is touched.
-- Rollback: 0035_platinum_weekly_limit.down.sql.

begin;

-- book_class: the only change is the v_block_limit line.
CREATE OR REPLACE FUNCTION public.book_class(p_session_id uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_block_limit := greatest(
    coalesce((select (value #>> '{}')::int from public.system_settings where key = 'weekly_class_limit'), 3),
    coalesce((select p.recurring_slots_per_week from public.membership_plans p where p.id = v_membership.plan_id), 0));
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
$function$
;

-- reschedule_booking: the only change is the v_block_limit line.
CREATE OR REPLACE FUNCTION public.reschedule_booking(p_booking_id uuid, p_new_session_id uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_block_limit := greatest(
    coalesce((select (value #>> '{}')::int from public.system_settings where key = 'weekly_class_limit'), 3),
    coalesce((select p.recurring_slots_per_week from public.membership_plans p where p.id = v_membership.plan_id), 0));
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
$function$
;

-- member_current_block_usage: the only change is the v_block_limit line.
CREATE OR REPLACE FUNCTION public.member_current_block_usage()
 RETURNS TABLE(membership_id uuid, current_block_start date, current_block_end date, block_class_limit integer, block_classes_used integer, block_classes_remaining integer)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
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
  if v_user_id is null then raise exception 'Not authenticated'; end if;

  select * into v_membership from public.memberships m
  where m.user_id = v_user_id and m.status = 'active' and m.end_date >= v_today_ist
  order by (m.credits_remaining > 0) desc, m.end_date asc
  limit 1;
  if not found or v_membership.start_date is null then return; end if;

  v_block_days := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'membership_block_days'), 7);
  v_block_limit := greatest(
    coalesce((select (value #>> '{}')::int from public.system_settings where key = 'weekly_class_limit'), 3),
    coalesce((select p.recurring_slots_per_week from public.membership_plans p where p.id = v_membership.plan_id), 0));
  v_block_index := (v_today_ist - v_membership.start_date) / v_block_days;
  v_block_start := v_membership.start_date + v_block_index * v_block_days;
  v_block_end := least(v_membership.start_date + v_block_index * v_block_days + (v_block_days - 1), v_membership.end_date);

  select count(*) into v_used
  from public.bookings b join public.class_sessions cs on cs.id = b.session_id
  where b.membership_id = v_membership.id
    and b.status in ('held', 'confirmed', 'completed', 'no_show')
    and (cs.session_date - v_membership.start_date) / v_block_days = v_block_index;

  return query select v_membership.id, v_block_start, v_block_end, v_block_limit, v_used, greatest(v_block_limit - v_used, 0);
end;
$function$
;

notify pgrst, 'reload schema';

commit;
