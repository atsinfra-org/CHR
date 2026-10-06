-- ============================================================================
-- Phase 4.2 correction — applied to production via Supabase MCP.
-- ============================================================================
-- The Phase 4.2 member dashboard originally re-derived the current
-- membership-block start/end dates and the weekly (per-block) class count
-- in React, mirroring book_class()'s own arithmetic. That is a duplicated
-- business rule sitting outside the database and was flagged for removal.
--
-- This migration:
--   1. Moves the two business constants book_class() had hardcoded (the
--      3-class-per-block cap and the 7-day block length) into
--      public.system_settings, alongside the other configurable booking
--      policies already stored there (cancellation_cutoff_hours,
--      default_session_capacity, etc.) — additive only, defaults preserve
--      today's exact behavior.
--   2. Redefines book_class() (CREATE OR REPLACE — the original
--      0004_riding_club_functions.sql is left untouched) to read those two
--      constants from system_settings instead of the literals 3 and 7, so
--      there is exactly one source of truth for the block definition.
--   3. Adds public.member_current_block_usage() — a read-only,
--      SECURITY INVOKER function (no elevated privilege; it can only ever
--      see what the caller's own RLS policies already allow) that computes
--      the caller's current block window and usage using the SAME
--      constants and the SAME arithmetic as book_class(). This is what the
--      dashboard now calls; React only formats the returned values.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Business constants, now configurable and shared — not hardcoded in
--    either book_class() or the dashboard.
-- ----------------------------------------------------------------------------
insert into public.system_settings (key, value, description)
values
  ('weekly_class_limit', '3'::jsonb, 'Max classes per fixed membership block. Read by book_class() and member_current_block_usage() — the single source of truth for this cap.'),
  ('membership_block_days', '7'::jsonb, 'Length in days of one fixed membership block, anchored to memberships.start_date. Read by book_class() and member_current_block_usage().')
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- 2) book_class() — identical to the version in 0004_riding_club_functions.sql
--    except v_week_count's cap and the block-day divisor now come from
--    system_settings (coalesced to the original literals only as a
--    fail-safe if those rows are ever deleted), rather than being literals.
--    No other behavior changes.
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
  -- Weekly cap (max v_block_limit bookings per v_block_days-day block):
  -- blocks are fixed, non-overlapping, and anchored to the membership's own
  -- start_date — NOT calendar Mon–Sun. Both constants now live in
  -- system_settings (see this migration's header) instead of being
  -- hardcoded here, so member_current_block_usage() can share them exactly.
  v_block_days int;
  v_block_limit int;
  v_week_index int;
  v_week_count int;
  v_next_eligible_date date;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_session from public.class_sessions where id = p_session_id for update;
  if not found then
    raise exception 'Session not found';
  end if;
  if v_session.status <> 'open' then
    raise exception 'Session is not open for booking';
  end if;
  if v_session.session_date < current_date
     or (v_session.session_date = current_date and v_session.start_time <= current_time) then
    raise exception 'Session has already started or passed';
  end if;

  select * into v_membership
  from public.memberships
  where user_id = v_user_id and status = 'active' and end_date >= current_date
  order by end_date desc
  limit 1
  for update;

  if not found then
    raise exception 'No active membership';
  end if;

  select coalesce(sum(amount), 0) into v_balance
  from public.credit_ledger
  where membership_id = v_membership.id;

  if v_balance <= 0 then
    raise exception 'No class credits remaining';
  end if;

  if exists (
    select 1 from public.bookings
    where user_id = v_user_id and session_id = p_session_id and status in ('held', 'confirmed')
  ) then
    raise exception 'Already booked for this session';
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
    raise exception 'Session is full';
  end if;

  insert into public.bookings (user_id, membership_id, session_id, status, booked_at)
  values (v_user_id, v_membership.id, p_session_id, 'confirmed', now())
  returning * into v_booking;

  insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type, description)
  values (v_user_id, v_membership.id, v_booking.id, -1, 'booking', 'Class booked');

  return v_booking;
end;
$$;

revoke all on function public.book_class(uuid) from public;
grant execute on function public.book_class(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 3) member_current_block_usage() — the dashboard's authoritative source
--    for current-block dates and usage. No SECURITY DEFINER: it runs with
--    the caller's own privileges, so it can only ever see what "Members
--    read own memberships" / "Members read own bookings" RLS already
--    permits for auth.uid(). Returns zero rows when the caller has no
--    currently-active membership — the dashboard already treats that as
--    its own empty state.
-- ----------------------------------------------------------------------------
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
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  -- Same membership selection as book_class(): the caller's own active,
  -- unexpired membership, most recent end_date first.
  select * into v_membership
  from public.memberships
  where user_id = v_user_id and status = 'active' and end_date >= current_date
  order by end_date desc
  limit 1;

  if not found or v_membership.start_date is null then
    return; -- no active membership — zero rows
  end if;

  v_block_days := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'membership_block_days'), 7);
  v_block_limit := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'weekly_class_limit'), 3);

  -- Identical formula to book_class()'s v_week_index, applied to today's
  -- date instead of a candidate session date — "which block is active
  -- right now," not a booking-eligibility decision.
  v_block_index := (current_date - v_membership.start_date) / v_block_days;
  v_block_start := v_membership.start_date + v_block_index * v_block_days;
  -- Clamp to membership.end_date: the tail block is shorter than
  -- v_block_days whenever validity_days isn't a multiple of it (e.g. a
  -- 30-day membership: 4 full 7-day blocks + a 2-day tail).
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

revoke all on function public.member_current_block_usage() from public;
grant execute on function public.member_current_block_usage() to authenticated;
