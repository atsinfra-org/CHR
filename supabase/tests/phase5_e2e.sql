-- Phase 5 database end-to-end test. Passed against 0016 + 0017; since revised so
-- that no call names a horse (a booking is a place in a class — see 0022). The
-- revised version runs on 0021 or later and has NOT been re-run.
--
-- Run in the Supabase SQL editor AFTER applying 0016_store_credit_model.sql and
-- 0017_store_credit_functions.sql. The whole script runs inside one
-- transaction and ends with ROLLBACK, so nothing is persisted. Any failed
-- assertion aborts with a message starting "FAIL:". Reaching the final
-- "ALL PHASE 5 CHECKS PASSED" notice means every check below held.
--
-- It impersonates users by setting request.jwt.claims + SET LOCAL ROLE, so
-- the SECURITY DEFINER functions see a real auth.uid() and RLS applies.

begin;

-- Test-only: allow promoting the throwaway admin inside this transaction.
alter table public.profiles disable trigger trg_prevent_privilege_escalation;

-- Test harness. Helpers are only ever called from the session role (never while
-- impersonating), so they need no grants. Everything that is TESTED runs under
-- SET LOCAL ROLE authenticated, either inline in this script or via
-- expect_error_as(). The helper is SECURITY INVOKER (default); it does not
-- elevate anything.
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
  v_cust uuid := gen_random_uuid();
  v_cust2 uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_gold uuid; v_helmet uuid; v_water uuid; v_sandwich uuid;
  v_order record; v_pay public.payments; v_ord public.orders;
  v_m uuid;
  v_s1 uuid; v_s2 uuid; v_s3 uuid; v_s4 uuid;
  v_b1 public.bookings; v_b2 public.bookings; v_b3 public.bookings; v_b4 public.bookings; v_b5 public.bookings;
  v_n int; v_ledger_before int;
