-- ============================================================================
-- Phase 4.5 hardening — IST timezone correctness for the membership /
-- purchase / activation domain. Applied to production via Supabase MCP.
-- ============================================================================
-- Companion to 0011 (which fixed the booking domain). Live inspection
-- (`show timezone` = UTC; scan of pg_proc.prosrc) confirmed exactly three
-- functions still interpret business dates in UTC:
--
--   eligible_membership_plan()      — future-DOB check + age()
--   initiate_membership_purchase()  — future-DOB check + age() + "is there
--                                     a currently-active membership" check
--   activate_membership()           — membership start_date / end_date
--
-- Each is redefined here to derive one IST business date up front —
--   v_today_ist := (now() at time zone 'Asia/Kolkata')::date
-- — and use it wherever "today, in the Indian calendar" is meant. This is
-- the identical pattern 0011 applied to book_class() et al., so the whole
-- app now shares one business-date interpretation.
--
-- Deliberately NOT changed:
--   * age() itself — still `extract(year from age(<ist date>, dob))`, i.e.
--     calendar-accurate completed years, never `year - year`.
--   * end_date arithmetic — still `start + (validity_days - 1)` = inclusive
--     30 calendar dates (Sep 10 -> Oct 9), not 30 elapsed 24h periods.
--   * every timestamptz instant (payments.paid_at / .created_at,
--     payment_webhook_events, audit_logs, credit_ledger.created_at,
--     updated_at) — those are true instants set via now() and are correct
--     as-is. None are touched.
--   * begin_membership_purchase() — also uses current_date, but it is the
--     Phase-4.3-superseded, anon/authenticated-revoked, uncallable legacy
--     function (Phase 4.4 stop condition: do not re-enable it). Out of this
--     correction's named scope; flagged in the report, not modified.
--
-- Grants are re-asserted after every CREATE OR REPLACE — Supabase's
-- default-privilege auto-grant re-fires on redefinition, not just on
-- initial creation (confirmed the hard way in Phase 4.5).
-- ============================================================================

