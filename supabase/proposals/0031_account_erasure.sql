-- ============================================================================
-- Account erasure: a guarded, auditable, retry-safe workflow. PROPOSAL: not applied anywhere by this file.
-- Requires 0030. One transaction; safe to run more than once.
-- ============================================================================
--
-- DESIGN (from the live schema, 2026-10-19)
--   * profiles.id → auth.users ON DELETE CASCADE, and memberships / wallet_ledger / referrals / referral_codes
--     cascade from the user too. A hard delete of a login would therefore try to remove the profile and, for a
--     member with no payments or bookings, SILENTLY DESTROY their membership and wallet records. Payments,
--     bookings, orders and credit_ledger have no cascade, so for most members it would instead fail.
--     Neither outcome is acceptable, so erasure here NEVER hard-deletes. It
--       1. removes what has no record-keeping value (phone-alert codes, waitlist, weekly schedules,
--          notifications, referral code),
--       2. blanks the identifying columns of the profile (the row stays, so every ledger keeps its link),
--       3. and the Edge Function account-erasure then disables the login (Supabase soft delete).
--   * Records that stay: payments, orders, memberships, credit and wallet ledgers, bookings, attendance,
--     staff audit entries, consent records, and the privacy request itself. They keep an id, not a name.
--
-- GUARDS (all must hold; none is bypassable from the app)
--   * privacy_config.erasure_finalisation_enabled = 'true'   (off by default: BUSINESS_DECISION_REQUIRED)
--   * privacy_config.erasure_hold_days elapsed, if set       (LEGAL_REVIEW_REQUIRED: the Rules' one-year minimum
--                                                             retention of processing logs, Rule 8(3), from 13 May 2027)
--   * an admin, on an erasure request that an admin has moved to "in progress"
--   * no blocker: no active membership, future booking, unpaid order or payment in flight, no wallet balance,
--     and the account is not staff/admin. The workflow never cancels, refunds or forfeits anything itself.
--
-- Nothing here refunds, cancels or changes any membership, booking, credit or payment.

begin;

alter table public.profiles add column if not exists erased_at timestamptz;

-- What stands in the way of closing this account (read-only).
create or replace function public._erasure_blockers(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_out jsonb := '[]'::jsonb;
  n int;
  v_amt numeric;
begin
  if exists (select 1 from public.profiles where id = p_user and role <> 'member') then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'privileged_account', 'detail', 'Staff and admin accounts are closed by the club administrator.'));
  end if;

  select count(*) into n from public.memberships where user_id = p_user and status = 'active' and end_date >= v_today;
  if n > 0 then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'active_membership', 'count', n,
      'detail', 'An active membership. Decide what happens to it and its remaining classes before closing the account.'));
  end if;

  select count(*) into n from public.bookings b join public.class_sessions cs on cs.id = b.session_id
    where b.user_id = p_user and b.status in ('held', 'confirmed') and (cs.session_date + cs.start_time) > (now() at time zone 'Asia/Kolkata');
  if n > 0 then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'future_bookings', 'count', n, 'detail', 'Upcoming booked classes.'));
  end if;

  select count(*) into n from public.orders where user_id = p_user and status = 'pending';
  if n > 0 then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'unpaid_orders', 'count', n, 'detail', 'An order that is not yet paid or cancelled.'));
  end if;

  select count(*) into n from public.payments where user_id = p_user and status in ('created', 'pending', 'processing');
  if n > 0 then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'payment_in_flight', 'count', n, 'detail', 'A payment that has not finished.'));
  end if;

  select coalesce(sum(amount), 0) into v_amt from public.wallet_ledger where user_id = p_user;
  if v_amt > 0 then
    v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'wallet_balance', 'detail', 'A referral wallet balance remains. Decide how it is treated first.'));
  end if;
  return v_out;
end $$;

