-- ============================================================================
-- Phase 4.3 — Membership Purchase (preparation, no Razorpay yet).
-- Applied to production via Supabase MCP.
-- ============================================================================
-- AUDIT FINDING (Step 2/3/15/29 of the Phase 4.3 brief) — CRITICAL:
--
-- information_schema.routine_privileges showed `anon` AND `authenticated`
-- both holding EXECUTE on every SECURITY DEFINER function added in
-- 0004_riding_club_functions.sql, including activate_membership() and
-- process_payment_webhook() — despite 0004's own comments explicitly
-- stating those two were "Intentionally NOT granted to anon/authenticated"
-- and "Not granted to anon/authenticated at all — only service_role".
--
-- Root cause: `revoke all on function ... from public;` does NOT undo
-- Supabase's project-level default privilege grant (new functions in the
-- public schema are auto-granted EXECUTE to anon/authenticated/service_role
-- unless explicitly revoked from those roles by name). This is a known
-- Supabase footgun, and it left three real, exploitable holes live in
-- production:
--   - activate_membership(p_membership_id, p_payment_id) has no internal
--     auth/ownership check at all — ANY authenticated (or even anonymous)
--     caller could activate ANY pending membership for free, granting
--     themselves (or anyone) 8 class credits with no payment.
--   - process_payment_webhook(...) has no internal check either — anyone
--     who can guess/observe a gateway_order_id could mark that payment
--     'success', which cascades into activate_membership().
--   - begin_membership_purchase(...) trusts a client-supplied p_amount
--     with no validation against membership_plans.price at all — exactly
--     the price-tampering hole Phase 4.3 §21 requires testing for.
--
-- Fixed below by explicitly revoking EXECUTE from anon/authenticated on all
-- three (they remain callable by postgres/service_role, e.g. a future
-- Phase 4.4 webhook Edge Function). None of this changes their behavior —
-- only who may invoke them, restoring 0004's own stated intent.
-- begin_membership_purchase() itself is intentionally left unmodified and
-- locked: its Razorpay-order-attachment redesign belongs to Phase 4.4, not
-- this phase. The same accidental-anon-grant footgun is also cleaned up on
-- book_class() and admin_adjust_credits() for hygiene (both are already
-- safe due to internal auth.uid()/is_staff_or_admin() checks, so this is a
-- surface-reduction fix, not a behavior change).
-- ============================================================================

revoke execute on function public.activate_membership(uuid, uuid) from anon, authenticated;
revoke execute on function public.process_payment_webhook(text, text, text, jsonb) from anon, authenticated;
revoke execute on function public.begin_membership_purchase(uuid, text, text, numeric, text) from anon, authenticated;
revoke execute on function public.admin_adjust_credits(uuid, int, text) from anon;
revoke execute on function public.book_class(uuid) from anon;

-- ============================================================================
-- Data-integrity backstop (Phase 4.3 §11): at most one ACTIVE and at most
-- one PENDING-PAYMENT membership per user, enforced at the constraint
-- level — not just by application check-then-insert logic, which is
-- race-prone under concurrent requests (double-click, retry, refresh).
-- Both tables are empty in production today, so this is safe to add
-- immediately with no data migration.
-- ============================================================================

create unique index uq_memberships_one_active_per_user
  on public.memberships (user_id)
  where status = 'active';

create unique index uq_memberships_one_pending_per_user
  on public.memberships (user_id)
  where status = 'pending_payment';

-- ============================================================================
-- initiate_membership_purchase — the ONLY membership-purchase entry point
-- Phase 4.3's frontend calls. Accepts nothing but a plan id (Phase 4.3 §3's
-- recommended architecture) — age, eligibility, price, credits, and
-- validity are all derived server-side from profiles.date_of_birth and
-- membership_plans. It does not create a Razorpay order and does not touch
-- credit_ledger (§12) — it only prepares the pending membership + pending
-- payment rows that Phase 4.4's gateway integration will pick up next.
-- ============================================================================
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
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  -- Age is read from the stored profile — never trusted from the client.
  -- Accurate date-based age (not "current year minus birth year"), matching
  -- the same formula already used by begin_membership_purchase().
  select date_of_birth into v_dob from public.profiles where id = v_user_id;
  if v_dob is null then
    raise exception 'DATE_OF_BIRTH_REQUIRED'
      using detail = 'Add your date of birth in your profile before purchasing a membership.';
  end if;
  if v_dob > current_date then
    raise exception 'INVALID_DATE_OF_BIRTH'
      using detail = 'Date of birth cannot be in the future.';
  end if;

  v_age := extract(year from age(current_date, v_dob));

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

  -- An unexpired active membership blocks a new purchase outright — no
  -- overlapping-membership policy is invented here; this simply mirrors
  -- what the Phase 4.2 dashboard already only ever offered "Book a Class"
  -- (never "Buy") for an active membership, and "Renew"/"View Plans" only
  -- once lapsed or absent.
  select * into v_existing_active
  from public.memberships
  where user_id = v_user_id and status = 'active' and end_date >= current_date
  order by end_date desc
  limit 1;

  if found then
    raise exception 'ACTIVE_MEMBERSHIP_EXISTS'
      using detail = format('You already have an active membership until %s.', to_char(v_existing_active.end_date, 'FMDD FMMonth YYYY'));
  end if;

  -- Idempotency (§10): a purchase already in flight is returned as-is, not
  -- duplicated — covers double-click, page refresh, and retried requests.
  select * into v_existing_pending
  from public.memberships
  where user_id = v_user_id and status = 'pending_payment'
  limit 1;

  if found then
    v_membership := v_existing_pending;
    v_is_new := false;
    -- Aliased (p.membership_id, p.created_at): the OUT parameter
    -- `membership_id` from this function's own RETURNS TABLE would
    -- otherwise be ambiguous against payments.membership_id here —
    -- caught during testing (Phase 4.3 §21/§24 verification).
    select * into v_payment from public.payments p where p.membership_id = v_membership.id order by p.created_at desc limit 1;
    select * into v_output_plan from public.membership_plans where id = v_membership.plan_id;
  else
    begin
      insert into public.memberships (user_id, plan_id, status)
      values (v_user_id, p_plan_id, 'pending_payment')
      returning * into v_membership;
    exception when unique_violation then
      -- Lost a race against a concurrent request for the same user —
      -- uq_memberships_one_pending_per_user fired. Fall back to the row
      -- the other request just created, same as the idempotent path above.
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

-- ============================================================================
-- eligible_membership_plan — read-only. Tells the frontend which plan
-- applies to the caller and at what price, computed server-side, so React
-- performs ZERO age/eligibility arithmetic even for display (Phase 4.3 §27
-- — "no business logic duplication", the same defect class corrected in
-- Phase 4.2 for the weekly-block calculation). No SECURITY DEFINER: runs
-- under the caller's own privileges, so it can only ever read the caller's
-- own profile ("Members read own profile" RLS) and the public active-plan
-- catalog ("Anyone reads active plans" RLS).
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
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select date_of_birth into v_dob from public.profiles where id = v_user_id;

  if v_dob is null then
    return query select null::int, true, false, null::uuid, null::text, null::text, null::numeric, null::text, null::int, null::int;
    return;
  end if;

  -- Same INVALID_DATE_OF_BIRTH condition initiate_membership_purchase()
  -- enforces — flagged here too (found missing during testing) so this
  -- read-only display function never computes a nonsensical age instead.
  if v_dob > current_date then
    return query select null::int, false, true, null::uuid, null::text, null::text, null::numeric, null::text, null::int, null::int;
    return;
  end if;

  v_age := extract(year from age(current_date, v_dob));

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