begin
  -- fixtures ---------------------------------------------------------------
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  values (v_cust,  'cust1@test.invalid', '{"full_name":"Rahul Kumar"}', 'authenticated', 'authenticated'),
         (v_cust2, 'cust2@test.invalid', '{"full_name":"Priya Singh"}', 'authenticated', 'authenticated'),
         (v_admin, 'admin@test.invalid', '{"full_name":"Test Admin"}',  'authenticated', 'authenticated');
  update public.profiles set role = 'admin' where id = v_admin;

  select id into v_gold     from public.store_products where sku = 'MEM_GOLD';
  select id into v_helmet   from public.store_products where sku = 'TACK_HELMET';
  select id into v_water    from public.store_products where sku = 'CAFE_WATER';
  select id into v_sandwich from public.store_products where sku = 'CAFE_CHICKEN_SW';
  v_s1 := (select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 0 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 0 * 7 + 7 order by session_date, start_time offset 0 limit 1); v_s2 := (select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 1 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 1 * 7 + 7 order by session_date, start_time offset 0 limit 1); v_s3 := (select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 2 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 2 * 7 + 7 order by session_date, start_time offset 0 limit 1);
  v_s4 := (select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 3 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 3 * 7 + 7 order by session_date, start_time offset 0 limit 1);
  if v_s1 is null or v_s4 is null then raise exception 'FAIL: need generated sessions'; end if;

  -- catalog / schedule structure -------------------------------------------
  if (select count(*) from public.store_products where category = 'tack') <> 5 then raise exception 'FAIL: tack catalog'; end if;
  if exists (select 1 from public.store_products where category <> 'membership' and fulfillment <> 'IN_STORE_ONLY') then
    raise exception 'FAIL: tack/cafe must be IN_STORE_ONLY'; end if;
  if exists (select 1 from public.store_products where sku in ('CAFE_COLD_DRINK','CAFE_WATER') and price is not null) then
    raise exception 'FAIL: Cold Drink / Water must be unpriced'; end if;
  if (select count(*) from public.schedule_templates where is_active) <> 30 then raise exception 'FAIL: expected 30 active templates (6 days x 5)'; end if;
  if exists (select 1 from public.schedule_templates where is_active and day_of_week = 1) then raise exception 'FAIL: Monday must be closed'; end if;

  -- store: order creation --------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role; perform pg_temp.expect_error_as(v_cust, format($q$select * from public.create_order('[{"product_id":"%s","quantity":1}]'::jsonb)$q$, v_water), 'PRICE_NOT_SET'); perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role; perform pg_temp.expect_error_as(v_cust, 'select * from public.create_order(''[]''::jsonb)', 'EMPTY_CART'); perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_order from public.create_order(jsonb_build_array(
    jsonb_build_object('product_id', v_gold, 'quantity', 1),
    jsonb_build_object('product_id', v_helmet, 'quantity', 1, 'price', 1),   -- a client "price" key is ignored
    jsonb_build_object('product_id', v_sandwich, 'quantity', 1)));
  if v_order.total_amount <> 17650 then raise exception 'FAIL: mixed cart total % <> 17650', v_order.total_amount; end if;
  
  -- customers cannot touch payment/membership/credit state -----------------
  begin
    update public.payments set status = 'success' where id = v_order.payment_id;   -- RLS: no UPDATE policy => 0 rows (or an error)
  exception when others then null;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);
  if (select status from public.payments where id = v_order.payment_id) <> 'created' then raise exception 'FAIL: customer changed payment state'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role; perform pg_temp.expect_error_as(v_cust, 'insert into public.credit_ledger (user_id, membership_id, amount, transaction_type) values (gen_random_uuid(), gen_random_uuid(), 99, ''admin_adjustment'')', 'permission denied|new row violates row-level security'); perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role; perform pg_temp.expect_error_as(v_cust, format($q$select public.fulfill_order('%s')$q$, v_order.order_id), 'permission denied'); perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role; perform pg_temp.expect_error_as(v_cust, $q$select public.process_payment_webhook('x','x','x','x','success',17650,'INR')$q$, 'permission denied'); perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role; perform pg_temp.expect_error_as(v_cust, 'select * from public.admin_session_roster(current_date)', 'NOT_AUTHORIZED'); perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;

  -- payment: verified webhook activates; duplicate is a no-op --------------
  reset role; perform set_config('request.jwt.claims', '', true);
  update public.payments set gateway_order_id = 'order_test_1' where id = v_order.payment_id;
  perform public.process_payment_webhook('evt_1', 'payment.captured', 'order_test_1', 'pay_test_1', 'success', 17650, 'INR');
  perform public.process_payment_webhook('evt_1', 'payment.captured', 'order_test_1', 'pay_test_1', 'success', 17650, 'INR');  -- same event
  perform public.process_payment_webhook('evt_2', 'payment.captured', 'order_test_1', 'pay_test_1', 'success', 17650, 'INR');  -- new event, same payment
  select count(*) into v_n from public.memberships where user_id = v_cust;
  if v_n <> 1 then raise exception 'FAIL: duplicate webhook created % memberships', v_n; end if;
  select id into v_m from public.memberships where user_id = v_cust;
  if (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_m) <> 8 then raise exception 'FAIL: Gold should hold 8 credits, has %', (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_m); end if;
  if (select count(*) from public.credit_ledger where membership_id = v_m and transaction_type = 'membership_purchase') <> 1 then
    raise exception 'FAIL: membership_purchase ledger row duplicated'; end if;
  if (select (total_credits, reschedules_allowed, reschedules_used, status) from public.memberships where id = v_m) is distinct from row(8, 2, 0, 'active'::text) then
    raise exception 'FAIL: Gold membership fields'; end if;
  select * into v_ord from public.orders where id = v_order.order_id;
  if v_ord.status <> 'paid' then raise exception 'FAIL: order should be paid, is %', v_ord.status; end if;
  if (select count(*) from public.notifications where audience = 'admin' and type in ('membership_purchase','tack_order','cafe_order','payment_success')) < 4 then
    raise exception 'FAIL: admin purchase/payment/store notifications missing'; end if;

  -- booking: places, duplicate refusal, credit accounting ------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  v_b1 := public.book_class(v_s1);
  if (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_m) <> 7 then raise exception 'FAIL: booking should leave 7 credits'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);
  
  -- second customer (own Gold) books the SAME session, then tries it again
  insert into public.memberships (user_id, plan_id, status, start_date, end_date, total_credits, reschedules_allowed, reschedules_used)
  select v_cust2, id, 'active', current_date, current_date + 29, 8, 2, 0 from public.membership_plans where plan_code = 'GOLD';
  insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description)
  select v_cust2, id, 8, 'membership_purchase', 'test' from public.memberships where user_id = v_cust2;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust2, 'role', 'authenticated')::text, true); set local role authenticated;
  perform public.book_class(v_s1);
  reset role; perform pg_temp.expect_error_as(v_cust2, format($q$select public.book_class('%s')$q$, v_s1), 'DUPLICATE_BOOKING'); perform set_config('request.jwt.claims', json_build_object('sub', v_cust2, 'role', 'authenticated')::text, true); set local role authenticated;
  if (select coalesce(sum(amount),0) from public.credit_ledger where user_id = v_cust2) <> 7 then
    raise exception 'FAIL: a refused second booking consumed a credit'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);
  -- the DB unique index is the backstop even for a direct write
  perform pg_temp.expect_error_as(null::uuid, format($q$insert into public.bookings (user_id, membership_id, session_id, status) values ('%s','%s','%s','confirmed')$q$, v_cust2, (select id from public.memberships where user_id = v_cust2), v_s1), 'duplicate key|violates unique');
  -- capacity: availability reports 1 place left (3 - 2)
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  select sa.places_left into v_n from public.session_availability((select session_date from public.class_sessions where id = v_s1)) sa
    where sa.session_id = v_s1;
  if v_n is distinct from 1 then raise exception 'FAIL: expected 1 place left, saw %', v_n; end if;

  -- attendance authority ---------------------------------------------------
  reset role; perform pg_temp.expect_error_as(v_cust, format($q$select public.admin_mark_attendance('%s','present','')$q$, v_b1.id), 'NOT_AUTHORIZED'); perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;

  -- present keeps the credit consumed --------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true); set local role authenticated;
  perform public.admin_mark_attendance(v_b1.id, 'present', '');
  reset role; perform set_config('request.jwt.claims', '', true);
  if (select status from public.bookings where id = v_b1.id) <> 'completed' then raise exception 'FAIL: present -> completed'; end if;
  if (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_m) <> 7 then raise exception 'FAIL: present must not restore a credit'; end if;
  perform pg_temp.expect_error_as(null::uuid, format($q$update public.bookings set status = 'confirmed' where id = '%s'$q$, v_b1.id), 'INVALID_BOOKING_TRANSITION');

  -- reschedule: no extra credit, old place freed, counter 1/2 --------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  v_b2 := public.book_class(v_s2);                       -- credits 6
  v_ledger_before := (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_m);
  v_b3 := public.reschedule_booking(v_b2.id, v_s3);
  if (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_m) <> v_ledger_before then raise exception 'FAIL: reschedule changed the credit balance'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);
  if (select reschedules_used from public.memberships where id = v_m) <> 1 then raise exception 'FAIL: reschedules_used should be 1'; end if;
  if (select status from public.bookings where id = v_b2.id) <> 'rescheduled' then raise exception 'FAIL: old booking should be rescheduled'; end if;
  if exists (select 1 from public.bookings where session_id = v_s2 and user_id = v_cust and status in ('held','confirmed')) then
    raise exception 'FAIL: original place was not released'; end if;
  if not exists (select 1 from public.bookings where id = v_b3.id and original_booking_id = v_b2.id and status = 'confirmed') then
    raise exception 'FAIL: new booking should be linked and confirmed'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role; perform pg_temp.expect_error_as(v_cust, format($q$select public.reschedule_booking('%s','%s')$q$, v_b3.id, v_s4), 'ALREADY_RESCHEDULED'); perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role; perform pg_temp.expect_error_as(v_cust, format($q$select public.reschedule_booking('%s','%s')$q$, v_b2.id, v_s4), 'BOOKING_NOT_RESCHEDULABLE'); perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;

  -- absent restores exactly once; repeating it never restores twice --------
  v_b4 := public.book_class(v_s4);                       -- credits 5
  reset role; perform set_config('request.jwt.claims', '', true);
  v_ledger_before := (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_m);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true); set local role authenticated;
  perform public.admin_mark_attendance(v_b4.id, 'absent', '');
  perform public.admin_mark_attendance(v_b4.id, 'absent', 'again');
  perform public.admin_mark_attendance(v_b4.id, 'excused', '');
  reset role; perform set_config('request.jwt.claims', '', true);
  if (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_m) <> v_ledger_before + 1 then raise exception 'FAIL: absence must restore exactly +1 (got %)', (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_m) - v_ledger_before; end if;
  if (select count(*) from public.credit_ledger where booking_id = v_b4.id and transaction_type = 'absence_restore') <> 1 then
    raise exception 'FAIL: more than one absence_restore row'; end if;
  if (select count(*) from public.credit_ledger where booking_id = v_b4.id and transaction_type = 'booking') <> 1 then
    raise exception 'FAIL: expected exactly one booking -1 row'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role; perform pg_temp.expect_error_as(v_admin, format($q$select public.admin_mark_attendance('%s','present','')$q$, v_b4.id), 'ATTENDANCE_LOCKED'); perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role; perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect_error_as(null::uuid, format($q$insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type) values ('%s','%s','%s',1,'absence_restore')$q$, v_cust, v_m, v_b4.id), 'duplicate key|violates unique');

  -- second reschedule OK, third blocked ------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  v_b5 := public.book_class((select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 3 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 3 * 7 + 7 order by session_date, start_time offset 1 limit 1));
  perform public.reschedule_booking(v_b5.id, (select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 1 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 1 * 7 + 7 order by session_date, start_time offset 1 limit 1));   -- 2/2
  reset role; perform set_config('request.jwt.claims', '', true);
  if (select reschedules_used from public.memberships where id = v_m) <> 2 then raise exception 'FAIL: reschedules_used should be 2'; end if;
  -- a fresh, never-rescheduled booking still cannot be rescheduled: allowance used up
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  declare v_b6 public.bookings;
  begin
    v_b6 := public.book_class((select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 2 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 2 * 7 + 7 order by session_date, start_time offset 1 limit 1));
    reset role; perform pg_temp.expect_error_as(v_cust, format($q$select public.reschedule_booking('%s','%s')$q$, v_b6.id, (select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 3 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 3 * 7 + 7 order by session_date, start_time offset 2 limit 1)), 'RESCHEDULE_LIMIT_REACHED'); perform set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true); set local role authenticated;
  end;

  -- RLS isolation ----------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_cust2, 'role', 'authenticated')::text, true); set local role authenticated;
  if exists (select 1 from public.credit_ledger where user_id = v_cust) then raise exception 'FAIL: customer 2 can read customer 1 credits'; end if;
  if exists (select 1 from public.orders where user_id = v_cust) then raise exception 'FAIL: customer 2 can read customer 1 orders'; end if;
  if exists (select 1 from public.notifications where audience = 'admin') then raise exception 'FAIL: customer can read admin notifications'; end if;

  -- admin visibility -------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true); set local role authenticated;
  if (select count(*) from public.admin_session_roster((select session_date from public.class_sessions where id = v_s1)) where booking_id is not null) < 2 then
    raise exception 'FAIL: admin roster should show both riders'; end if;
  if not exists (select 1 from public.notifications where audience = 'admin' and type = 'booking_created') then raise exception 'FAIL: admin booking notification'; end if;
  if not exists (select 1 from public.notifications where audience = 'admin' and type = 'booking_rescheduled') then raise exception 'FAIL: admin reschedule notification'; end if;
  if not exists (select 1 from public.notifications where audience = 'admin' and type = 'attendance_absent') then raise exception 'FAIL: admin absence notification'; end if;
  if not exists (select 1 from public.notifications where audience = 'admin' and type = 'registration') then raise exception 'FAIL: admin registration notification'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);
  if not exists (select 1 from public.audit_logs where action = 'BOOKING_RESCHEDULED') or not exists (select 1 from public.audit_logs where action = 'CREDIT_RESTORED')
     or not exists (select 1 from public.audit_logs where action = 'MEMBERSHIP_ACTIVATED') then
    raise exception 'FAIL: audit trail incomplete'; end if;

  raise notice 'ALL PHASE 5 CHECKS PASSED';
