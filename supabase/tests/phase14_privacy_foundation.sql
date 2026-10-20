-- Phase 14 test: DPDP privacy foundation (0030). Apply 0028–0030 first.
-- One transaction, ends in ROLLBACK (nothing persists). A failed check aborts with "FAIL: ...";
-- success prints "ALL PHASE 14 CHECKS PASSED". Uses isolated test users only (@example.invalid).
-- Run on a local or staging copy first; it only ever reads/writes its own test rows.

begin;

-- Run one statement as a given user (null = signed-out visitor); returns its first value as text,
-- or 'ERR:<message>' if it raised. The role is always reset afterwards.
create function pg_temp.q_as(p_uid uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_uid is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
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
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); d uuid := gen_random_uuid();
  s uuid := gen_random_uuid(); adm uuid := gen_random_uuid();
  v text; n int; v_req uuid; v_before bigint; v_after bigint; v_sha text;
  v_plan uuid; v_mem uuid; v_sess uuid; v_book uuid;
  v_tok text := 'ExponentPushToken[p14-' || left(gen_random_uuid()::text, 8) || ']';
  v_erase uuid; v_exp text; v_exp_b text; v_nbefore bigint; v_nafter bigint;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select u, 'p14-' || left(u::text, 8) || '@example.invalid', '{"full_name":"Test Person"}', 'authenticated', 'authenticated'
  from unnest(array[a, b, c, d, s, adm]) u;
  alter table public.profiles disable trigger trg_prevent_privilege_escalation;
  update public.profiles set role = 'staff' where id = s;
  update public.profiles set role = 'admin' where id = adm;
  alter table public.profiles enable trigger trg_prevent_privilege_escalation;

  -- ── 1. Signed-out visitors ────────────────────────────────────────────────
  perform pg_temp.must_err(pg_temp.q_as(null, 'select count(*)::text from public.consent_events'), 'permission denied', 'anon read consent_events');
  perform pg_temp.must_err(pg_temp.q_as(null, 'select count(*)::text from public.privacy_requests'), 'permission denied', 'anon read privacy_requests');
  perform pg_temp.must_err(pg_temp.q_as(null, 'select count(*)::text from public.privacy_config'), 'permission denied', 'anon read privacy_config');
  perform pg_temp.must_err(pg_temp.q_as(null, $q$select public.record_consent('push_notifications','withdrawn',null,'web')::text$q$), 'permission denied', 'anon record_consent');
  perform pg_temp.must_err(pg_temp.q_as(null, 'select public.export_my_data()::text'), 'permission denied', 'anon export');
  perform pg_temp.must(pg_temp.q_as(null, $q$select (public.current_privacy_notice())->>'published'$q$) = 'false', 'anon can read the (draft) notice');
  perform pg_temp.must((pg_temp.q_as(null, $q$select (public.public_privacy_config())->>'complete'$q$)) = 'false', 'club details start incomplete');

  -- ── 2. The draft notice never shows a half-filled template ───────────────
  v := pg_temp.q_as(null, $q$select (public.current_privacy_notice())->>'body'$q$);
  perform pg_temp.must(v not like '%{{%', 'no unfilled {{placeholders}} in the rendered draft');
  perform pg_temp.must(v like '%[not yet provided]%', 'a missing required detail is visibly marked');
  perform pg_temp.must(v not like '%Phone:%', 'an unset optional phone line is left out, not shown empty');
  perform pg_temp.must(v like '%## Who we are%', 'the notice has its sections');

  -- ── 3. Consent cannot be recorded against an unpublished notice ──────────
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select public.record_consent('membership_service','granted','1.0','web')::text$q$), 'NOTICE_NOT_PUBLISHED', 'consent against a draft');
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select public.record_consent('membership_service','withdrawn',null,'web')::text$q$), 'MANDATORY_PURPOSE', 'withdrawing the essential service');
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select public.record_consent('nonsense','granted','1.0','web')::text$q$), 'UNKNOWN_PURPOSE', 'unknown purpose');
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select public.record_consent('marketing_communications','granted','1.0','web')::text$q$), 'UNKNOWN_PURPOSE', 'an inactive purpose cannot be consented to');
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select public.record_consent('push_notifications','granted','1.0','email')::text$q$), 'INVALID_SOURCE', 'bad source');
  -- An optional choice can be switched back on before any notice exists (the member's own act, no version).
  perform pg_temp.must(pg_temp.q_as(d, $q$select public.record_consent('push_notifications','withdrawn',null,'web')::text$q$) like '%"recorded": true%', 'D can withdraw phone alerts before a notice exists');
  perform pg_temp.must(pg_temp.q_as(d, $q$select public.record_consent('push_notifications','granted',null,'web')::text$q$) like '%"recorded": true%', 'D can switch them back on before a notice exists');
  perform pg_temp.must_err(pg_temp.q_as(d, $q$select public.record_consent('push_notifications','granted','9.9','web')::text$q$), 'NOTICE_VERSION_MISMATCH', 'naming a notice version that does not exist');
  perform pg_temp.must((select count(*) from public.consent_events where user_id = d) = 2, 'both of D''s choices are on record');

  -- ── 4. Publishing is guarded ──────────────────────────────────────────────
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select public.admin_publish_privacy_notice('1.0', true, current_date)::text$q$), 'NOT_AUTHORIZED', 'member publishing');
  perform pg_temp.must_err(pg_temp.q_as(s, $q$select public.admin_publish_privacy_notice('1.0', true, current_date)::text$q$), 'NOT_AUTHORIZED', 'staff publishing');
  perform pg_temp.must_err(pg_temp.q_as(s, $q$select public.admin_set_privacy_config('legal_entity_name','X')::text$q$), 'NOT_AUTHORIZED', 'staff editing club details');
  perform pg_temp.must_err(pg_temp.q_as(adm, $q$select public.admin_publish_privacy_notice('1.0', false, current_date)::text$q$), 'LEGAL_REVIEW_NOT_CONFIRMED', 'publishing without review confirmation');
  perform pg_temp.must_err(pg_temp.q_as(adm, $q$select public.admin_publish_privacy_notice('1.0', true, current_date)::text$q$), 'CLUB_DETAILS_MISSING', 'publishing with club details missing');
  perform pg_temp.must_err(pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('not_a_key','x')::text$q$), 'UNKNOWN_KEY', 'unknown config key');
  perform pg_temp.must_err(pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('response_target_days','soon')::text$q$), 'INVALID_VALUE', 'non-numeric target days');

  -- The owner supplies the details (test values), then publishes.
  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('legal_entity_name','Test Club Pvt Ltd')::text$q$);
  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('registered_address','1 Test Road, Test City')::text$q$);
  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('privacy_contact_email','privacy@test.invalid')::text$q$);
  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('grievance_officer_name','Test Officer')::text$q$);
  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('grievance_officer_email','grievance@test.invalid')::text$q$);
  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('retention_summary','Test retention text.')::text$q$);
  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('children_policy_text','Test children text.')::text$q$);
  perform pg_temp.must_err(pg_temp.q_as(adm, $q$select public.admin_publish_privacy_notice('1.0', true, current_date)::text$q$), 'CLUB_DETAILS_MISSING', 'still missing the data-location statement');
  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('data_location_statement','Test location text.')::text$q$);
  perform pg_temp.must(pg_temp.q_as(adm, $q$select public.admin_publish_privacy_notice('1.0', true, current_date)::text$q$) is not null, 'publish succeeds when complete and confirmed');

  v := pg_temp.q_as(null, $q$select (public.current_privacy_notice())->>'body'$q$);
  perform pg_temp.must(v like '%Test Club Pvt Ltd%' and v not like '%[not yet provided]%', 'published text has the club details filled in');
  perform pg_temp.must((pg_temp.q_as(null, $q$select (public.current_privacy_notice())->>'published'$q$)) = 'true', 'the notice now reads as published');
  select published_sha256 into v_sha from public.privacy_notice_versions where version = '1.0';
  perform pg_temp.must(v_sha is not null and length(v_sha) = 64, 'a hash of the published text is stored');

  -- A published notice is frozen, even against the database owner, and later settings do not rewrite it.
  begin update public.privacy_notice_versions set body_md = 'tampered' where version = '1.0'; raise exception 'FAIL: edited a published notice';
  exception when others then if sqlerrm not like 'NOTICE_FROZEN%' then raise; end if; end;
  begin update public.privacy_notice_versions set rendered_body = 'tampered' where version = '1.0'; raise exception 'FAIL: edited the published text';
  exception when others then if sqlerrm not like 'NOTICE_FROZEN%' then raise; end if; end;
  perform pg_temp.must_err(pg_temp.q_as(adm, $q$select public.admin_save_notice_draft('1.0','t','b')::text$q$), 'NOTICE_FROZEN', 'overwriting a published version via the admin function');
  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('legal_entity_name','Renamed After Publication')::text$q$);
  perform pg_temp.must((pg_temp.q_as(null, $q$select (public.current_privacy_notice())->>'body'$q$)) like '%Test Club Pvt Ltd%', 'renaming the club later does not change a published notice');
  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('legal_entity_name','Test Club Pvt Ltd')::text$q$);

  -- ── 5. Consent records ────────────────────────────────────────────────────
  v := pg_temp.q_as(a, $q$select public.record_consent('membership_service','granted','1.0','web')::text$q$);
  perform pg_temp.must(v like '%"recorded": true%', 'A can record an acknowledgement of the published notice');
  perform pg_temp.must(pg_temp.q_as(a, $q$select public.record_consent('membership_service','granted','1.0','web')::text$q$) like '%"recorded": false%', 'repeating the same answer records nothing new');
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select public.record_consent('membership_service','granted','0.9','web')::text$q$), 'NOTICE_VERSION_MISMATCH', 'consent against an old version');
  select count(*) into n from public.consent_events where user_id = a;
  perform pg_temp.must(n = 1, 'exactly one consent record for A (got ' || n || ')');
  perform pg_temp.must((select abs(extract(epoch from now() - created_at)) < 5 from public.consent_events where user_id = a), 'the time is the server''s own');
  perform pg_temp.must((select user_id from public.consent_events where purpose = 'membership_service') = a, 'the acknowledgement belongs to the caller who made it');

  -- B cannot see, forge, alter or delete A's records.
  perform pg_temp.must(pg_temp.q_as(b, $q$select count(*)::text from public.consent_events$q$) = '0', 'B sees none of A''s consent records');
  perform pg_temp.must_err(pg_temp.q_as(b, format($q$insert into public.consent_events (user_id, purpose, action) values (%L, 'push_notifications', 'granted')$q$, a)::text), 'permission denied', 'B inserting a consent record for A');
  perform pg_temp.must_err(pg_temp.q_as(b, $q$delete from public.consent_events$q$), 'permission denied', 'B deleting consent records');
  perform pg_temp.must_err(pg_temp.q_as(a, $q$update public.consent_events set action = 'withdrawn'$q$), 'permission denied', 'A rewriting their own consent record');
  begin update public.consent_events set action = 'withdrawn'; raise exception 'FAIL: consent record was updated';
  exception when others then if sqlerrm not like 'CONSENT_IMMUTABLE%' then raise; end if; end;
  begin delete from public.consent_events; raise exception 'FAIL: consent record was deleted';
  exception when others then if sqlerrm not like 'CONSENT_IMMUTABLE%' then raise; end if; end;
  perform pg_temp.must(pg_temp.q_as(adm, $q$select count(*)::text from public.consent_events$q$)::int >= 1, 'an admin can review consent records');
  perform pg_temp.must(pg_temp.q_as(s, $q$select count(*)::text from public.consent_events$q$) = '0', 'ordinary staff cannot read consent records');

  perform pg_temp.must((pg_temp.q_as(a, $q$select (public.my_consents())->>'needs_acknowledgement'$q$)) = 'false', 'A has acknowledged the current notice');
  perform pg_temp.must((pg_temp.q_as(c, $q$select (public.my_consents())->>'needs_acknowledgement'$q$)) = 'true', 'C is told a notice is waiting, with nothing recorded for them');
  perform pg_temp.must(not exists (select 1 from public.consent_events where user_id = c), 'existing members are NOT recorded as having consented');

  -- ── 6. Withdrawing phone alerts is honoured ───────────────────────────────
  perform pg_temp.q_as(c, format($q$select public.register_push_device(%L, 'android', '1.0')::text$q$, v_tok));
  perform pg_temp.must(exists (select 1 from public.push_devices where user_id = c), 'a member who never answered can register a phone (behaviour unchanged)');
  perform pg_temp.must(pg_temp.q_as(c, $q$select public.record_consent('push_notifications','withdrawn',null,'mobile')::text$q$) like '%"recorded": true%', 'C withdraws phone alerts');
  perform pg_temp.must(not exists (select 1 from public.push_devices where user_id = c), 'withdrawing removes the phone''s alert code');
  perform pg_temp.must_err(pg_temp.q_as(c, format($q$select public.register_push_device(%L, 'android', '1.0')::text$q$, v_tok)), 'PUSH_WITHDRAWN', 'registering after withdrawal');
  perform pg_temp.must(pg_temp.q_as(c, $q$select public.record_consent('push_notifications','withdrawn',null,'mobile')::text$q$) like '%"recorded": false%', 'withdrawing twice records once');
  perform pg_temp.must(pg_temp.q_as(c, $q$select public.record_consent('push_notifications','granted','1.0','mobile')::text$q$) like '%"recorded": true%', 'C can switch alerts back on');
  perform pg_temp.q_as(c, format($q$select public.register_push_device(%L, 'android', '1.0')::text$q$, v_tok));
  perform pg_temp.must(exists (select 1 from public.push_devices where user_id = c), 'registering works again after granting');

  -- ── 7. Privacy requests ───────────────────────────────────────────────────
  perform pg_temp.must_err(pg_temp.q_as(null, $q$select (public.submit_privacy_request('access'))::text$q$), 'permission denied', 'anon request');
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select (public.submit_privacy_request('bogus'))::text$q$), 'INVALID_TYPE', 'invalid type');
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select (public.submit_privacy_request('grievance'))::text$q$), 'DETAILS_REQUIRED', 'grievance without details');
  perform pg_temp.must_err(pg_temp.q_as(a, format($q$select (public.submit_privacy_request('other', 'x', %L))::text$q$, repeat('x', 2001))), 'TEXT_TOO_LONG', 'oversized details');
  perform pg_temp.must_err(pg_temp.q_as(s, $q$select (public.submit_privacy_request('erasure'))::text$q$), 'PRIVILEGED_ACCOUNT', 'staff erasure request');
  v := pg_temp.q_as(a, $q$select (public.submit_privacy_request('access', 'My data', null)).id::text$q$);
  perform pg_temp.must(v not like 'ERR:%', 'A submits an access request: ' || v);
  v_req := v::uuid;
  perform pg_temp.must((select due_at is null from public.privacy_requests where id = v_req), 'no due date is invented when the club has set no target');
  perform pg_temp.q_as(adm, $q$select public.admin_set_privacy_config('response_target_days','30')::text$q$);
  v := pg_temp.q_as(a, $q$select (public.submit_privacy_request('correction', 'Fix my name', 'Please change it.')).id::text$q$);
  perform pg_temp.must((select abs(extract(epoch from (due_at - submitted_at)) - 30*86400) < 5 from public.privacy_requests where id = v::uuid), 'due date = submitted + the club''s own target (30 days)');
  perform pg_temp.q_as(a, $q$select (public.submit_privacy_request('erasure'))::text$q$);
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select (public.submit_privacy_request('erasure'))::text$q$), 'ALREADY_REQUESTED', 'a second open erasure request');

  perform pg_temp.must(pg_temp.q_as(b, $q$select count(*)::text from public.privacy_requests$q$) = '0', 'B sees none of A''s requests');
  perform pg_temp.must(pg_temp.q_as(b, $q$select count(*)::text from public.my_privacy_requests()$q$) = '0', 'B''s list is empty');
  perform pg_temp.must(pg_temp.q_as(a, $q$select count(*)::text from public.my_privacy_requests()$q$) = '3', 'A sees their 3 requests');
  perform pg_temp.must_err(pg_temp.q_as(b, format($q$select public.cancel_my_privacy_request(%L)::text$q$, v_req)), 'REQUEST_NOT_FOUND', 'B cancelling A''s request');
  perform pg_temp.must(pg_temp.q_as(b, $q$select count(*)::text from public.privacy_request_events$q$) = '0', 'B sees no request events');
  perform pg_temp.must_err(pg_temp.q_as(a, $q$update public.privacy_requests set status = 'completed'$q$), 'permission denied', 'A closing their own request directly');

  -- Admin side
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select count(*)::text from public.admin_list_privacy_requests()$q$), 'NOT_AUTHORIZED', 'member listing all requests');
  perform pg_temp.must_err(pg_temp.q_as(s, $q$select count(*)::text from public.admin_list_privacy_requests()$q$), 'NOT_AUTHORIZED', 'staff listing all requests');
  perform pg_temp.must(pg_temp.q_as(adm, $q$select count(*)::text from public.admin_list_privacy_requests()$q$) = '3', 'admin sees the requests');
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select (public.admin_update_privacy_request(%L, 'completed'))::text$q$, v_req)), 'NOTE_REQUIRED', 'completing without saying what was done');
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select (public.admin_update_privacy_request(%L, null, %L))::text$q$, v_req, a)), 'ASSIGNEE_MUST_BE_ADMIN', 'assigning to a non-admin');
  -- ── 7b. Admin handling ────────────────────────────────────────────────────
  select id into v_erase from public.privacy_requests where request_type = 'erasure' and user_id = a;
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select (public.admin_update_privacy_request(%L, 'completed', null, 'done'))::text$q$, v_erase)), 'USE_ERASURE_WORKFLOW', 'closing an erasure request with a status change');
  v := pg_temp.q_as(adm, format($q$select (public.admin_update_privacy_request(%L, 'in_progress', %L, 'Looking into it'))::text$q$, v_req, adm));
  perform pg_temp.must(v not like 'ERR:%', 'admin moves a request on: ' || v);
  perform pg_temp.must((select status = 'in_progress' and assigned_to = adm from public.privacy_requests where id = v_req), 'status and assignee saved');
  perform pg_temp.must(exists (select 1 from public.notifications where user_id = a and type = 'privacy_request_update'), 'the member is told about the update');
  perform pg_temp.must(pg_temp.q_as(adm, format($q$select (public.admin_update_privacy_request(%L, 'completed', null, 'Copy provided.'))::text$q$, v_req)) not like 'ERR:%', 'admin completes with a note');
  perform pg_temp.must((select status = 'completed' and resolved_at is not null and resolution_note = 'Copy provided.' from public.privacy_requests where id = v_req), 'completion saved with its note');
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select (public.admin_update_privacy_request(%L, 'in_progress'))::text$q$, v_req)), 'REQUEST_CLOSED', 'reopening a closed request');
  perform pg_temp.must((select count(*) from public.privacy_request_events where request_id = v_req) >= 3, 'every step of the request is recorded');
  perform pg_temp.must(pg_temp.q_as(adm, format($q$select count(*)::text from public.admin_privacy_request_events(%L)$q$, v_req))::int >= 3, 'admin can read the request''s event trail');
  perform pg_temp.must_err(pg_temp.q_as(s, format($q$select count(*)::text from public.admin_privacy_request_events(%L)$q$, v_req)), 'NOT_AUTHORIZED', 'staff reading the event trail');

  -- A member can withdraw an open request of their own, and cannot be forced past the open-request limit.
  v := pg_temp.q_as(b, $q$select (public.submit_privacy_request('other', 'Question', 'A question about my data.')).id::text$q$);
  v_exp := pg_temp.q_as(b, format($q$select public.cancel_my_privacy_request(%L)::text$q$, v::uuid));
  perform pg_temp.must(coalesce(v_exp, '') not like 'ERR:%', 'B cancels their own request: ' || coalesce(v_exp, ''));
  perform pg_temp.must((select status = 'cancelled' from public.privacy_requests where id = v::uuid), 'the request is cancelled');
  for n in 1..10 loop
    perform pg_temp.q_as(b, $q$select (public.submit_privacy_request('other', 'Q', 'A question.')).id::text$q$);
  end loop;
  perform pg_temp.must_err(pg_temp.q_as(b, $q$select (public.submit_privacy_request('other', 'Q', 'One too many.'))::text$q$), 'TOO_MANY_OPEN_REQUESTS', 'the 11th open request');

  -- ── 8. The audit trail records events without personal data ──────────────
  perform pg_temp.must((select count(distinct action) from public.audit_logs where action in ('CONSENT_GRANTED', 'CONSENT_WITHDRAWN', 'PRIVACY_NOTICE_PUBLISHED', 'PRIVACY_REQUEST_SUBMITTED', 'PRIVACY_CONFIG_UPDATED', 'PRIVACY_REQUEST_COMPLETED')) = 6, 'all expected privacy events are audited');
  perform pg_temp.must(not exists (
    select 1 from public.audit_logs
    where (action like 'PRIVACY\_%' or action like 'CONSENT\_%' or action like 'NOTICE\_%')
      and (coalesce(new_values::text, '') ~* '(@|Test Person|Test Club|Test Officer|1 Test Road)' or coalesce(old_values::text, '') ~* '(@|Test Person)')), 'privacy audit entries hold no names, emails or club details');
  perform pg_temp.must(pg_temp.q_as(adm, $q$select count(*)::text from public.admin_privacy_audit(200)$q$)::int > 5, 'admin can read the privacy audit');
  perform pg_temp.must_err(pg_temp.q_as(s, $q$select count(*)::text from public.admin_privacy_audit(10)$q$), 'NOT_AUTHORIZED', 'staff reading the privacy audit');

  -- ── 9. Personal-data export ───────────────────────────────────────────────
  select id into v_plan from public.membership_plans where plan_code = 'GOLD';
  insert into public.memberships (user_id, plan_id, status, start_date, end_date, total_credits, reschedules_allowed, reschedules_used)
    values (a, v_plan, 'active', current_date, current_date + 29, 8, 2, 0) returning id into v_mem;
  select id into v_sess from public.class_sessions where session_date > current_date and status = 'open' order by session_date limit 1;
  insert into public.bookings (user_id, membership_id, session_id, status) values (a, v_mem, v_sess, 'confirmed') returning id into v_book;
  insert into public.attendance (booking_id, status, marked_by, notes) values (v_book, 'present', adm, 'secret-staff-note');

  v_exp := pg_temp.q_as(a, $q$select public.export_my_data()::text$q$);
  perform pg_temp.must(v_exp not like 'ERR:%', 'A exports their data: ' || left(v_exp, 80));
  perform pg_temp.must(v_exp like '%p14-' || left(a::text, 8) || '@example.invalid%', 'the export holds A''s own details');
  perform pg_temp.must(v_exp not like '%secret-staff-note%', 'staff free-text notes are left out of the export');
  perform pg_temp.must(v_exp not like '%p14-' || left(b::text, 8) || '%', 'the export holds nothing about B');
  perform pg_temp.must(jsonb_array_length(v_exp::jsonb -> 'memberships') = 1 and jsonb_array_length(v_exp::jsonb -> 'bookings') = 1, 'A''s membership and booking are in the export');
  perform pg_temp.must(v_exp::jsonb -> 'bookings' -> 0 ->> 'attendance' = 'present', 'attendance status is included');
  perform pg_temp.must(v_exp not like '%ExponentPushToken%', 'phone-alert codes are not exported');
  v_exp_b := pg_temp.q_as(b, $q$select public.export_my_data()::text$q$);
  perform pg_temp.must(v_exp_b not like '%p14-' || left(a::text, 8) || '%' and jsonb_array_length(v_exp_b::jsonb -> 'memberships') = 0, 'B''s export holds none of A''s data');

  perform pg_temp.must_err(pg_temp.q_as(a, format($q$select public.admin_export_member_data(%L)::text$q$, v_req)), 'NOT_AUTHORIZED', 'a member using the admin export');
  perform pg_temp.must_err(pg_temp.q_as(s, format($q$select public.admin_export_member_data(%L)::text$q$, v_req)), 'NOT_AUTHORIZED', 'staff using the admin export');
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select public.admin_export_member_data(%L)::text$q$, v_req)), 'NOT_AN_OPEN_ACCESS_REQUEST', 'admin export for a closed request');
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select public.admin_export_member_data(%L)::text$q$, v_erase)), 'NOT_AN_OPEN_ACCESS_REQUEST', 'admin export for a non-access request');
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select public.admin_export_member_data(%L)::text$q$, gen_random_uuid())), 'REQUEST_NOT_FOUND', 'admin export with no request');
  v := pg_temp.q_as(a, $q$select (public.submit_privacy_request('access', 'Copy please', null)).id::text$q$);
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select public.admin_export_member_data(%L)::text$q$, v::uuid)), 'IDENTITY_NOT_VERIFIED', 'admin producing a copy before the requester is checked');
  perform pg_temp.q_as(adm, format($q$select public.admin_verify_requester_identity(%L, 'email_confirmation', 'Confirmed from the address on file')::text$q$, v::uuid));
  perform pg_temp.must(pg_temp.q_as(adm, format($q$select public.admin_export_member_data(%L)::text$q$, v::uuid)) like '%@example.invalid%', 'admin produces the copy for an open access request');
  perform pg_temp.must((select count(*) from public.audit_logs where action = 'PRIVACY_EXPORT_GENERATED') = 3, 'every export is audited (A, B and the admin copy)');
  perform pg_temp.must(not exists (select 1 from public.audit_logs where action = 'PRIVACY_EXPORT_GENERATED' and coalesce(new_values::text, '') ~* '@|Test Person'), 'the export audit holds no personal data');

  -- ── 10. Retention rules: configurable, off by default, and they delete nothing ──
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select public.admin_set_retention_rule('notifications', 30, 'x', true)::text$q$), 'NOT_AUTHORIZED', 'member setting a retention rule');
  perform pg_temp.must_err(pg_temp.q_as(s, $q$select count(*)::text from public.admin_retention_rules()$q$), 'NOT_AUTHORIZED', 'staff reading retention rules');
  perform pg_temp.must(pg_temp.q_as(adm, $q$select count(*) filter (where status = 'approved')::text from public.admin_retention_rules()$q$) = '0', 'no retention rule is approved by default');
  perform pg_temp.must_err(pg_temp.q_as(adm, $q$select public.admin_set_retention_rule('notifications', null, null, true)::text$q$), 'BASIS_REQUIRED', 'approving a rule with no period and reason');
  perform pg_temp.must_err(pg_temp.q_as(adm, $q$select public.admin_set_retention_rule('notifications', -5, 'x', true)::text$q$), 'INVALID_VALUE', 'a negative period');
  perform pg_temp.must_err(pg_temp.q_as(adm, $q$select public.admin_set_retention_rule('made_up', 30, 'x', true)::text$q$), 'UNKNOWN_CATEGORY', 'an unknown category');
  insert into public.notifications (audience, user_id, type, title, created_at) values ('user', a, 'test_old', 'old', now() - interval '5 days');
  select count(*) into v_nbefore from public.notifications;
  perform pg_temp.must(pg_temp.q_as(adm, $q$select count(*)::text from public.admin_retention_preview() where rows_past_period is not null$q$) = '0', 'preview counts nothing while every rule is unapproved');
  perform pg_temp.q_as(adm, $q$select public.admin_set_retention_rule('notifications', 1, 'Test reason', true)::text$q$);
  perform pg_temp.must(pg_temp.q_as(adm, $q$select rows_past_period::text from public.admin_retention_preview() where category = 'notifications'$q$)::int >= 1, 'preview counts rows past an approved period');
  select count(*) into v_nafter from public.notifications;
  perform pg_temp.must(v_nbefore = v_nafter, 'the preview deleted nothing');

  -- ── 11. Overview, configuration and what the public can see ──────────────
  perform pg_temp.must_err(pg_temp.q_as(s, $q$select public.admin_privacy_overview()::text$q$), 'NOT_AUTHORIZED', 'staff opening the privacy overview');
  update public.profiles set date_of_birth = current_date - interval '10 years' where id = c;
  v := pg_temp.q_as(adm, $q$select public.admin_privacy_overview()::text$q$);
  perform pg_temp.must((v::jsonb ->> 'members_under_18')::int >= 1, 'members under 18 are counted for the parental-consent review');
  perform pg_temp.must((v::jsonb ->> 'requests_open')::int >= 1 and (v::jsonb ->> 'notice_published_version') = '1.0', 'overview shows open requests and the published version');
  perform pg_temp.must_err(pg_temp.q_as(a, $q$select count(*)::text from public.admin_privacy_config()$q$), 'NOT_AUTHORIZED', 'member reading all settings');
  perform pg_temp.must(pg_temp.q_as(adm, $q$select count(*)::text from public.admin_privacy_config()$q$) = '15', 'admin sees all 15 settings');
  perform pg_temp.must(pg_temp.q_as(adm, $q$select count(*)::text from public.privacy_config$q$) = '0', 'the settings table itself is closed to direct reads');
  v := pg_temp.q_as(null, $q$select public.public_privacy_config()::text$q$);
  perform pg_temp.must(v not like '%erasure_%' and v not like '%response_target%' and v not like '%retention%', 'the public details expose no internal switches');

  raise notice 'ALL PHASE 14 CHECKS PASSED';
end $$;

rollback;