create or replace function public.eligible_membership_plan()
returns table (
  age int,
  dob_missing boolean,
  dob_invalid boolean,
  plan_id uuid,
  plan_name text,
  plan_description text,
  amount numeric,
  currency text,
  class_credits int,
  validity_days int
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_dob date;
  v_age int;
  v_plan public.membership_plans;
  v_today_ist date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select date_of_birth into v_dob from public.profiles where id = v_user_id;

  if v_dob is null then
    return query select null::int, true, false, null::uuid, null::text, null::text, null::numeric, null::text, null::int, null::int;
    return;
  end if;

  if v_dob > v_today_ist then
    return query select null::int, false, true, null::uuid, null::text, null::text, null::numeric, null::text, null::int, null::int;
    return;
  end if;

  v_age := extract(year from age(v_today_ist, v_dob));

  select * into v_plan
  from public.membership_plans
  where is_active
    and (min_age is null or v_age >= min_age)
    and (max_age is null or v_age <= max_age)
  order by coalesce(min_age, 0) desc
  limit 1;

  if not found then
    return query select v_age, false, false, null::uuid, null::text, null::text, null::numeric, null::text, null::int, null::int;
    return;
  end if;

  return query select v_age, false, false, v_plan.id, v_plan.name, v_plan.description, v_plan.price, v_plan.currency, v_plan.class_credits, v_plan.validity_days;
end;
$$;

revoke all on function public.eligible_membership_plan() from public, anon;
grant execute on function public.eligible_membership_plan() to authenticated;

-- ----------------------------------------------------------------------------

create or replace function public.initiate_membership_purchase(p_plan_id uuid)
returns table (
  membership_id uuid,
  payment_id uuid,
  plan_id uuid,
  plan_name text,
  amount numeric,
  currency text,
  class_credits int,
  validity_days int,
  membership_status text,
  payment_status text,
  is_new_purchase boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_dob date;
  v_age int;
  v_plan public.membership_plans;
  v_output_plan public.membership_plans;
  v_existing_active public.memberships;
  v_existing_pending public.memberships;
  v_membership public.memberships;
  v_payment public.payments;
  v_is_new boolean := true;
  v_today_ist date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select date_of_birth into v_dob from public.profiles where id = v_user_id;
  if v_dob is null then
    raise exception 'DATE_OF_BIRTH_REQUIRED'
      using detail = 'Add your date of birth in your profile before purchasing a membership.';
  end if;
  if v_dob > v_today_ist then
    raise exception 'INVALID_DATE_OF_BIRTH'
      using detail = 'Date of birth cannot be in the future.';
  end if;

  v_age := extract(year from age(v_today_ist, v_dob));

  select * into v_plan from public.membership_plans where id = p_plan_id and is_active;
  if not found then
    raise exception 'PLAN_NOT_FOUND'
      using detail = 'This membership plan is not available.';
  end if;

  if (v_plan.min_age is not null and v_age < v_plan.min_age)
     or (v_plan.max_age is not null and v_age > v_plan.max_age) then
    raise exception 'PLAN_AGE_INELIGIBLE'
      using detail = format('This plan is not available for your age (%s).', v_age);
  end if;

  select * into v_existing_active
  from public.memberships m
  where m.user_id = v_user_id and m.status = 'active' and m.end_date >= v_today_ist
  order by m.end_date desc
  limit 1;

  if found then
    raise exception 'ACTIVE_MEMBERSHIP_EXISTS'
      using detail = format('You already have an active membership until %s.', to_char(v_existing_active.end_date, 'FMDD FMMonth YYYY'));
  end if;

  select * into v_existing_pending
  from public.memberships m
  where m.user_id = v_user_id and m.status = 'pending_payment'
  limit 1;

  if found then
    v_membership := v_existing_pending;
    v_is_new := false;
    select * into v_payment from public.payments p where p.membership_id = v_membership.id order by p.created_at desc limit 1;
    select * into v_output_plan from public.membership_plans where id = v_membership.plan_id;
  else
    begin
      insert into public.memberships (user_id, plan_id, status)
      values (v_user_id, p_plan_id, 'pending_payment')
      returning * into v_membership;
    exception when unique_violation then
      select * into v_membership from public.memberships m
      where m.user_id = v_user_id and m.status = 'pending_payment' limit 1;
      v_is_new := false;
    end;

    if v_is_new then
      insert into public.payments (user_id, membership_id, gateway, amount, currency, status)
      values (v_user_id, v_membership.id, 'razorpay', v_plan.price, v_plan.currency, 'created')
      returning * into v_payment;
      v_output_plan := v_plan;
    else
      select * into v_payment from public.payments p where p.membership_id = v_membership.id order by p.created_at desc limit 1;
      select * into v_output_plan from public.membership_plans where id = v_membership.plan_id;
    end if;
  end if;

  return query select
    v_membership.id,
    v_payment.id,
    v_output_plan.id,
    v_output_plan.name,
    v_payment.amount,
    v_payment.currency,
    v_output_plan.class_credits,
    v_output_plan.validity_days,
    v_membership.status,
    v_payment.status,
    v_is_new;
end;
$$;

revoke all on function public.initiate_membership_purchase(uuid) from public, anon;
grant execute on function public.initiate_membership_purchase(uuid) to authenticated;

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
  v_today_ist date := (now() at time zone 'Asia/Kolkata')::date;
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
      -- The Indian calendar date of activation (activation at 00:15 IST is
      -- day D, not D-1 as bare current_date/UTC would give).
      start_date = v_today_ist,
      -- Inclusive span: a 30-day membership starting Sep 10 ends Oct 9
      -- (30 dates total), not Oct 10 — validity_days - 1, not + validity_days.
      end_date = v_today_ist + (v_plan.validity_days - 1),
      payment_id = coalesce(p_payment_id, payment_id)
  where id = p_membership_id
  returning * into v_membership;

  insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description)
  values (v_membership.user_id, v_membership.id, v_plan.class_credits, 'membership_purchase', 'Membership activated: ' || v_plan.name);

  return v_membership;
end;
$$;

-- Phase 4.4 lockdown preserved: only service_role / postgres (the webhook +
-- verify Edge Functions) may call this — never anon or authenticated.
revoke all on function public.activate_membership(uuid, uuid) from public, anon, authenticated;
