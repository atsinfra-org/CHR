-- Phase 16 test: privacy hardening (0032). Apply 0028–0032 first.
-- One transaction, ends in ROLLBACK. Uses isolated test users only (@example.invalid).
-- Prints "ALL PHASE 16 CHECKS PASSED" on success.
--
-- DO NOT RUN ON PRODUCTION. Like phases 13 to 15 it switches the profile privilege trigger off for a moment
-- (inside its transaction) to create test admins; use phase13b_production_safe_check.sql for the live database.
-- RUN ON A REPLICA OR STAGING COPY. The retention checks run the cleanup executor, which acts on a
-- whole table (not just the test rows). So that this can never touch real data, the test REFUSES TO RUN
-- (SKIPPED_FOR_SAFETY) if the database already has old rows in the five tables the executor can clean.
-- On a replica without the auth columns, first:  alter table auth.users add column if not exists
--   deleted_at timestamptz, add column if not exists banned_until timestamptz;  (Supabase already has them.)

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
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid();      -- members
  s uuid := gen_random_uuid();                                    -- staff
  adm uuid := gen_random_uuid(); adm2 uuid := gen_random_uuid();  -- two admins (separation of duties)
  v text; j jsonb; n bigint; n2 bigint;
  ra uuid; rb uuid; rc uuid; r_er uuid; r_x uuid; r_cons uuid; r_nom uuid; r_corr1 uuid; r_corr2 uuid;
  v_plan uuid; v_mem uuid; v_past uuid; v_book uuid; v_dev uuid; v_note uuid; v_enq_old uuid;
  pay_before bigint; audit_before bigint; prof_before bigint;
