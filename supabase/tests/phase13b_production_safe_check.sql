-- Phase 13b: behavioural check of the privilege-escalation fix (0028) that is SAFE TO RUN ON THE LIVE DATABASE.
--
-- Differences from phase13_privilege_escalation.sql (which must not be run on production):
--   * It does NOT disable any trigger, so the live safeguard is never switched off, even briefly.
--   * It writes nothing that is kept: everything happens in ONE transaction that always ends in ROLLBACK.
--   * It needs an existing active admin (read, never modified) and creates ONE throwaway auth user
--     (audit-13b-...@example.invalid). The sign-up trigger therefore creates a profile and in-app
--     notifications for that throwaway user; all of it is rolled back and nothing is sent outside the database.
--   * If any check fails, the script raises an exception, the transaction aborts, and nothing is kept.
--
-- Run in the Supabase SQL Editor (it is one script). Expected result on success: the notice
--   "PHASE 13b PASSED: ..." and no rows changed. Without 0028 it FAILS at check 1 with
--   "expected ... but statement succeeded" — that failure is the vulnerability, and nothing is kept either way.
--
-- If you have a staging copy, run it (and phase13) there first.

begin;

create or replace function pg_temp.expect_error_as(p_uid uuid, p_sql text, p_code text) returns void language plpgsql as $$
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    execute p_sql;
  exception when others then
    execute 'reset role';
    if sqlerrm ~ ('^(' || p_code || ')') then return; end if;
    raise exception 'FAIL: expected % but got % (%)', p_code, sqlerrm, p_sql;
  end;
  execute 'reset role';
  raise exception 'FAIL: expected % but statement succeeded (%)', p_code, p_sql;
end $$;

create or replace function pg_temp.expect_ok_as(p_uid uuid, p_sql text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  execute p_sql;
  execute 'reset role';
end $$;

do $$
declare
  v_admin uuid;
  v_admins int;
  v_t uuid := gen_random_uuid();       -- throwaway user
  v_before int;
  v_role text;
begin
  select count(*) into v_admins from public.profiles where role = 'admin' and status = 'active';
  select id into v_admin from public.profiles where role = 'admin' and status = 'active' order by created_at limit 1;
  if v_admin is null then
    raise exception 'PRECONDITION FAILED: no active admin exists, cannot run this check';
  end if;
  select count(*) into v_before from public.profiles;

  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  values (v_t, 'audit-13b-' || v_t || '@example.invalid', '{"full_name":"Audit 13b throwaway"}', 'authenticated', 'authenticated');

  -- Set-up through the LEGITIMATE path only: a real admin makes the throwaway user staff via admin_set_role().
  perform pg_temp.expect_ok_as(v_admin, format('select public.admin_set_role(%L, ''staff'', ''phase13b setup'')', v_t));
  select role into v_role from public.profiles where id = v_t;
  if v_role is distinct from 'staff' then raise exception 'FAIL: set-up did not produce a staff user (got %)', v_role; end if;

  -- 1. THE VULNERABILITY: staff changes their own role to admin directly.
  perform pg_temp.expect_error_as(v_t, format('update public.profiles set role = ''admin'' where id = %L', v_t), 'Only an admin may change role/status');
  -- 2. staff changes their own status.
  perform pg_temp.expect_error_as(v_t, format('update public.profiles set status = ''suspended'' where id = %L', v_t), 'Only an admin may change role/status');
  -- 3. staff tries the intended RPC on themselves.
  perform pg_temp.expect_error_as(v_t, format('select public.admin_set_role(%L, ''admin'', ''self promote'')', v_t), 'NOT_AUTHORIZED');
  -- 4. staff tries to promote ANOTHER profile (the real admin's row is used as the target, which cannot succeed either way).
  perform pg_temp.expect_error_as(v_t, format('select public.admin_set_role(%L, ''admin'', ''promote other'')', v_admin), 'NOT_AUTHORIZED');
  -- 5. ordinary self-service edit still works for the staff user.
  perform pg_temp.expect_ok_as(v_t, format('update public.profiles set full_name = ''Audit 13b renamed'' where id = %L', v_t));
  -- 6. the admin path still works in both directions.
  perform pg_temp.expect_ok_as(v_admin, format('select public.admin_set_role(%L, ''member'', ''phase13b restore'')', v_t));
  perform pg_temp.expect_ok_as(v_admin, format('select public.admin_set_role(%L, ''staff'', ''phase13b again'')', v_t));
  -- 7. an admin may also change status directly (the "Admin updates any profile" path) — unchanged behaviour.
  perform pg_temp.expect_ok_as(v_admin, format('update public.profiles set status = ''suspended'' where id = %L', v_t));
  -- 8. the audit trail for role changes is still written.
  if (select count(*) from public.audit_logs where table_name = 'profiles' and record_id = v_t and action = 'SET_ROLE') < 3 then
    raise exception 'FAIL: admin_set_role did not write its audit rows';
  end if;
  -- 9. the last-admin safeguard is still in force (only meaningful with exactly one admin).
  if v_admins = 1 then
    perform pg_temp.expect_error_as(v_admin, format('select public.admin_set_role(%L, ''member'', ''try to demote last admin'')', v_admin), 'LAST_ADMIN');
  else
    raise notice 'check 9 skipped: % admins exist (last-admin guard only testable with exactly one)', v_admins;
  end if;

  raise notice 'PHASE 13b PASSED: staff cannot self-promote / change status, admin paths, audit trail and last-admin guard intact. (% profiles before; everything is rolled back.)', v_before;
end $$;

rollback;

-- Confirm nothing was kept (should return 0):
select count(*) as leftover_throwaway_users from auth.users where email like 'audit-13b-%@example.invalid';