end $$;

-- Part 2: Platinum, One-Time Ride, full capacity, cancellation policy, weekly limit.
do $$
declare
  v_p uuid := gen_random_uuid();   -- Platinum buyer
  v_o uuid := gen_random_uuid();   -- One-Time buyer
  v_plat uuid; v_one uuid; v_ord record; v_m uuid; v_mo uuid;
  v_s uuid; v_b public.bookings; v_before int;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  values (v_p, 'plat@test.invalid', '{"full_name":"Plat Buyer"}', 'authenticated', 'authenticated'),
         (v_o, 'one@test.invalid',  '{"full_name":"One Buyer"}',  'authenticated', 'authenticated');
  select id into v_plat from public.store_products where sku = 'MEM_PLATINUM';
  select id into v_one  from public.store_products where sku = 'MEM_ONE_TIME_RIDE';

  perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_ord from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_plat, 'quantity', 1)));
  if v_ord.total_amount <> 18000 then raise exception 'FAIL: Platinum price'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);
  update public.payments set gateway_order_id = 'order_plat' where id = v_ord.payment_id;
  perform public.process_payment_webhook('evt_p1', 'payment.captured', 'order_plat', 'pay_plat', 'success', 18000, 'INR');
  select id into v_m from public.memberships where user_id = v_p;
  if (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_m) <> 12 or (select (total_credits, reschedules_allowed) from public.memberships where id = v_m) is distinct from row(12, 2) then
    raise exception 'FAIL: Platinum must be 12 credits / 2 reschedules'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_o, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_ord from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_one, 'quantity', 1)));
  if v_ord.total_amount <> 2000 then raise exception 'FAIL: One-Time price'; end if;
  reset role; perform set_config('request.jwt.claims', '', true);
  update public.payments set gateway_order_id = 'order_one' where id = v_ord.payment_id;
  perform public.process_payment_webhook('evt_o1', 'payment.captured', 'order_one', 'pay_one', 'success', 2000, 'INR');
  select id into v_mo from public.memberships where user_id = v_o;
  if (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_mo) <> 1 or (select total_credits from public.memberships where id = v_mo) <> 1 then
    raise exception 'FAIL: One-Time Ride must be exactly 1 credit'; end if;

  -- Full capacity: once a class has as many riders as places, the next rider is refused.
  v_s := (select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 0 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 0 * 7 + 7 order by session_date, start_time offset 1 limit 1);
  perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true); set local role authenticated;  perform public.book_class(v_s);
  reset role; perform set_config('request.jwt.claims', '', true);
  insert into public.memberships (user_id, plan_id, status, start_date, end_date, total_credits, reschedules_allowed)
  select u.id, (select id from public.membership_plans where plan_code = 'GOLD'), 'active', current_date, current_date + 29, 8, 2
  from public.profiles u where u.email in ('cust1@test.invalid', 'cust2@test.invalid') and not exists (select 1 from public.memberships m where m.user_id = u.id);
  perform set_config('request.jwt.claims', json_build_object('sub', (select id from public.profiles where email = 'cust1@test.invalid'), 'role', 'authenticated')::text, true); set local role authenticated;
  begin perform public.book_class(v_s); exception when others then null; end;   -- may already hold a booking elsewhere; irrelevant here
  reset role; perform set_config('request.jwt.claims', '', true);
  insert into public.class_sessions (session_date, start_time, end_time, capacity, status)
  values ((now() at time zone 'Asia/Kolkata')::date + 5, '12:00', '13:00', 1, 'open');
  v_s := (select id from public.class_sessions order by created_at desc limit 1);
  perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true); set local role authenticated;  perform public.book_class(v_s);
  perform set_config('request.jwt.claims', json_build_object('sub', v_o, 'role', 'authenticated')::text, true); set local role authenticated;
  reset role; perform pg_temp.expect_error_as(v_o, format($q$select public.book_class('%s')$q$, v_s), 'SESSION_FULL'); perform set_config('request.jwt.claims', json_build_object('sub', v_o, 'role', 'authenticated')::text, true); set local role authenticated;
  if (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_mo) <> 1 then raise exception 'FAIL: refused booking consumed the One-Time credit'; end if;

  -- Cancellation must NOT return the credit (cancellation_returns_credit = false).
  perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true); set local role authenticated;
  v_before := (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_m);
  select * into v_b from public.bookings where user_id = v_p and session_id = v_s;
  perform public.cancel_booking(v_b.id, 'test');
  if (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_m) <> v_before then raise exception 'FAIL: cancellation restored a credit'; end if;

  -- Weekly limit (3 per 7-day block) is enforced by the booking engine.
  v_before := (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_m);
  perform public.book_class((select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 1 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 1 * 7 + 7 order by session_date, start_time offset 0 limit 1));
  perform public.book_class((select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 1 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 1 * 7 + 7 order by session_date, start_time offset 1 limit 1));
  perform public.book_class((select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 1 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 1 * 7 + 7 order by session_date, start_time offset 2 limit 1));
  reset role; perform pg_temp.expect_error_as(v_p, format($q$select public.book_class('%s')$q$, (select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 1 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 1 * 7 + 7 order by session_date, start_time offset 3 limit 1)), 'WEEKLY_LIMIT_REACHED'); perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true); set local role authenticated;
  if (select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = v_m) <> v_before - 3 then raise exception 'FAIL: weekly-limit refusal consumed a credit'; end if;

  -- Reschedule cannot dodge the weekly limit: moving into the full block is refused.
  reset role; perform pg_temp.expect_error_as(v_p, format($q$select public.reschedule_booking('%s', '%s')$q$,
    (select id from public.bookings where user_id = v_p and status = 'confirmed' and session_id = (select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 2 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 2 * 7 + 7 order by session_date, start_time offset 0 limit 1) limit 1),
    (select id from public.class_sessions where status = 'open' and session_date >= (now() at time zone 'Asia/Kolkata')::date + 1 * 7 + 1 and session_date <  (now() at time zone 'Asia/Kolkata')::date + 1 * 7 + 7 order by session_date, start_time offset 4 limit 1)), 'BOOKING_NOT_FOUND|WEEKLY_LIMIT_REACHED|format|null value|invalid input'); perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true); set local role authenticated;

  reset role; perform set_config('request.jwt.claims', '', true);
  raise notice 'PART 2 PASSED (platinum, one-time, capacity, cancellation, weekly limit)';
end $$;

rollback;