-- Read-only report for the admin: what blocks, what would be removed, what stays. Logged.
create or replace function public.admin_erasure_preflight(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.privacy_requests;
  p public.profiles;
  v_blockers jsonb;
  v_enabled boolean := coalesce(public._privacy_cfg('erasure_finalisation_enabled'), 'false') = 'true';
  v_hold int := nullif(public._privacy_cfg('erasure_hold_days'), '')::int;
  v_hold_until timestamptz;
  v_open boolean;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  select * into r from public.privacy_requests where id = p_request_id;
  if not found or r.request_type <> 'erasure' then raise exception 'REQUEST_NOT_FOUND'; end if;
  select * into p from public.profiles where id = r.user_id;
  v_blockers := public._erasure_blockers(r.user_id);
  v_hold_until := case when v_hold is not null then r.submitted_at + make_interval(days => v_hold) end;
  v_open := r.status in ('submitted', 'in_progress', 'awaiting_requester');

  insert into public.privacy_request_events (request_id, actor_id, actor_role, event) values (r.id, auth.uid(), 'admin', 'erasure_preflight');
  perform public._audit('privacy_requests', r.id, 'ERASURE_PREFLIGHT', null, jsonb_build_object('blockers', jsonb_array_length(v_blockers)));

  return jsonb_build_object(
    'request_id', r.id, 'request_status', r.status, 'already_erased', p.erased_at is not null,
    'finalisation_enabled', v_enabled, 'hold_until', v_hold_until,
    'hold_elapsed', v_hold_until is null or now() >= v_hold_until,
    'blockers', v_blockers,
    'can_execute', v_open and v_enabled and p.erased_at is null and jsonb_array_length(v_blockers) = 0 and (v_hold_until is null or now() >= v_hold_until),
    'will_remove', jsonb_build_array('name, email, phone, date of birth, photo link on the profile', 'phone-alert codes', 'waitlist entries', 'weekly schedules', 'in-app notifications', 'referral code', 'the login (disabled)'),
    'will_keep', jsonb_build_object(
      'payments', (select count(*) from public.payments where user_id = r.user_id),
      'orders', (select count(*) from public.orders where user_id = r.user_id),
      'memberships', (select count(*) from public.memberships where user_id = r.user_id),
      'credit_ledger_rows', (select count(*) from public.credit_ledger where user_id = r.user_id),
      'bookings', (select count(*) from public.bookings where user_id = r.user_id),
      'consent_records', (select count(*) from public.consent_events where user_id = r.user_id)),
    'not_handled_here', jsonb_build_array(
      'Enquiries sent with this email address (' || (select count(*) from public.enquiries where p.email is not null and lower(email) = lower(p.email)) || ' found) are not linked to the account.',
      'Copies inside staff audit-log snapshots are kept by design.',
      'Data held by service providers (payments, email, phone alerts, sign-in) is outside this database.'));
end $$;

-- Step 1 (database). Idempotent and atomic: any failure rolls the whole step back; running it again is safe.
create or replace function public.admin_execute_erasure(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.privacy_requests;
  p public.profiles;
  v_hold int := nullif(public._privacy_cfg('erasure_hold_days'), '')::int;
  v_blockers jsonb;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if coalesce(public._privacy_cfg('erasure_finalisation_enabled'), 'false') <> 'true' then
    raise exception 'ERASURE_DISABLED' using detail = 'Account erasure is switched off until the club approves the rules for it.';
  end if;
  select * into r from public.privacy_requests where id = p_request_id for update;
  if not found or r.request_type <> 'erasure' then raise exception 'REQUEST_NOT_FOUND'; end if;
  if r.status <> 'in_progress' then raise exception 'REQUEST_NOT_IN_PROGRESS' using detail = 'Review the request and move it to "in progress" first.'; end if;
  select * into p from public.profiles where id = r.user_id for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;

  -- Already done (a retry after the login step failed): report, do nothing twice.
  if p.erased_at is not null then
    return jsonb_build_object('user_id', r.user_id, 'database_step', 'already_done');
  end if;

  if v_hold is not null and now() < r.submitted_at + make_interval(days => v_hold) then
    raise exception 'ERASURE_ON_HOLD' using detail = 'The waiting period for erasure has not passed yet.';
  end if;
  v_blockers := public._erasure_blockers(r.user_id);
  if jsonb_array_length(v_blockers) > 0 then
    raise exception 'ERASURE_BLOCKED' using detail = (select string_agg(b ->> 'code', ', ') from jsonb_array_elements(v_blockers) b);
  end if;

  -- What has no record-keeping value is deleted.
  delete from public.push_devices where user_id = r.user_id;            -- push_deliveries go with them
  delete from public.waitlist_entries where user_id = r.user_id;
  delete from public.recurring_occurrences where user_id = r.user_id;
  delete from public.recurring_schedules where user_id = r.user_id;      -- slots go with them
  delete from public.notifications where user_id = r.user_id;
  delete from public.referral_codes where user_id = r.user_id;

  -- The profile row stays (every ledger links to it); only the identifying columns are blanked.
  update public.profiles set full_name = 'Deleted member', phone = null, email = null, date_of_birth = null,
    avatar_url = null, status = 'suspended', erased_at = now() where id = r.user_id;

  insert into public.privacy_request_events (request_id, actor_id, actor_role, event) values (r.id, auth.uid(), 'admin', 'erasure_database_done');
  perform public._audit('profiles', r.user_id, 'ERASURE_DATABASE_DONE', null, jsonb_build_object('request_id', r.id));
  return jsonb_build_object('user_id', r.user_id, 'database_step', 'done');
end $$;

-- Step 2: after the login has been disabled (Edge Function), close the request. Never claims completion otherwise.
create or replace function public.admin_finish_erasure(p_request_id uuid, p_login_disabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.privacy_requests;
  p public.profiles;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  select * into r from public.privacy_requests where id = p_request_id for update;
  if not found or r.request_type <> 'erasure' then raise exception 'REQUEST_NOT_FOUND'; end if;
  select * into p from public.profiles where id = r.user_id;
  if p.erased_at is null then raise exception 'DATABASE_STEP_NOT_DONE'; end if;

  if p_login_disabled is not true then
    insert into public.privacy_request_events (request_id, actor_id, actor_role, event, note) values (r.id, auth.uid(), 'admin', 'erasure_login_step_failed', 'The login could not be disabled; run the step again.');
    perform public._audit('privacy_requests', r.id, 'ERASURE_LOGIN_STEP_FAILED', null, jsonb_build_object('request_id', r.id));
    return jsonb_build_object('completed', false, 'reason', 'login_step_failed');
  end if;
  if r.status = 'completed' then return jsonb_build_object('completed', true, 'already', true); end if;

  update public.privacy_requests set status = 'completed', resolved_at = now(), updated_at = now(),
    resolution_note = 'Account closed: identifying details removed and sign-in disabled. Records the club must keep were retained.' where id = r.id;
  insert into public.privacy_request_events (request_id, actor_id, actor_role, event, from_status, to_status) values (r.id, auth.uid(), 'admin', 'erasure_completed', r.status, 'completed');
  perform public._audit('privacy_requests', r.id, 'ERASURE_COMPLETED', null, jsonb_build_object('request_id', r.id));
  return jsonb_build_object('completed', true);
end $$;

revoke execute on function public._erasure_blockers(uuid) from public, anon, authenticated;
revoke execute on function public.admin_erasure_preflight(uuid), public.admin_execute_erasure(uuid), public.admin_finish_erasure(uuid, boolean) from public, anon;
grant execute on function public.admin_erasure_preflight(uuid), public.admin_execute_erasure(uuid), public.admin_finish_erasure(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';

commit;
