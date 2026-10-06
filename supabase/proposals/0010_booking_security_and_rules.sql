-- ============================================================================
-- Phase 4.5 — Riding Class Booking System.
-- Applied to production via Supabase MCP.
-- ============================================================================
-- AUDIT FINDINGS (live database, not assumed from files):
--
-- 1. cancel_booking() and generate_sessions() both still carry the same
--    stray `anon` EXECUTE grant footgun fixed for payment functions in
--    Phase 4.3/4.4 (Supabase's default-privilege auto-grant survives a
--    plain `revoke ... from public`). generate_sessions() additionally
--    still had `authenticated` too — it is a pure administrative/session-
--    generation operation with no legitimate member-facing use, so unlike
--    admin_adjust_credits() (which stays authenticated-granted because it
--    already self-checks is_staff_or_admin() and IS meant to be called by
--    staff sessions), generate_sessions() is revoked from authenticated
--    entirely per this phase's explicit instruction. It remains callable
--    only by postgres/service_role until Phase 4.6 builds a proper
--    staff-only calling path.
--
-- 2. book_class() had two real gaps, not just style issues:
--      a. It never checked the candidate session's date against the
--         member's own membership.end_date — a member with an active
--         membership today could book a session dated AFTER their
--         membership expires, as long as today is still within the
--         membership's validity window. Phase 4.5 §14 requires this
--         rejected; fixed below.
--      b. system_settings.booking_window_days (=30, already configured)
--         was never read or enforced anywhere. Fixed below.
--    Both fixes are additive checks inserted into the existing, otherwise
--    unchanged locking/logic structure — the row-lock ordering that
--    already makes concurrent booking/duplicate-detection safe (§9, §11)
--    is preserved exactly as-is.
--
-- 3. class_sessions_availability (Supabase advisory: "Security Definer
--    View") was reviewed, not blindly "fixed": it deliberately aggregates
--    booking counts across ALL members (LEFT JOIN bookings, no RLS
--    filtering) so the returned booked_count/available_slots are correct
--    totals for anyone browsing — if it were flipped to security_invoker
--    (RLS-scoped to the querying role), a member's or anon's count would
--    silently UNDER-count every other member's bookings, corrupting the
--    exact capacity numbers this booking system depends on for safety.
--    Its column list already exposes only aggregate numbers — no user_id,
--    booking id, or member identity ever appears in it. Verdict: the RLS
--    bypass is necessary and safe as scoped; documented via COMMENT ON
--    VIEW rather than changed.
-- ============================================================================

revoke execute on function public.cancel_booking(uuid, text) from anon;
revoke execute on function public.generate_sessions(date, date) from anon, authenticated;

comment on view public.class_sessions_availability is
  'Intentionally bypasses RLS on bookings to aggregate booked_count/available_slots across ALL members — reviewed in Phase 4.5. Exposes ONLY aggregate counts (no user_id/booking id/identity), and correctness of session-capacity numbers depends on this NOT being RLS-scoped to the querying role. Do not add security_invoker without re-deriving capacity another way first.';

-- ----------------------------------------------------------------------------
-- book_class() — same locking/logic structure as before, with the two gaps
-- above closed and error messages standardized to the structured vocabulary
-- (Phase 4.5 §41) now that a real frontend is about to call this for the
-- first time. No behavior removed — every existing check still applies.
-- ----------------------------------------------------------------------------
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
  if v_session.session_date < current_date
     or (v_session.session_date = current_date and v_session.start_time <= current_time) then
    raise exception 'INVALID_SESSION_DATE'
      using detail = 'This session has already started or passed.';
  end if;

  -- Booking window (§8): a general "how far ahead can anyone book" cap,
  -- independent of any specific membership. Absence of the setting means
  -- no window restriction, not an error.
  v_booking_window_days := (select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days');
  if v_booking_window_days is not null and v_session.session_date > current_date + v_booking_window_days then
    raise exception 'INVALID_SESSION_DATE'
      using detail = format('Bookings are only open up to %s days ahead.', v_booking_window_days);
  end if;

  select * into v_membership
  from public.memberships
  where user_id = v_user_id and status = 'active' and end_date >= current_date
  order by end_date desc
  limit 1
  for update;

  if not found then
    raise exception 'NO_ACTIVE_MEMBERSHIP';
  end if;

  -- §14: the session must fall within the membership's OWN validity, not
  -- just "is the membership active as of today". A membership active today
  -- but ending before the candidate session's date must not be usable to
  -- book that session.
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
    -- Defense-in-depth: uq_bookings_active_per_user_session catching what
    -- the row lock above already made practically impossible to reach.
    raise exception 'DUPLICATE_BOOKING';
  end;

  insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type, description)
  values (v_user_id, v_membership.id, v_booking.id, -1, 'booking', 'Class booked');

  return v_booking;
end;
$$;

revoke all on function public.book_class(uuid) from public, anon;
grant execute on function public.book_class(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- member_booking_eligibility() — the ONE authoritative source for the
-- booking page's date range / credits / block-usage display. Composes the
-- existing member_current_block_usage() (Phase 4.2) rather than
-- re-deriving block math a third time. SECURITY INVOKER (no elevated
-- privilege — relies on "Members read own memberships" RLS), matching the
-- eligible_membership_plan()/member_current_block_usage() pattern.
-- React performs no date-range or eligibility arithmetic of its own.
-- ----------------------------------------------------------------------------
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
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  v_booking_window_days := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days'), 30);

  select * into v_membership
  from public.memberships
  where user_id = v_user_id and status = 'active' and end_date >= current_date
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
    current_date,
    least(current_date + v_booking_window_days, v_membership.end_date),
    v_block.block_class_limit,
    v_block.block_classes_used,
    v_block.block_classes_remaining,
    v_block.current_block_start,
    v_block.current_block_end;
end;
$$;

revoke all on function public.member_booking_eligibility() from public, anon;
grant execute on function public.member_booking_eligibility() to authenticated;
