-- Phase 11 test: phone-alert device registration, ownership, RLS and the push hand-off.
-- Apply 0026_push_devices.sql first, then run this in the SQL Editor.
-- One transaction, ends in ROLLBACK (nothing persists, and pg_net never sends a
-- request queued inside a rolled-back transaction). A failed check aborts with
-- "FAIL: ..."; success prints "ALL PHASE 11 CHECKS PASSED".
--
-- Harness rule: role switching is done inline (set_config + SET LOCAL ROLE / RESET
-- ROLE). No helper functions are called while impersonating.

begin;

alter table public.profiles disable trigger trg_prevent_privilege_escalation;

do $$
declare
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_t1 text := 'ExponentPushToken[p11-' || left(gen_random_uuid()::text, 8) || ']';
  v_dev uuid;
  v_created timestamptz;
  v_n int;
  v_q0 bigint; v_q1 bigint;
  v_notif uuid;
  v_has_net boolean := to_regclass('net.http_request_queue') is not null;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select u, 'p11-' || left(u::text, 8) || '@test.invalid', '{"full_name":"Test Rider"}', 'authenticated', 'authenticated'
  from unnest(array[v_a, v_b]) u;

  -- 1. Not signed in: refused.
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    perform public.register_push_device(v_t1, 'android', '1.0.0');
    raise exception 'FAIL: registered without a session';
  exception when others then
    if sqlerrm not like 'NOT_AUTHENTICATED%' then raise exception 'FAIL: expected NOT_AUTHENTICATED, got %', sqlerrm; end if;
  end;

  -- 2. A registers; registering again does not duplicate.
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.register_push_device(v_t1, 'android', '1.0.0');
  perform public.register_push_device(v_t1, 'android', '1.0.1');
  reset role;
  select count(*), min(id::text)::uuid, min(created_at) into v_n, v_dev, v_created from public.push_devices where token = v_t1;
  if v_n <> 1 then raise exception 'FAIL: expected 1 device row, got %', v_n; end if;
  if (select user_id from public.push_devices where id = v_dev) <> v_a then raise exception 'FAIL: device not owned by A'; end if;
  if (select app_version from public.push_devices where id = v_dev) <> '1.0.1' then raise exception 'FAIL: app_version not updated'; end if;

  -- 3. Bad input refused.
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.register_push_device('not-a-token', 'android', null);
    raise exception 'FAIL: accepted a malformed token';
  exception when others then
    if sqlerrm not like 'INVALID_TOKEN%' then raise exception 'FAIL: expected INVALID_TOKEN, got %', sqlerrm; end if;
  end;
  begin
    perform public.register_push_device(v_t1, 'windows', null);
    raise exception 'FAIL: accepted an unknown platform';
  exception when others then
    if sqlerrm not like 'INVALID_PLATFORM%' then raise exception 'FAIL: expected INVALID_PLATFORM, got %', sqlerrm; end if;
  end;
  reset role;

  -- 4. Members cannot write device rows directly, or read the delivery ledger.
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.push_devices (user_id, token, platform) values (v_b, 'ExponentPushToken[forged-for-b]', 'android');
    raise exception 'FAIL: direct insert allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.push_devices set user_id = v_b where id = v_dev;
    raise exception 'FAIL: direct update allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.push_deliveries;
    raise exception 'FAIL: member could read push_deliveries';
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- 5. The same phone signs in as B: ownership moves, and its "since" time restarts.
  -- now() is fixed inside this one transaction, so backdate first to see the reset.
  update public.push_devices set created_at = created_at - interval '1 day' where id = v_dev;
  v_created := v_created - interval '1 day';
  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.register_push_device(v_t1, 'android', '1.0.1');
  reset role;
  if (select user_id from public.push_devices where token = v_t1) <> v_b then raise exception 'FAIL: token not moved to B'; end if;
  if (select created_at from public.push_devices where token = v_t1) <= v_created then raise exception 'FAIL: created_at not reset for new owner'; end if;

  -- 6. Isolation: A sees none of B's devices; B sees its own.
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.push_devices;
  reset role;
  if v_n <> 0 then raise exception 'FAIL: A can see % device rows', v_n; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.push_devices;
  reset role;
  if v_n <> 1 then raise exception 'FAIL: B should see 1 device row, saw %', v_n; end if;

  -- 7. A cannot unregister B's phone; B can.
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_n := public.unregister_push_device(v_t1);
  reset role;
  if v_n <> 0 then raise exception 'FAIL: A removed B''s device'; end if;

  -- 8. Delivery ledger: one row per (notification, phone).
  insert into public.notifications (audience, user_id, type, title) values ('user', v_b, 'test_push', 'Test') returning id into v_notif;
  insert into public.push_deliveries (notification_id, device_id) select v_notif, id from public.push_devices where token = v_t1;
  begin
    insert into public.push_deliveries (notification_id, device_id) select v_notif, id from public.push_devices where token = v_t1;
    raise exception 'FAIL: duplicate delivery allowed';
  exception when unique_violation then null;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_n := public.unregister_push_device(v_t1);
  reset role;
  if v_n <> 1 then raise exception 'FAIL: B could not remove own device'; end if;

  -- 9. At most 10 active phones per member.
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  for i in 1..12 loop
    perform public.register_push_device('ExponentPushToken[p11-limit-' || left(v_a::text, 8) || '-' || i || ']', 'android', null);
  end loop;
  reset role;
  select count(*) into v_n from public.push_devices where user_id = v_a and disabled_at is null;
  if v_n <> 10 then raise exception 'FAIL: expected 10 active devices, got %', v_n; end if;

  -- 10. Hand-off: nothing queued without the Vault secrets; one request per member notification
  --     once they exist; none for admin notifications. Notifications always insert.
  if v_has_net then
    if exists (select 1 from vault.decrypted_secrets where name in ('push_send_url', 'push_send_secret')) then
      raise notice 'Vault push secrets already exist: skipping the "not configured" check';
    else
      select count(*) into v_q0 from net.http_request_queue;
      insert into public.notifications (audience, user_id, type, title) values ('user', v_a, 'test_push', 'Test');
      select count(*) into v_q1 from net.http_request_queue;
      if v_q1 <> v_q0 then raise exception 'FAIL: queued a push with no Vault secrets'; end if;
      perform vault.create_secret('https://example.invalid/functions/v1/push-send', 'push_send_url');
      perform vault.create_secret('test-secret', 'push_send_secret');
    end if;
    select count(*) into v_q0 from net.http_request_queue;
    insert into public.notifications (audience, user_id, type, title) values ('user', v_a, 'test_push', 'Test');
    insert into public.notifications (audience, type, title) values ('admin', 'test_push', 'Admin test');
    select count(*) into v_q1 from net.http_request_queue;
    if v_q1 - v_q0 <> 1 then raise exception 'FAIL: expected 1 queued push, got %', v_q1 - v_q0; end if;
  else
    raise notice 'pg_net not installed: hand-off checks skipped';
  end if;

  raise notice 'ALL PHASE 11 CHECKS PASSED';
end $$;

rollback;
