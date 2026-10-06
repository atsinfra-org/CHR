-- ============================================================================
-- PROPOSAL — NOT APPLIED. Part of Phase 2 of the database redesign.
-- Do not run this against the live project until explicitly approved.
-- ============================================================================
-- The RPCs the React app calls instead of writing to sensitive tables
-- directly. All SECURITY DEFINER functions here do their own auth.uid()
-- and role checks internally — they do not rely on the caller's RLS grants,
-- because they intentionally act with more privilege than RLS would allow
-- a plain client request.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- book_class — the critical anti-double-booking function.
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
  -- Weekly cap (max 3 bookings per 7-day block): blocks are fixed,
  -- non-overlapping, and anchored to the membership's own start_date —
  -- NOT calendar Mon–Sun — per the confirmed business rule. Block index 0
  -- is [start_date, start_date+6], block 1 is [start_date+7, start_date+13],
  -- and so on; the final block may be shorter than 7 days if validity_days
  -- isn't a multiple of 7 (30 days -> 4 full blocks + a 2-day tail), and
  -- still carries the same cap of 3.
  v_week_index int;
  v_week_count int;
  v_next_eligible_date date;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  -- Row lock: a concurrent call for the SAME session blocks here until this
  -- transaction commits or rolls back. This is the actual concurrency
  -- guarantee — everything below is just validation against consistent,
  -- locked-in-place data.
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

  -- Lock the membership too, so two simultaneous book_class calls against
  -- DIFFERENT sessions on the SAME membership can't both read "1 credit
  -- left" and both succeed.
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

  -- Weekly cap: at most 3 bookings within the fixed 7-day block that the
  -- candidate session's date falls into. Counts held/confirmed/completed/
  -- no_show — every outcome that actually consumed a slot for that week —
  -- but not cancelled/expired, which correctly free the slot back up.
  v_week_index := (v_session.session_date - v_membership.start_date) / 7;

  select count(*) into v_week_count
  from public.bookings b
  join public.class_sessions cs on cs.id = b.session_id
  where b.membership_id = v_membership.id
    and b.status in ('held', 'confirmed', 'completed', 'no_show')
    and (cs.session_date - v_membership.start_date) / 7 = v_week_index;

  if v_week_count >= 3 then
    v_next_eligible_date := v_membership.start_date + 7 * (v_week_index + 1);
    raise exception 'WEEKLY_LIMIT_REACHED'
      using
        detail = format(
          'You have reached the maximum of 3 classes for this 7-day period. You can book another class from %s.',
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
-- cancel_booking — refunds a credit only outside the configured cutoff.
-- ----------------------------------------------------------------------------
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
    raise exception 'Booking not found';
  end if;
  if v_booking.user_id <> v_user_id and not v_is_staff then
    raise exception 'Not authorized to cancel this booking';
  end if;
  if v_booking.status not in ('held', 'confirmed') then
    raise exception 'Booking cannot be cancelled from status %', v_booking.status;
  end if;

  select * into v_session from public.class_sessions where id = v_booking.session_id;
  v_session_starts_at := (v_session.session_date + v_session.start_time)::timestamptz;

  -- Policy is not finalized — no hardcoded fallback number here. Absence of
  -- this setting means "no cutoff policy configured yet," which resolves to
  -- the credit always being returned (member-favorable default) until an
  -- admin inserts a real value into system_settings. That one INSERT is the
  -- entire "add the policy later" step — no code change required here.
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

revoke all on function public.cancel_booking(uuid, text) from public;
grant execute on function public.cancel_booking(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- activate_membership — idempotent. Called after verified payment.
-- ----------------------------------------------------------------------------
create or replace function public.activate_membership(p_membership_id uuid, p_payment_id uuid default null)
returns public.memberships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_membership public.memberships;
  v_plan public.membership_plans;
begin
  select * into v_membership from public.memberships where id = p_membership_id for update;
  if not found then
    raise exception 'Membership not found';
  end if;

  -- Idempotency guard: only activate once, no matter how many times this
  -- is called (e.g. a retried webhook).
  if v_membership.status <> 'pending_payment' then
    return v_membership;
  end if;

  select * into v_plan from public.membership_plans where id = v_membership.plan_id;

  update public.memberships
  set status = 'active',
      start_date = current_date,
      -- Inclusive span: a 30-day membership starting Sep 10 ends Oct 9
      -- (30 days total), not Oct 10 — validity_days - 1, not + validity_days.
      end_date = current_date + (v_plan.validity_days - 1),
      payment_id = coalesce(p_payment_id, payment_id)
  where id = p_membership_id
  returning * into v_membership;

  insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description)
  values (v_membership.user_id, v_membership.id, v_plan.class_credits, 'membership_purchase', 'Membership activated: ' || v_plan.name);

  return v_membership;
end;
$$;

-- Intentionally NOT granted to anon/authenticated — called only from
-- process_payment_webhook() (service_role context) or by staff/admin tooling.
revoke all on function public.activate_membership(uuid, uuid) from public;

-- ----------------------------------------------------------------------------
-- begin_membership_purchase — the SQL half of create_payment_order.
-- The Edge Function calls the payment gateway's API first (needs the
-- gateway secret key, which must never reach the browser), THEN calls this
-- to record the pending membership + payment row against the gateway's
-- returned order id.
-- ----------------------------------------------------------------------------
create or replace function public.begin_membership_purchase(
  p_plan_id uuid,
  p_gateway text,
  p_gateway_order_id text,
  p_amount numeric,
  p_currency text default 'INR'
)
returns public.payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_plan public.membership_plans;
  v_dob date;
  v_age int;
  v_membership public.memberships;
  v_payment public.payments;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_plan from public.membership_plans where id = p_plan_id and is_active;
  if not found then
    raise exception 'Plan not found or inactive';
  end if;

  -- Age is read from the stored profile, never trusted from the client —
  -- this is what actually decides which price applies, not whichever plan
  -- id the frontend happened to send.
  select date_of_birth into v_dob from public.profiles where id = v_user_id;
  if v_dob is null then
    raise exception 'DATE_OF_BIRTH_REQUIRED' using detail = 'Add your date of birth before purchasing a membership.';
  end if;

  v_age := extract(year from age(current_date, v_dob));
  if (v_plan.min_age is not null and v_age < v_plan.min_age)
     or (v_plan.max_age is not null and v_age > v_plan.max_age) then
    raise exception 'PLAN_AGE_INELIGIBLE'
      using detail = format('This plan is not available for age %s.', v_age);
  end if;

  insert into public.memberships (user_id, plan_id, status)
  values (v_user_id, p_plan_id, 'pending_payment')
  returning * into v_membership;

  insert into public.payments (user_id, membership_id, gateway, gateway_order_id, amount, currency, status)
  values (v_user_id, v_membership.id, p_gateway, p_gateway_order_id, p_amount, p_currency, 'created')
  returning * into v_payment;

  return v_payment;
