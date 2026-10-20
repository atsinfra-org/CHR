-- Phase 15 test: guarded account erasure (0031). Apply 0028–0031 first.
-- One transaction, ends in ROLLBACK. Uses isolated test users only (@example.invalid) — never run the
-- erasure workflow on real members to "try it". Prints "ALL PHASE 15 CHECKS PASSED" on success.

begin;

create function pg_temp.q_as(p_uid uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute p_sql into v;
  exception when others then
    execute 'reset role';
    return 'ERR:' || sqlerrm;
  end;
  execute 'reset role';
  return v;
end $$;

create function pg_temp.must(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL: %', p_msg; end if; end $$;

create function pg_temp.must_err(p_result text, p_code text, p_msg text) returns void language plpgsql as $$
begin
  if p_result is null or p_result not like ('ERR:' || p_code || '%') then
    raise exception 'FAIL: % (expected %, got %)', p_msg, p_code, coalesce(p_result, 'NULL');
  end if;
end $$;

do $$
declare
  m uuid := gen_random_uuid();     -- member with blockers (active membership, future booking)
  m2 uuid := gen_random_uuid();    -- clean member
  m3 uuid := gen_random_uuid();    -- someone else
  s uuid := gen_random_uuid(); adm uuid := gen_random_uuid();
  v text; v_plan uuid; v_mem uuid; v_mem2 uuid; v_sess uuid; v_past uuid; v_book uuid;
  r1 uuid; r2 uuid; r3 uuid; j jsonb;
  c_pay bigint; c_ord bigint; c_mem bigint; c_led bigint; c_book bigint; c_att bigint; c_consent bigint;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select u, 'p15-' || left(u::text, 8) || '@example.invalid', '{"full_name":"Erase Test"}', 'authenticated', 'authenticated'
  from unnest(array[m, m2, m3, s, adm]) u;
  alter table public.profiles disable trigger trg_prevent_privilege_escalation;
  update public.profiles set role = 'staff' where id = s;
  update public.profiles set role = 'admin' where id = adm;
  update public.profiles set phone = '9000000001', date_of_birth = '1990-01-01' where id in (m, m2);
  alter table public.profiles enable trigger trg_prevent_privilege_escalation;

  select id into v_plan from public.membership_plans where plan_code = 'GOLD';
  select id into v_sess from public.class_sessions where session_date > current_date and status = 'open' order by session_date limit 1;
  insert into public.class_sessions (session_date, start_time, end_time, capacity, status) values (current_date - 40, '06:00', '07:00', 3, 'completed') returning id into v_past;

  -- M: an active membership and a future booking (both are blockers), plus data that erasure removes.
  insert into public.memberships (user_id, plan_id, status, start_date, end_date, total_credits, reschedules_allowed, reschedules_used)
    values (m, v_plan, 'active', current_date, current_date + 29, 8, 2, 0) returning id into v_mem;
  insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description) values (m, v_mem, 8, 'membership_purchase', 'test');
  insert into public.bookings (user_id, membership_id, session_id, status) values (m, v_mem, v_sess, 'confirmed');

  -- M2: everything finished, so nothing blocks; has data to remove AND records that must stay.
  insert into public.memberships (user_id, plan_id, status, start_date, end_date, total_credits, reschedules_allowed, reschedules_used)
    values (m2, v_plan, 'expired', current_date - 80, current_date - 51, 8, 2, 0) returning id into v_mem2;
  insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description) values (m2, v_mem2, 8, 'membership_purchase', 'test'), (m2, v_mem2, -8, 'expiry', 'test');
  insert into public.bookings (user_id, membership_id, session_id, status) values (m2, v_mem2, v_past, 'completed') returning id into v_book;
  insert into public.attendance (booking_id, status, marked_by) values (v_book, 'present', adm);
  insert into public.payments (user_id, membership_id, gateway, gateway_order_id, gateway_payment_id, amount, currency, status, paid_at)
    values (m2, v_mem2, 'razorpay', 'order_p15', 'pay_p15', 15000, 'INR', 'success', now() - interval '60 days');
  insert into public.orders (user_id, status, total_amount) values (m2, 'paid', 500);
  insert into public.push_devices (user_id, token, platform) values (m2, 'ExponentPushToken[p15-' || left(m2::text, 8) || ']', 'android');
  insert into public.notifications (audience, user_id, type, title) values ('user', m2, 'test', 'hello');
  insert into public.referral_codes (user_id, code) values (m2, 'P15' || left(m2::text, 6));
  insert into public.waitlist_entries (session_id, user_id) values (v_sess, m2);
  insert into public.recurring_schedules (user_id, membership_id, status) values (m2, v_mem2, 'ended');
  insert into public.consent_events (user_id, purpose, action, notice_version) values (m2, 'push_notifications', 'withdrawn', null);
  update public.profiles set avatar_url = 'https://example.invalid/a.png' where id = m2;

  -- ── Requests: members can only ever ask for their own account ─────────────
  v := pg_temp.q_as(m, $q$select (public.submit_privacy_request('erasure')).id::text$q$);   r1 := v::uuid;
  v := pg_temp.q_as(m2, $q$select (public.submit_privacy_request('erasure')).id::text$q$);  r2 := v::uuid;
  perform pg_temp.must(r1 is not null and r2 is not null and r1 <> r2, 'each member can file their own erasure request');
  perform pg_temp.must((select user_id from public.privacy_requests where id = r2) = m2, 'the request belongs to the caller');
  perform pg_temp.must(pg_temp.q_as(m3, $q$select count(*)::text from public.privacy_requests$q$) = '0', 'another member cannot see these requests');
  perform pg_temp.must_err(pg_temp.q_as(s, $q$select (public.submit_privacy_request('erasure'))::text$q$), 'PRIVILEGED_ACCOUNT', 'staff erasure request');

  -- ── Only an admin may run any part of it ──────────────────────────────────
  foreach v in array array['admin_erasure_preflight', 'admin_execute_erasure'] loop
    perform pg_temp.must_err(pg_temp.q_as(m2, format('select public.%I(%L)::text', v, r2)), 'NOT_AUTHORIZED', 'member calling ' || v);
    perform pg_temp.must_err(pg_temp.q_as(s, format('select public.%I(%L)::text', v, r2)), 'NOT_AUTHORIZED', 'staff calling ' || v);
  end loop;
  perform pg_temp.must_err(pg_temp.q_as(m2, format('select public.admin_finish_erasure(%L, true)::text', r2)), 'NOT_AUTHORIZED', 'member finishing an erasure');
  perform pg_temp.must_err(pg_temp.q_as(s, format('select public.admin_finish_erasure(%L, true)::text', r2)), 'NOT_AUTHORIZED', 'staff finishing an erasure');

  -- ── Preflight is read-only and tells the truth ────────────────────────────
  j := pg_temp.q_as(adm, format('select public.admin_erasure_preflight(%L)::text', r1))::jsonb;
  perform pg_temp.must(j -> 'blockers' @> '[{"code":"active_membership"}]'::jsonb and j -> 'blockers' @> '[{"code":"future_bookings"}]'::jsonb, 'blockers name the active membership and the future booking');
  perform pg_temp.must((j ->> 'can_execute')::boolean = false and (j ->> 'finalisation_enabled')::boolean = false, 'cannot execute: blocked and switched off');
  j := pg_temp.q_as(adm, format('select public.admin_erasure_preflight(%L)::text', r2))::jsonb;
  perform pg_temp.must(jsonb_array_length(j -> 'blockers') = 0 and (j ->> 'can_execute')::boolean = false, 'a clean member still cannot be erased while the switch is off');
  perform pg_temp.must((j -> 'will_keep' ->> 'payments')::int = 1 and (j -> 'will_keep' ->> 'bookings')::int = 1, 'the report says what will be kept');

  -- ── The guards, in order ──────────────────────────────────────────────────
  perform pg_temp.must_err(pg_temp.q_as(adm, format('select public.admin_execute_erasure(%L)::text', r2)), 'ERASURE_DISABLED', 'running erasure while it is switched off');
  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('erasure_finalisation_enabled', 'true')::text$q$);
  perform pg_temp.must_err(pg_temp.q_as(adm, format('select public.admin_execute_erasure(%L)::text', r2)), 'REQUEST_NOT_IN_PROGRESS', 'erasing without reviewing the request first');
  perform pg_temp.q_as(adm, format($q$select (public.admin_update_privacy_request(%L, 'in_progress', null, 'Reviewed'))::text$q$, r1));
  perform pg_temp.q_as(adm, format($q$select (public.admin_update_privacy_request(%L, 'in_progress', null, 'Reviewed'))::text$q$, r2));
  -- 0032: a destructive step needs the requester's identity checked first (see phase16 for the refusal itself).
  perform pg_temp.q_as(adm, format($q$select public.admin_verify_requester_identity(%L, 'phone_callback', 'Called back on the number on file')::text$q$, r1));
  perform pg_temp.q_as(adm, format($q$select public.admin_verify_requester_identity(%L, 'phone_callback', 'Called back on the number on file')::text$q$, r2));
  v := pg_temp.q_as(adm, format('select public.admin_execute_erasure(%L)::text', r1));
  perform pg_temp.must_err(v, 'ERASURE_BLOCKED', 'a member with an active membership and future booking');
  perform pg_temp.must((select full_name from public.profiles where id = m) = 'Erase Test' and (select erased_at is null from public.profiles where id = m), 'a blocked erasure changed nothing');

  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('erasure_hold_days', '30')::text$q$);
  perform pg_temp.must_err(pg_temp.q_as(adm, format('select public.admin_execute_erasure(%L)::text', r2)), 'ERASURE_ON_HOLD', 'erasing during the waiting period');
  perform pg_temp.must((pg_temp.q_as(adm, format('select public.admin_erasure_preflight(%L)::text', r2))::jsonb ->> 'hold_elapsed')::boolean = false, 'preflight shows the hold');
  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('erasure_hold_days', null)::text$q$);

  -- other blockers
  insert into public.wallet_ledger (user_id, amount, kind) values (m2, 100, 'referral_reward');
  perform pg_temp.must(pg_temp.q_as(adm, format('select public.admin_erasure_preflight(%L)::text', r2))::jsonb -> 'blockers' @> '[{"code":"wallet_balance"}]'::jsonb, 'a wallet balance blocks');
  perform pg_temp.must_err(pg_temp.q_as(adm, format('select public.admin_execute_erasure(%L)::text', r2)), 'ERASURE_BLOCKED', 'erasing with a wallet balance');
  delete from public.wallet_ledger where user_id = m2;
  insert into public.orders (user_id, status, total_amount) values (m2, 'pending', 10);
  perform pg_temp.must(pg_temp.q_as(adm, format('select public.admin_erasure_preflight(%L)::text', r2))::jsonb -> 'blockers' @> '[{"code":"unpaid_orders"}]'::jsonb, 'an unpaid order blocks');
  delete from public.orders where user_id = m2 and status = 'pending';
  insert into public.privacy_requests (user_id, request_type, status, identity_verified_at, identity_verified_by, identity_method) values (s, 'erasure', 'in_progress', now(), adm, 'in_person') returning id into r3;
  perform pg_temp.must(pg_temp.q_as(adm, format('select public.admin_erasure_preflight(%L)::text', r3))::jsonb -> 'blockers' @> '[{"code":"privileged_account"}]'::jsonb, 'a staff account is blocked');
  perform pg_temp.must_err(pg_temp.q_as(adm, format('select public.admin_execute_erasure(%L)::text', r3)), 'ERASURE_BLOCKED', 'erasing a staff account');

  -- ── The erasure itself ────────────────────────────────────────────────────
  select count(*) into c_pay from public.payments where user_id = m2;
  select count(*) into c_ord from public.orders where user_id = m2;
  select count(*) into c_mem from public.memberships where user_id = m2;
  select count(*) into c_led from public.credit_ledger where user_id = m2;
  select count(*) into c_book from public.bookings where user_id = m2;
  select count(*) into c_att from public.attendance where booking_id = v_book;
  select count(*) into c_consent from public.consent_events where user_id = m2;

  v := pg_temp.q_as(adm, format('select public.admin_execute_erasure(%L)::text', r2));
  perform pg_temp.must(v like '%"database_step": "done"%', 'the database step runs: ' || v);

  perform pg_temp.must((select full_name = 'Deleted member' and phone is null and email is null and date_of_birth is null and avatar_url is null and status = 'suspended' and erased_at is not null from public.profiles where id = m2), 'the profile is blanked and marked');
  perform pg_temp.must(exists (select 1 from public.profiles where id = m2), 'the profile row stays, so every ledger keeps its link');
  perform pg_temp.must(not exists (select 1 from public.push_devices where user_id = m2) and not exists (select 1 from public.notifications where user_id = m2)
    and not exists (select 1 from public.referral_codes where user_id = m2) and not exists (select 1 from public.waitlist_entries where user_id = m2)
    and not exists (select 1 from public.recurring_schedules where user_id = m2), 'phone codes, notifications, referral code, waitlist and schedules are gone');
  perform pg_temp.must((select count(*) from public.payments where user_id = m2) = c_pay and (select count(*) from public.orders where user_id = m2) = c_ord
    and (select count(*) from public.memberships where user_id = m2) = c_mem and (select count(*) from public.credit_ledger where user_id = m2) = c_led
    and (select count(*) from public.bookings where user_id = m2) = c_book and (select count(*) from public.attendance where booking_id = v_book) = c_att
    and (select count(*) from public.consent_events where user_id = m2) = c_consent, 'payments, orders, memberships, ledgers, bookings, attendance and consent records are all kept');
  perform pg_temp.must((select amount from public.payments where user_id = m2) = 15000 and (select gateway_payment_id from public.payments where user_id = m2) = 'pay_p15', 'a payment record is untouched');
  perform pg_temp.must((select request_type = 'erasure' and status = 'in_progress' from public.privacy_requests where id = r2), 'the request is NOT marked complete until the login step is done');

  -- The other member, and the blocked one, are untouched.
  perform pg_temp.must((select full_name = 'Erase Test' and phone = '9000000001' from public.profiles where id = m), 'another member is untouched');
  perform pg_temp.must(exists (select 1 from public.bookings where user_id = m and status = 'confirmed'), 'a blocked member''s booking is untouched');

  -- ── Retry safety and honest completion ───────────────────────────────────
  v := pg_temp.q_as(adm, format('select public.admin_execute_erasure(%L)::text', r2));
  perform pg_temp.must(v like '%already_done%', 'running the database step again changes nothing: ' || v);
  perform pg_temp.must_err(pg_temp.q_as(adm, format('select public.admin_finish_erasure(%L, true)::text', r1)), 'DATABASE_STEP_NOT_DONE', 'finishing before the database step');
  j := pg_temp.q_as(adm, format('select public.admin_finish_erasure(%L, false)::text', r2))::jsonb;
  perform pg_temp.must((j ->> 'completed')::boolean = false, 'a failed login step is reported, not hidden');
  perform pg_temp.must((select status = 'in_progress' from public.privacy_requests where id = r2) and exists (select 1 from public.privacy_request_events where request_id = r2 and event = 'erasure_login_step_failed'), 'and it is recorded');
  -- 0032: a caller cannot CLAIM the login is disabled; the database looks at the auth row itself.
  j := pg_temp.q_as(adm, format('select public.admin_finish_erasure(%L, true)::text', r2))::jsonb;
  perform pg_temp.must((j ->> 'completed')::boolean = false and j ->> 'reason' = 'login_not_disabled', 'claiming the login is disabled does not close the request while it is not');
  perform pg_temp.must((select status = 'in_progress' from public.privacy_requests where id = r2), 'the request stays open after a false claim');
  -- What the Edge Function's soft delete does to the auth row (the test cannot call the Auth API).
  update auth.users set deleted_at = now() where id = m2;
  j := pg_temp.q_as(adm, format('select public.admin_finish_erasure(%L, false)::text', r2))::jsonb;
  perform pg_temp.must((j ->> 'completed')::boolean = true, 'completion is recorded once the login really is disabled, whatever the caller said');
  perform pg_temp.must((select status = 'completed' and resolved_at is not null from public.privacy_requests where id = r2), 'the request is closed');
  j := pg_temp.q_as(adm, format('select public.admin_finish_erasure(%L, true)::text', r2))::jsonb;
  perform pg_temp.must((j ->> 'already')::boolean = true, 'finishing twice is harmless');
  perform pg_temp.must((select count(*) from public.privacy_request_events where request_id = r2 and event = 'erasure_completed') = 1, 'completion is recorded exactly once');

  -- ── Audit and exports after erasure ──────────────────────────────────────
  perform pg_temp.must((select count(distinct action) from public.audit_logs where action in ('ERASURE_PREFLIGHT', 'ERASURE_DATABASE_DONE', 'ERASURE_LOGIN_STEP_FAILED', 'ERASURE_COMPLETED')) = 4, 'each erasure step is audited');
  perform pg_temp.must(not exists (select 1 from public.audit_logs where action like 'ERASURE\_%' and coalesce(new_values::text, '') ~* '@|Erase Test'), 'the erasure audit holds no personal data');
  v := pg_temp.q_as(m2, $q$select public.export_my_data()::text$q$);
  perform pg_temp.must(v not like '%p15-%' and v like '%Deleted member%', 'an export after erasure holds no identifying details');
  perform pg_temp.must_err(pg_temp.q_as(m2, format('select public.cancel_my_privacy_request(%L)::text', r2)), 'NOT_CANCELLABLE', 'cancelling a finished erasure');

  raise notice 'ALL PHASE 15 CHECKS PASSED';
end $$;

rollback;
