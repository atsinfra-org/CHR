-- Phase 13 (DPDP audit, finding P1-01) test: a 'staff' account must NOT be
-- able to grant itself 'admin' by updating its own profiles row directly.
--
-- Run against a local or staging copy, never production. One transaction, ends in
-- ROLLBACK — nothing is kept. Prints "PRIVILEGE ESCALATION CHECKS PASSED" on success.
--
-- Without 0028 applied, check 1 FAILS ("expected ... but statement succeeded"):
-- that failure IS the vulnerability. With 0028 applied, every check passes:
--   1. a 'staff' account cannot promote itself to admin by updating its own row;
--   2. a 'member' cannot change its own role;
--   3. a 'staff' account cannot change its own status either;
--   4. an admin can still change a role through admin_set_role() (the intended path);
--   5. a 'staff' account cannot use admin_set_role() on itself;
--   6. a member's ordinary profile edit (name, phone) still works.

begin;

create or replace function pg_temp.expect_error_as(p_uid uuid, p_sql text, p_code text) returns void language plpgsql as $$
begin
  begin
    if p_uid is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
    end if;
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
  v_member uuid := gen_random_uuid();
  v_staff uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
begin
  -- The signup trigger creates each profile row; roles are then set directly (the
  -- escalation trigger is switched off just for this set-up, and back on below).
  insert into auth.users (id, email, raw_user_meta_data, aud, role) values
    (v_member, 'audit-member@example.invalid', '{"full_name":"Audit Member"}', 'authenticated', 'authenticated'),
    (v_staff,  'audit-staff@example.invalid',  '{"full_name":"Audit Staff"}',  'authenticated', 'authenticated'),
    (v_admin,  'audit-admin@example.invalid',  '{"full_name":"Audit Admin"}',  'authenticated', 'authenticated');

  alter table public.profiles disable trigger trg_prevent_privilege_escalation;
  update public.profiles set role = 'staff' where id = v_staff;
  update public.profiles set role = 'admin' where id = v_admin;
  alter table public.profiles enable trigger trg_prevent_privilege_escalation;

  -- EXPECT 1 (the actual regression test): a 'staff' account updating its
  -- OWN row to role='admin' must be rejected. Before 0028 is applied, this
  -- currently SUCCEEDS (the bug) — expect_error_as will raise FAIL in that
  -- case, which is the correct signal that the fix is not yet in place.
  perform pg_temp.expect_error_as(
    v_staff,
    format('update public.profiles set role = ''admin'' where id = %L', v_staff),
    'Only an admin may change role/status'
  );

  -- EXPECT 2: a 'member' account still cannot change its own role at all
  -- (unaffected by this fix either way — pre-existing correct behaviour).
  perform pg_temp.expect_error_as(
    v_member,
    format('update public.profiles set role = ''staff'' where id = %L', v_member),
    'Only an admin may change role/status|Only staff or admin may change role/status'
  );

  -- EXPECT 3: a genuine 'admin' account changing someone else's role still
  -- works (the legitimate path admin_set_role() relies on must survive).
  perform pg_temp.expect_ok_as(
    v_admin,
    format('update public.profiles set role = ''staff'' where id = %L', v_member)
  );

  -- EXPECT 3b: a 'staff' account cannot change its own status.
  perform pg_temp.expect_error_as(
    v_staff,
    format('update public.profiles set status = ''suspended'' where id = %L', v_staff),
    'Only an admin may change role/status'
  );

  -- EXPECT 4: the intended path still works — an admin changes a role through admin_set_role().
  perform pg_temp.expect_ok_as(
    v_admin,
    format('select public.admin_set_role(%L, ''member'', ''test restore'')', v_member)
  );

  -- EXPECT 5: a 'staff' account cannot use admin_set_role() on itself.
  perform pg_temp.expect_error_as(
    v_staff,
    format('select public.admin_set_role(%L, ''admin'', ''self promote'')', v_staff),
    'NOT_AUTHORIZED'
  );

  -- EXPECT 6: ordinary self-service profile edits are unaffected.
  perform pg_temp.expect_ok_as(
    v_member,
    format('update public.profiles set full_name = ''Audit Member Renamed'', phone = ''0000000000'' where id = %L', v_member)
  );

  raise notice 'PRIVILEGE ESCALATION CHECKS PASSED';
end $$;

rollback;
