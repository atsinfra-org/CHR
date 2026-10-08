-- Phase 6.1 test: a purchased plan stays locked for its validity. NOT YET RUN.
-- Apply 0019_membership_plan_lock.sql first. One transaction, ends in ROLLBACK.
-- Success prints "PLAN LOCK CHECKS PASSED". Harness rules as in phase6_ops.sql.

begin;

alter table public.profiles disable trigger trg_prevent_privilege_escalation;

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

do $$
declare
  v_c uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();
  v_gold uuid; v_plat uuid; v_one uuid; v_gold_plan uuid;
  v_o1 record; v_o2 record; v_m uuid; v_n int; v_row record;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role) values
    (v_c, 'lock1@test.invalid', '{"full_name":"Lock One"}', 'authenticated', 'authenticated'),
    (v_a, 'locka@test.invalid', '{"full_name":"Lock Admin"}', 'authenticated', 'authenticated');
  update public.profiles set role = 'admin' where id = v_a;
  select id into v_gold from public.store_products where sku = 'MEM_GOLD';
  select id into v_plat from public.store_products where sku = 'MEM_PLATINUM';
  select id into v_one  from public.store_products where sku = 'MEM_ONE_TIME_RIDE';
  select id into v_gold_plan from public.membership_plans where plan_code = 'GOLD';

  -- before buying: Gold is purchasable, active_until is null
  perform set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.store_catalog() where sku = 'MEM_GOLD' and is_purchasable and active_until is null;
  if v_n <> 1 then raise exception 'FAIL: Gold should be purchasable before any purchase'; end if;
  -- two pending orders for Gold may exist before payment (nothing is held yet)
  select * into v_o1 from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_gold, 'quantity', 1)));
  select * into v_o2 from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_gold, 'quantity', 1)));
  reset role;

  -- staff confirm the first one
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_mark_order_paid(v_o1.order_id, 'manual', 'R1');
  reset role;
  select id into v_m from public.memberships where user_id = v_c;
  if (select end_date - start_date from public.memberships where id = v_m) <> 29 then raise exception 'FAIL: validity should span 30 days inclusive'; end if;

  -- now Gold is locked in the catalog, with its end date
  perform set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into v_row from public.store_catalog() where sku = 'MEM_GOLD';
  reset role;
  if v_row.is_purchasable or v_row.active_until is distinct from (select end_date from public.memberships where id = v_m) then
    raise exception 'FAIL: Gold must be locked until the membership ends'; end if;

  -- server refuses a new Gold order, even when the classes are all used up
  insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description)
    values (v_c, v_m, -8, 'admin_adjustment', 'test: use all classes');
  perform pg_temp.expect_error_as(v_c, format($q$select * from public.create_order('[{"product_id":"%s","quantity":1}]'::jsonb)$q$, v_gold), 'MEMBERSHIP_ALREADY_ACTIVE');

  -- staff cannot confirm the earlier duplicate pending order
  perform pg_temp.expect_error_as(v_a, format($q$select public.admin_mark_order_paid('%s')$q$, v_o2.order_id), 'MEMBERSHIP_ALREADY_ACTIVE');
  select count(*) into v_n from public.memberships where user_id = v_c;
  if v_n <> 1 then raise exception 'FAIL: a second Gold membership was created'; end if;

  -- other plans are not locked by this rule (they are blocked only while classes remain)
  perform set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.store_catalog() where sku in ('MEM_PLATINUM', 'MEM_ONE_TIME_RIDE') and is_purchasable;
  if v_n <> 2 then raise exception 'FAIL: other plans should stay purchasable'; end if;
  perform * from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_one, 'quantity', 1)));
  reset role;

  -- after the membership ends, the plan unlocks
  update public.memberships set start_date = current_date - 31, end_date = current_date - 1 where id = v_m;
  perform set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.store_catalog() where sku = 'MEM_GOLD' and is_purchasable and active_until is null;
  if v_n <> 1 then raise exception 'FAIL: Gold should unlock the day after it ends'; end if;
  perform * from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_gold, 'quantity', 1)));
  reset role;

  raise notice 'PLAN LOCK CHECKS PASSED';
end $$;

rollback;