end;
$$;

revoke all on function public.begin_membership_purchase(uuid, text, text, numeric, text) from public;
grant execute on function public.begin_membership_purchase(uuid, text, text, numeric, text) to authenticated;

-- ----------------------------------------------------------------------------
-- process_payment_webhook — service_role only. Idempotent.
-- The Edge Function verifies the gateway's webhook signature BEFORE calling
-- this — this function trusts its caller because only service_role (never
-- exposed to the browser) can invoke it.
-- ----------------------------------------------------------------------------
create or replace function public.process_payment_webhook(
  p_gateway_order_id text,
  p_gateway_payment_id text,
  p_status text,
  p_metadata jsonb default '{}'::jsonb
)
returns public.payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments;
begin
  select * into v_payment from public.payments where gateway_order_id = p_gateway_order_id for update;
  if not found then
    raise exception 'Unknown gateway_order_id: %', p_gateway_order_id;
  end if;

  -- Idempotent no-op on a retried webhook for an already-processed payment.
  if v_payment.status = 'success' and v_payment.gateway_payment_id = p_gateway_payment_id then
    return v_payment;
  end if;

  update public.payments
  set gateway_payment_id = p_gateway_payment_id,
      status = p_status,
      paid_at = case when p_status = 'success' then now() else paid_at end,
      metadata = metadata || p_metadata
  where id = v_payment.id
  returning * into v_payment;

  if p_status = 'success' then
    perform public.activate_membership(v_payment.membership_id, v_payment.id);
  end if;

  return v_payment;
end;
$$;

-- Not granted to anon/authenticated at all — only service_role, which
-- bypasses RLS/grants by default in Supabase.
revoke all on function public.process_payment_webhook(text, text, text, jsonb) from public;

-- ----------------------------------------------------------------------------
-- admin_adjust_credits — manual credit correction, always attributed.
-- ----------------------------------------------------------------------------
create or replace function public.admin_adjust_credits(p_membership_id uuid, p_amount int, p_reason text)
returns public.credit_ledger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.credit_ledger;
  v_user_id uuid;
begin
  if not public.is_staff_or_admin() then
    raise exception 'Not authorized';
  end if;
  if p_amount = 0 then
    raise exception 'Adjustment amount must be non-zero';
  end if;

  select user_id into v_user_id from public.memberships where id = p_membership_id;
  if v_user_id is null then
    raise exception 'Membership not found';
  end if;

  insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description, created_by)
  values (v_user_id, p_membership_id, p_amount, 'admin_adjustment', p_reason, auth.uid())
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_adjust_credits(uuid, int, text) from public;
grant execute on function public.admin_adjust_credits(uuid, int, text) to authenticated;
-- (function checks is_staff_or_admin() itself; granting execute broadly to
-- `authenticated` and enforcing the real check inside is the standard
-- Supabase pattern for role-gated RPCs.)

-- ----------------------------------------------------------------------------
-- generate_sessions — expands schedule_templates into class_sessions for a
-- date range. Idempotent via the uq_session_slot unique constraint.
-- ----------------------------------------------------------------------------
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

  -- Scalar subquery, not SELECT INTO: if system_settings has no row for this
  -- key (e.g. the policy hasn't been configured yet), a SELECT INTO from a
  -- zero-row result leaves the variable untouched (NULL) and — critically —
  -- never even evaluates a fallback expression placed inside its select
  -- list. A scalar subquery correctly evaluates to NULL on zero rows instead,
  -- so coalesce()'s second branch (live horse count) actually runs.
  v_default_capacity := coalesce(
    (select (value #>> '{}')::int from public.system_settings where key = 'default_session_capacity'),
    (select count(*) from public.horses where is_active and status = 'available')
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

revoke all on function public.generate_sessions(date, date) from public;
grant execute on function public.generate_sessions(date, date) to authenticated;

-- ----------------------------------------------------------------------------
-- available_sessions — thin read wrapper around class_sessions_availability.
-- ----------------------------------------------------------------------------
create or replace function public.available_sessions(p_date date)
returns setof public.class_sessions_availability
language sql
stable
set search_path = public
as $$
  select * from public.class_sessions_availability where session_date = p_date order by start_time;
$$;

grant execute on function public.available_sessions(date) to anon, authenticated;