begin
  -- ── Safety: never run the executor over real data ─────────────────────────
  if exists (select 1 from public.notifications where created_at < now() - interval '30 days')
     or exists (select 1 from public.enquiries where created_at < now() - interval '30 days')
     or exists (select 1 from public.attendance where notes is not null and marked_at < now() - interval '30 days')
     or exists (select 1 from public.push_devices where disabled_at is not null and disabled_at < now() - interval '30 days')
     or exists (select 1 from public.push_deliveries where created_at < now() - interval '30 days') then
    raise exception 'SKIPPED_FOR_SAFETY: this database has old rows the retention executor would act on. Run this test on a replica or staging copy.';
  end if;

  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select u, 'p16-' || left(u::text, 8) || '@example.invalid', '{"full_name":"P16 Test"}', 'authenticated', 'authenticated'
  from unnest(array[a, b, s, adm, adm2]) u;
  alter table public.profiles disable trigger trg_prevent_privilege_escalation;
  update public.profiles set role = 'staff' where id = s;
  update public.profiles set role = 'admin' where id in (adm, adm2);
  alter table public.profiles enable trigger trg_prevent_privilege_escalation;

  -- ═══ 1. Duplicate requests ═══════════════════════════════════════════════
  ra := pg_temp.q_as(a, $q$select (public.submit_privacy_request('access')).id::text$q$)::uuid;
  perform pg_temp.must(ra is not null, 'a member can ask for a copy of their data');
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select (public.submit_privacy_request('access'))::text$q$), 'ALREADY_REQUESTED', 'a second open access request');
  rb := pg_temp.q_as(b, $q$select (public.submit_privacy_request('access')).id::text$q$)::uuid;
  perform pg_temp.must(rb is not null and rb <> ra, 'another member is not blocked by someone else''s open request');
  r_cons := pg_temp.q_as(a, $q$select (public.submit_privacy_request('consent_withdrawal')).id::text$q$)::uuid;
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select (public.submit_privacy_request('consent_withdrawal'))::text$q$), 'ALREADY_REQUESTED', 'a second open consent-withdrawal request');
  r_nom := pg_temp.q_as(a, $q$select (public.submit_privacy_request('nomination', 'Nominee', 'My sister may act for me')).id::text$q$)::uuid;
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select (public.submit_privacy_request('nomination', 'Nominee', 'Again'))::text$q$), 'ALREADY_REQUESTED', 'a second open nomination');
  -- Corrections and complaints can legitimately differ, so they are not de-duplicated (the cap of 10 still applies).
  r_corr1 := pg_temp.q_as(a, $q$select (public.submit_privacy_request('correction', 'Phone', 'My number changed')).id::text$q$)::uuid;
  r_corr2 := pg_temp.q_as(a, $q$select (public.submit_privacy_request('correction', 'Name', 'Spelling')).id::text$q$)::uuid;
  perform pg_temp.must(r_corr1 is not null and r_corr2 is not null and r_corr1 <> r_corr2, 'two different corrections are both accepted');
  -- The database itself refuses a second open one, even from two simultaneous submissions.
  begin
    insert into public.privacy_requests (user_id, request_type, status) values (a, 'access', 'in_progress');
    raise exception 'FAIL: the unique index let a second open access request in';
  exception when unique_violation then null; end;
  -- Closing the first frees the slot.
  perform pg_temp.q_as(adm, format($q$select (public.admin_update_privacy_request(%L, 'completed', null, 'Copy sent'))::text$q$, ra));
  perform pg_temp.must(pg_temp.q_as(a, $q$select (public.submit_privacy_request('access')).id::text$q$) is not null, 'after the first is closed a new one can be made');

  -- ═══ 2. Identity check ═══════════════════════════════════════════════════
  rc := pg_temp.q_as(b, $q$select (public.submit_privacy_request('erasure')).id::text$q$)::uuid;
  perform pg_temp.must_err(pg_temp.q_as(b, format($q$select (public.admin_verify_requester_identity(%L, 'phone_callback', null))::text$q$, rc)), 'NOT_AUTHORIZED', 'a member verifying their own identity');
  perform pg_temp.must_err(pg_temp.q_as(s, format($q$select (public.admin_verify_requester_identity(%L, 'phone_callback', null))::text$q$, rc)), 'NOT_AUTHORIZED', 'staff verifying identity');
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select (public.admin_verify_requester_identity(%L, 'guessing', null))::text$q$, rc)), 'INVALID_METHOD', 'an unknown method');
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select (public.admin_verify_requester_identity(%L, null, null))::text$q$, rc)), 'INVALID_METHOD', 'no method');
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select (public.admin_verify_requester_identity(%L, 'phone_callback', %L))::text$q$, rc, repeat('x', 1001))), 'TEXT_TOO_LONG', 'an oversized note');
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select (public.admin_verify_requester_identity(%L, 'phone_callback', null))::text$q$, gen_random_uuid())), 'REQUEST_NOT_FOUND', 'an unknown request');
  perform pg_temp.must_err(pg_temp.q_as(null, format($q$select (public.admin_verify_requester_identity(%L, 'phone_callback', null))::text$q$, rc)), 'NOT_AUTHORIZED', 'no signed-in user');
  -- Nobody confirms their own request: an admin who asks for their data needs the OTHER admin.
  r_x := pg_temp.q_as(adm, $q$select (public.submit_privacy_request('access')).id::text$q$)::uuid;
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select (public.admin_verify_requester_identity(%L, 'in_person', null))::text$q$, r_x)), 'CANNOT_VERIFY_OWN_REQUEST', 'an admin verifying their own request');
  perform pg_temp.must(pg_temp.q_as(adm2, format($q$select (public.admin_verify_requester_identity(%L, 'in_person', null))::text$q$, r_x)) is not null, 'the other admin can verify it');

  -- Before the check: erasure and export are refused.
  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('erasure_finalisation_enabled', 'true')::text$q$);
  perform pg_temp.q_as(adm, format($q$select (public.admin_update_privacy_request(%L, 'in_progress', null, 'Reviewed'))::text$q$, rc));
  perform pg_temp.must_err(pg_temp.q_as(adm, format('select public.admin_execute_erasure(%L)::text', rc)), 'IDENTITY_NOT_VERIFIED', 'erasure before the requester is checked');
  perform pg_temp.must((select erased_at is null and full_name <> 'Deleted member' from public.profiles where id = b), 'the refused erasure changed nothing');
  j := pg_temp.q_as(adm, format('select public.admin_erasure_preflight(%L)::text', rc))::jsonb;
  perform pg_temp.must((j ->> 'identity_verified')::boolean = false and (j ->> 'can_execute')::boolean = false, 'the preflight says the identity is not checked and erasure cannot run');
  perform pg_temp.must_err(pg_temp.q_as(adm, format('select public.admin_export_member_data(%L)::text', rb)), 'IDENTITY_NOT_VERIFIED', 'a data copy before the requester is checked');

  -- After the check: allowed, recorded once, and repeating it changes nothing.
  perform pg_temp.q_as(adm2, format($q$select (public.admin_verify_requester_identity(%L, 'phone_callback', 'Called back on the number on file'))::text$q$, rc));
  perform pg_temp.q_as(adm2, format($q$select (public.admin_verify_requester_identity(%L, 'in_person', 'second time'))::text$q$, rc));
  perform pg_temp.must((select identity_method = 'phone_callback' and identity_verified_by = adm2 and identity_verified_at is not null from public.privacy_requests where id = rc), 'who checked it, how and when are recorded, and a repeat does not overwrite');
  perform pg_temp.must((select count(*) from public.privacy_request_events where request_id = rc and event = 'identity_verified') = 1, 'the check is recorded exactly once');
  perform pg_temp.must(exists (select 1 from public.audit_logs where action = 'PRIVACY_IDENTITY_VERIFIED' and record_id = rc), 'the check is audited');
  perform pg_temp.must(not exists (select 1 from public.audit_logs where action = 'PRIVACY_IDENTITY_VERIFIED' and coalesce(new_values::text, '') ~* '@|Called back'), 'the audit entry holds no personal data or free text');
  j := pg_temp.q_as(adm, format('select public.admin_erasure_preflight(%L)::text', rc))::jsonb;
  perform pg_temp.must((j ->> 'identity_verified')::boolean and (j ->> 'can_execute')::boolean, 'with the check done, a clean member can be erased');
  perform pg_temp.q_as(adm, format($q$select (public.admin_update_privacy_request(%L, 'completed', null, 'Done'))::text$q$, rb));
  perform pg_temp.must_err(pg_temp.q_as(adm2, format($q$select (public.admin_verify_requester_identity(%L, 'phone_callback', null))::text$q$, rb)), 'REQUEST_CLOSED', 'verifying a closed request');

  -- ═══ 3. The login state is read from the auth schema ═════════════════════
  perform pg_temp.must(public._login_disabled(gen_random_uuid()) = true, 'a login that no longer exists counts as disabled');
  perform pg_temp.must(public._login_disabled(a) = false, 'a normal login is not disabled');
  update auth.users set banned_until = now() + interval '1 day' where id = a;
  perform pg_temp.must(public._login_disabled(a) = true, 'a banned login is disabled');
  update auth.users set banned_until = now() - interval '1 day' where id = a;
  perform pg_temp.must(public._login_disabled(a) = false, 'an expired ban does not count');
  update auth.users set deleted_at = now() where id = a;
  perform pg_temp.must(public._login_disabled(a) = true, 'a soft-deleted login is disabled');
  update auth.users set deleted_at = null where id = a;
  perform pg_temp.must(not has_function_privilege('authenticated', 'public._login_disabled(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._login_disabled(uuid)', 'execute'), 'the helper is not callable by members or visitors');

  -- ═══ 4. Paging ═══════════════════════════════════════════════════════════
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select count(*)::text from public.admin_list_privacy_requests(null, 10, 0)$q$), 'NOT_AUTHORIZED', 'a member listing requests');
  perform pg_temp.must_err(pg_temp.q_as(s, $q$select count(*)::text from public.admin_list_privacy_requests(null, 10, 0)$q$), 'NOT_AUTHORIZED', 'staff listing requests');
  perform pg_temp.must(pg_temp.q_as(adm, $q$select (select id from public.admin_list_privacy_requests(null, 1, 0))::text$q$) is distinct from
                       pg_temp.q_as(adm, $q$select (select id from public.admin_list_privacy_requests(null, 1, 1))::text$q$), 'page 2 is a different row from page 1');
  perform pg_temp.must(pg_temp.q_as(adm, $q$select count(*)::text from public.admin_list_privacy_requests(null, 2, 0)$q$) = '2', 'a page holds the number asked for');
  perform pg_temp.must(pg_temp.q_as(adm, $q$select count(*)::text from public.admin_list_privacy_requests(null, 5, -9)$q$)::int > 0, 'a negative offset is treated as the start');
  perform pg_temp.must(pg_temp.q_as(adm, $q$select count(*)::text from public.admin_list_privacy_requests('completed', 50, 0) where status <> 'completed'$q$) = '0', 'the status filter still works with paging');
  perform pg_temp.must(pg_temp.q_as(adm, $q$select count(*)::text from public.admin_list_privacy_requests(null, 5000, 0)$q$)::int <= 500, 'a page is capped at 500');
  perform pg_temp.must_err(pg_temp.q_as(s, $q$select count(*)::text from public.admin_privacy_audit(10, 0)$q$), 'NOT_AUTHORIZED', 'staff reading the audit');
  perform pg_temp.must(pg_temp.q_as(adm, $q$select (select created_at from public.admin_privacy_audit(1, 0))::text$q$) is not null
                   and pg_temp.q_as(adm, $q$select count(*)::text from public.admin_privacy_audit(1, 1)$q$) = '1', 'the audit trail can be paged');

  -- ═══ 5. A member's consent history, for administrators only ═══════════════
  perform pg_temp.q_as(a, $q$select public.record_consent('push_notifications', 'granted', null, 'mobile')::text$q$);
  perform pg_temp.q_as(a, $q$select public.record_consent('push_notifications', 'withdrawn', null, 'mobile')::text$q$);
  perform pg_temp.must_err(pg_temp.q_as(a, format($q$select count(*)::text from public.admin_member_consents(%L, 10, 0)$q$, a)), 'NOT_AUTHORIZED', 'a member reading consent history through the admin function');
  perform pg_temp.must_err(pg_temp.q_as(s, format($q$select count(*)::text from public.admin_member_consents(%L, 10, 0)$q$, a)), 'NOT_AUTHORIZED', 'staff reading consent history');
  perform pg_temp.must(pg_temp.q_as(adm, format($q$select count(*)::text from public.admin_member_consents(%L, 10, 0)$q$, a)) = '2', 'an admin sees the member''s two consent records');
  perform pg_temp.must(pg_temp.q_as(adm, format($q$select action from public.admin_member_consents(%L, 1, 0)$q$, a)) = 'withdrawn', 'newest first');
  perform pg_temp.must(pg_temp.q_as(adm, format($q$select count(*)::text from public.admin_member_consents(%L, 10, 0)$q$, b)) = '0', 'another member''s history is not mixed in');
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select count(*)::text from public.admin_member_consents(%L, 10, 0)$q$, gen_random_uuid())), 'USER_NOT_FOUND', 'an unknown member');
  perform pg_temp.must(exists (select 1 from public.audit_logs where action = 'PRIVACY_CONSENT_VIEWED' and record_id = a), 'viewing a member''s consent history is audited');

  -- ═══ 6. Retention: refusals ═════════════════════════════════════════════
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select public.admin_run_retention('notifications')::text$q$), 'NOT_AUTHORIZED', 'a member running cleanup');
  perform pg_temp.must_err(pg_temp.q_as(s, $q$select public.admin_run_retention('notifications')::text$q$), 'NOT_AUTHORIZED', 'staff running cleanup');
  perform pg_temp.must_err(pg_temp.q_as(null, $q$select public.admin_run_retention('notifications')::text$q$), 'NOT_AUTHORIZED', 'no signed-in user running cleanup');
  perform pg_temp.must_err(pg_temp.q_as(adm, $q$select public.admin_run_retention('made_up')::text$q$), 'UNKNOWN_CATEGORY', 'an unknown category');
  perform pg_temp.must_err(pg_temp.q_as(adm, $q$select public.admin_run_retention('notifications')::text$q$), 'RULE_NOT_APPROVED', 'cleanup of an unapproved rule');
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select public.admin_set_privacy_config('retention_cleanup_enabled', 'true')::text$q$), 'NOT_AUTHORIZED', 'a member switching cleanup on');
  perform pg_temp.must_err(pg_temp.q_as(s, $q$select public.admin_set_privacy_config('retention_cleanup_enabled', 'true')::text$q$), 'NOT_AUTHORIZED', 'staff switching cleanup on');
  perform pg_temp.must_err(pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('retention_cleanup_enabled', 'maybe')::text$q$), 'INVALID_VALUE', 'a non-boolean switch value');
  perform pg_temp.must((select value from public.privacy_config where key = 'retention_cleanup_enabled') = 'false', 'cleanup is OFF by default');
  perform pg_temp.must(pg_temp.q_as(null, $q$select public.public_privacy_config()::text$q$) not like '%retention_cleanup%', 'the public details do not expose the switch');
  -- Categories that are never deleted by a timer, even when the club approves a period for them.
  foreach v in array array['payments_orders', 'payment_webhook_events', 'audit_logs', 'privacy_requests', 'consent_events', 'member_profiles', 'auth_records', 'memberships_credits', 'bookings_attendance', 'uploaded_documents'] loop
    perform pg_temp.q_as(adm, format($q$select public.admin_set_retention_rule(%L, 30, 'Test reason', true)::text$q$, v));
    perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select public.admin_run_retention(%L, false)::text$q$, v)), 'NOT_AUTOMATED', 'automatic deletion of ' || v);
  end loop;

  -- ═══ 7. Retention: what it does and does not touch ═══════════════════════
  select id into v_plan from public.membership_plans where plan_code = 'GOLD';
  insert into public.class_sessions (session_date, start_time, end_time, capacity, status) values (current_date - 40, '06:00', '07:00', 3, 'completed') returning id into v_past;
  insert into public.memberships (user_id, plan_id, status, start_date, end_date, total_credits, reschedules_allowed, reschedules_used)
    values (a, v_plan, 'expired', current_date - 80, current_date - 51, 8, 2, 0) returning id into v_mem;
  insert into public.bookings (user_id, membership_id, session_id, status) values (a, v_mem, v_past, 'completed') returning id into v_book;
  insert into public.attendance (booking_id, status, marked_by, marked_at, notes) values (v_book, 'present', adm, now() - interval '60 days', 'a staff note');
  insert into public.payments (user_id, membership_id, gateway, gateway_order_id, gateway_payment_id, amount, currency, status, paid_at, created_at)
    values (a, v_mem, 'razorpay', 'order_p16', 'pay_p16', 15000, 'INR', 'success', now() - interval '90 days', now() - interval '90 days');

  insert into public.notifications (audience, user_id, type, title, created_at) values
    ('user', a, 'p16_old', 'old a1', now() - interval '40 days'), ('user', a, 'p16_old', 'old a2', now() - interval '41 days'),
    ('user', b, 'p16_old', 'old b1', now() - interval '45 days'), ('user', a, 'p16_new', 'recent', now() - interval '2 days');
  select id into v_note from public.notifications where title = 'old a1';
  insert into public.push_devices (user_id, token, platform, disabled_at, disabled_reason)
    values (a, 'ExponentPushToken[p16-old-' || left(a::text, 8) || ']', 'android', now() - interval '60 days', 'test') returning id into v_dev;
  insert into public.push_devices (user_id, token, platform) values (b, 'ExponentPushToken[p16-live-' || left(b::text, 8) || ']', 'android');
  insert into public.push_deliveries (notification_id, device_id, status, created_at) values (v_note, v_dev, 'sent', now() - interval '50 days');
  insert into public.enquiries (id, name, age, email, phone, topic, status, created_at) values
    (gen_random_uuid(), 'P16 old answered', 20, 'o@example.invalid', '9', 't', 'answered', now() - interval '60 days'),
    (gen_random_uuid(), 'P16 old unanswered', 20, 'u@example.invalid', '9', 't', 'new', now() - interval '60 days'),
    (gen_random_uuid(), 'P16 recent answered', 20, 'r@example.invalid', '9', 't', 'answered', now() - interval '2 days');

  select count(*) into pay_before from public.payments;
  select count(*) into audit_before from public.audit_logs;
  select count(*) into prof_before from public.profiles;

  -- approve 30-day periods for the five automated categories
  foreach v in array array['notifications', 'push_devices_disabled', 'push_deliveries', 'enquiries', 'attendance_notes'] loop
    perform pg_temp.q_as(adm, format($q$select public.admin_set_retention_rule(%L, 30, 'Test reason', true)::text$q$, v));
  end loop;

  -- default call is a dry run and deletes nothing
  j := pg_temp.q_as(adm, $q$select public.admin_run_retention('notifications')::text$q$)::jsonb;
  perform pg_temp.must((j ->> 'dry_run')::boolean and (j ->> 'would_affect')::int = 3, 'the default is a dry run that counts the 3 old notifications: ' || j::text);
  perform pg_temp.must((select count(*) from public.notifications where type like 'p16_%') = 4, 'a dry run deleted nothing');
  j := pg_temp.q_as(adm, $q$select public.admin_run_retention('notifications', true)::text$q$)::jsonb;
  perform pg_temp.must((j ->> 'dry_run')::boolean, 'an explicit dry run is a dry run');
  -- a real run is refused while the switch is off
  perform pg_temp.must_err(pg_temp.q_as(adm, $q$select public.admin_run_retention('notifications', false)::text$q$), 'RETENTION_CLEANUP_DISABLED', 'a real run while cleanup is switched off');
  perform pg_temp.must((select count(*) from public.notifications where type like 'p16_%') = 4, 'the refused run deleted nothing');
  -- a legal hold stops it
  update public.retention_rules set legal_hold = true where category = 'notifications';
  perform pg_temp.must_err(pg_temp.q_as(adm, $q$select public.admin_run_retention('notifications')::text$q$), 'LEGAL_HOLD', 'cleanup of a category under legal hold');
  update public.retention_rules set legal_hold = false where category = 'notifications';

  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('retention_cleanup_enabled', 'true')::text$q$);

  j := pg_temp.q_as(adm, $q$select public.admin_run_retention('notifications', false)::text$q$)::jsonb;
  perform pg_temp.must((j ->> 'affected')::int = 3 and not (j ->> 'more_remaining')::boolean, 'the real run removed the 3 old notifications: ' || j::text);
  perform pg_temp.must((select count(*) from public.notifications where type = 'p16_old') = 0 and (select count(*) from public.notifications where type = 'p16_new') = 1, 'the recent notification survived');
  perform pg_temp.must(not exists (select 1 from public.push_deliveries where notification_id = v_note), 'delivery logs of removed notifications went with them');
  j := pg_temp.q_as(adm, $q$select public.admin_run_retention('notifications', false)::text$q$)::jsonb;
  perform pg_temp.must((j ->> 'affected')::int = 0, 'running it again finds nothing and changes nothing');

  j := pg_temp.q_as(adm, $q$select public.admin_run_retention('push_devices_disabled', false)::text$q$)::jsonb;
  perform pg_temp.must((j ->> 'affected')::int = 1, 'the switched-off phone code past its period was removed');
  perform pg_temp.must(exists (select 1 from public.push_devices where user_id = b and disabled_at is null), 'a live phone code was not touched');

  j := pg_temp.q_as(adm, $q$select public.admin_run_retention('enquiries', false)::text$q$)::jsonb;
  perform pg_temp.must((j ->> 'affected')::int = 1, 'only the old ANSWERED enquiry was removed');
  perform pg_temp.must(exists (select 1 from public.enquiries where name = 'P16 old unanswered') and exists (select 1 from public.enquiries where name = 'P16 recent answered'), 'an unanswered or recent enquiry is never removed by the timer');

  j := pg_temp.q_as(adm, $q$select public.admin_run_retention('attendance_notes', false)::text$q$)::jsonb;
  perform pg_temp.must((j ->> 'affected')::int = 1, 'the old staff note was blanked');
  perform pg_temp.must((select notes is null and status = 'present' from public.attendance where booking_id = v_book), 'the attendance record itself stays; only the note goes');

  perform pg_temp.must((select count(*) from public.payments) = pay_before and exists (select 1 from public.payments where gateway_payment_id = 'pay_p16'), 'payment records were not touched by any cleanup');
  perform pg_temp.must((select count(*) from public.profiles) = prof_before, 'no profile was touched');
  perform pg_temp.must((select count(*) from public.audit_logs) >= audit_before, 'no audit entry was removed');
  perform pg_temp.must(exists (select 1 from public.audit_logs where action = 'PRIVACY_RETENTION_RUN'), 'each real run is audited');
  perform pg_temp.must(not exists (select 1 from public.audit_logs where action = 'PRIVACY_RETENTION_RUN' and coalesce(new_values::text, '') ~* '@|P16 '), 'the cleanup audit holds counts, not personal data');
  -- the preview agrees with the executor
  perform pg_temp.must(pg_temp.q_as(adm, $q$select rows_past_period::text from public.admin_retention_preview() where category = 'enquiries'$q$) = '0', 'the preview matches what is left');

  -- ═══ 8. The 0028 security fix is intact ═════════════════════════════════
  perform pg_temp.must_err(pg_temp.q_as(s, format($q$update public.profiles set role = 'admin' where id = %L returning 'x'$q$, s)), 'Only an admin may change role/status', 'staff promoting themselves to admin (0028)');
  perform pg_temp.must_err(pg_temp.q_as(a, format($q$update public.profiles set role = 'admin' where id = %L returning 'x'$q$, a)), 'Only an admin may change role/status', 'a member promoting themselves (0028)');
  perform pg_temp.must((select role from public.profiles where id = s) = 'staff', 'the staff account is still staff');

  raise notice 'ALL PHASE 16 CHECKS PASSED';
end $$;

rollback;
