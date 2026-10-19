-- Phase 13 (DPDP audit, finding P1-01) test: a 'staff' account must NOT be
-- able to grant itself 'admin' by updating its own profiles row directly.
--
-- NOT YET RUN. This test was written during a read-only audit that was not
-- permitted to apply migrations to the live database — running it requires
-- 0028_privilege_escalation_fix.sql to already be applied in the target
-- environment (a local/staging database, never production, for a first run).
--
-- Before the fix is applied, EXPECT 1 (the staff self-promotion) to FAIL
-- this test (i.e. the bad UPDATE will succeed, which is the bug). After the
-- fix, EXPECT 1 passes (the UPDATE is rejected) while EXPECT 2 and EXPECT 3
-- (legitimate admin paths) still succeed.
--
-- One transaction, ends in ROLLBACK — never commits anything.

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
  insert into auth.users (id, email) values
    (v_member, 'audit-member@example.invalid'),
    (v_staff, 'audit-staff@example.invalid'),
    (v_admin, 'audit-admin@example.invalid');

  insert into public.profiles (id, full_name, role) values
    (v_member, 'Audit Member', 'member'),
    (v_staff, 'Audit Staff', 'staff'),
    (v_admin, 'Audit Admin', 'admin');

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

  raise notice 'PRIVILEGE ESCALATION CHECKS PASSED';
end $$;

rollback;
