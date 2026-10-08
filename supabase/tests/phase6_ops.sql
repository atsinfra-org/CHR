-- Phase 6 database test. NOT YET RUN — written against 0016 + 0017 + 0018.
-- Apply 0018_phase6_operations.sql first, then run this in the Supabase SQL Editor.
-- One transaction, ends in ROLLBACK (nothing persists). A failed check aborts with
-- "FAIL: ..."; success prints "ALL PHASE 6 CHECKS PASSED".
--
-- Harness rule (learned in Phase 5): helpers are only ever called from the SESSION
-- role. Role switching is done inline (set_config + SET LOCAL ROLE / RESET ROLE);
-- anything that must be tested for a denial goes through expect_error_as(), which
-- impersonates internally. No helper is SECURITY DEFINER and nothing is granted.

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
  v_c uuid := gen_random_uuid();      -- customer
  v_c2 uuid := gen_random_uuid();     -- second customer (old pending order)
  v_a uuid := gen_random_uuid();      -- admin
  v_gold uuid; v_helmet uuid; v_ord record; v_ord2 record; v_ord3 record;
  v_m uuid; v_n int; v_bal int; v_s uuid; v_b public.bookings; v_h uuid; v_plan uuid;
  v_before int; v_val jsonb;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role) values
    (v_c,  'p6c1@test.invalid', '{"full_name":"Customer One"}', 'authenticated', 'authenticated'),
    (v_c2, 'p6c2@test.invalid', '{"full_name":"Customer Two"}', 'authenticated', 'authenticated'),
    (v_a,  'p6a@test.invalid',  '{"full_name":"Admin"}',        'authenticated', 'authenticated');
  update public.profiles set role = 'admin' where id = v_a;

  select id into v_gold   from public.store_products where sku = 'MEM_GOLD';
  select id into v_helmet from public.store_products where sku = 'TACK_HELMET';
  select id into v_h from public.horses where is_active and status = 'available' order by name limit 1;
  select id into v_plan from public.membership_plans where plan_code = 'GOLD';

  -- settings seeded, online payments off by default ------------------------
  if (select value from public.system_settings where key = 'online_payments_enabled') is distinct from 'false'::jsonb then
    raise exception 'FAIL: online_payments_enabled must default to false'; end if;
  if (select count(*) from public.system_settings where key in ('pending_order_expiry_hours','class_reminder_hours','membership_expiry_notice_days')) <> 3 then
    raise exception 'FAIL: lifecycle settings missing'; end if;

  -- customer places a mixed order; it stays PENDING and activates nothing --
  perform set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into v_ord from public.create_order(jsonb_build_array(
    jsonb_build_object('product_id', v_gold, 'quantity', 1), jsonb_build_object('product_id', v_helmet, 'quantity', 1)));
  reset role;
  if (select status from public.orders where id = v_ord.order_id) <> 'pending' then raise exception 'FAIL: new order must be pending'; end if;
  if exists (select 1 from public.memberships where user_id = v_c) then raise exception 'FAIL: membership activated before payment'; end if;

  -- authorization: a customer cannot mark an order paid -------------------
  perform pg_temp.expect_error_as(v_c, format($q$select public.admin_mark_order_paid('%s')$q$, v_ord.order_id), 'NOT_AUTHORIZED');
  if exists (select 1 from public.memberships where user_id = v_c) then raise exception 'FAIL: denied call still activated a membership'; end if;
  perform pg_temp.expect_error_as(v_a, format($q$select public.admin_mark_order_paid('%s', 'razorpay', null)$q$, v_ord.order_id), 'INVALID_PAYMENT_METHOD');

  -- staff/admin marks it paid: fulfilment through the existing path ---------
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_mark_order_paid(v_ord.order_id, 'manual', 'RECEIPT-1');
  perform public.admin_mark_order_paid(v_ord.order_id, 'manual', 'RECEIPT-1');   -- idempotent
  perform public.admin_mark_order_paid(v_ord.order_id, 'manual', 'RECEIPT-2');   -- idempotent, different ref
  reset role;
  select count(*) into v_n from public.memberships where user_id = v_c;
  if v_n <> 1 then raise exception 'FAIL: repeated mark-paid created % memberships', v_n; end if;
  select id into v_m from public.memberships where user_id = v_c;
  select coalesce(sum(amount), 0) into v_bal from public.credit_ledger where membership_id = v_m;
  if v_bal <> 8 then raise exception 'FAIL: Gold must hold exactly 8 credits after repeats (has %)', v_bal; end if;
  if (select status from public.orders where id = v_ord.order_id) <> 'paid' then raise exception 'FAIL: order should be paid'; end if;
  if (select (gateway, status) from public.payments where order_id = v_ord.order_id) is distinct from row('manual'::text, 'success'::text) then
    raise exception 'FAIL: payment should record manual/success'; end if;
  if (select metadata ->> 'reference' from public.payments where order_id = v_ord.order_id) <> 'RECEIPT-1' then
    raise exception 'FAIL: payment reference should be the first confirmation'; end if;
  if not exists (select 1 from public.audit_logs where action = 'ORDER_MARKED_PAID' and record_id = v_ord.order_id and performed_by = v_a) then
    raise exception 'FAIL: mark-paid not audited with actor'; end if;
  if not exists (select 1 from public.notifications where audience = 'user' and user_id = v_c and type = 'membership_activated') then
    raise exception 'FAIL: customer not told membership is active'; end if;

  -- collected/cancelled status changes notify the customer ------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_set_order_status(v_ord.order_id, 'ready_for_collection');
  perform public.admin_set_order_status(v_ord.order_id, 'collected');
  reset role;
  if not exists (select 1 from public.notifications where user_id = v_c and type = 'order_collected') then raise exception 'FAIL: collected notification'; end if;

  -- admin cancel booking follows the credit policy -------------------------
  v_s := (select id from public.class_sessions where status = 'open'
          and session_date >= (now() at time zone 'Asia/Kolkata')::date + 1
          and session_date <  (now() at time zone 'Asia/Kolkata')::date + 7 order by session_date, start_time limit 1);
  perform set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_b := public.book_class(v_s, v_h);
  reset role;
  select coalesce(sum(amount), 0) into v_before from public.credit_ledger where membership_id = v_m;     -- 7
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_cancel_booking(v_b.id, 'weather', null);                                          -- policy: no refund
  reset role;
  select coalesce(sum(amount), 0) into v_bal from public.credit_ledger where membership_id = v_m;
  if v_bal <> v_before then raise exception 'FAIL: admin cancel returned a credit although policy is false'; end if;
  if (select status from public.bookings where id = v_b.id) <> 'cancelled' then raise exception 'FAIL: booking not cancelled'; end if;
  if not exists (select 1 from public.notifications where user_id = v_c and type = 'booking_cancelled') then raise exception 'FAIL: customer not notified of cancel'; end if;
  -- explicit, audited override returns the credit on a second booking
  perform set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_b := public.book_class(v_s, v_h);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_cancel_booking(v_b.id, 'club closed', true);
  reset role;
  select coalesce(sum(amount), 0) into v_bal from public.credit_ledger where membership_id = v_m;
  if v_bal <> v_before then raise exception 'FAIL: override should net to the pre-booking balance (% vs %)', v_bal, v_before; end if;
  perform pg_temp.expect_error_as(v_a, format($q$select public.admin_cancel_booking('%s','again',null)$q$, v_b.id), 'BOOKING_NOT_CANCELLABLE');

  -- settings: validation, authorization, audit ------------------------------
  perform pg_temp.expect_error_as(v_c, $q$select public.admin_update_setting('weekly_class_limit', '4'::jsonb)$q$, 'NOT_AUTHORIZED');
  perform pg_temp.expect_error_as(v_a, $q$select public.admin_update_setting('weekly_class_limit', '0'::jsonb)$q$, 'INVALID_VALUE');
  perform pg_temp.expect_error_as(v_a, $q$select public.admin_update_setting('weekly_class_limit', '"3"'::jsonb)$q$, 'INVALID_VALUE');
  perform pg_temp.expect_error_as(v_a, $q$select public.admin_update_setting('cancellation_returns_credit', '1'::jsonb)$q$, 'INVALID_VALUE');
  perform pg_temp.expect_error_as(v_a, $q$select public.admin_update_setting('booking_window_days', '91'::jsonb)$q$, 'INVALID_VALUE');
  perform pg_temp.expect_error_as(v_a, $q$select public.admin_update_setting('no_such_key', '1'::jsonb)$q$, 'UNKNOWN_SETTING');
  perform pg_temp.expect_error_as(v_a, $q$select public.admin_update_setting('online_payments_enabled', 'true'::jsonb)$q$, 'SETTING_NOT_EDITABLE');
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_update_setting('max_restored_absences', '5'::jsonb);
  perform public.admin_update_setting('max_restored_absences', 'null'::jsonb);   -- back to unlimited
  reset role;
  select value into v_val from public.system_settings where key = 'max_restored_absences';
  if jsonb_typeof(v_val) <> 'null' then raise exception 'FAIL: max_restored_absences should be back to null'; end if;
  if (select count(*) from public.audit_logs where action = 'SETTING_CHANGED') < 2 then raise exception 'FAIL: setting changes not audited'; end if;

  -- plans: initial values intact, edits validated and audited ---------------
  if (select (price, class_credits, reschedules_allowed) from public.membership_plans where plan_code = 'GOLD') is distinct from row(15000::numeric, 8, 2) then raise exception 'FAIL: Gold values changed'; end if;
  if (select (price, class_credits) from public.membership_plans where plan_code = 'PLATINUM') is distinct from row(18000::numeric, 12) then raise exception 'FAIL: Platinum values changed'; end if;
  if (select (price, class_credits) from public.membership_plans where plan_code = 'ONE_TIME_RIDE') is distinct from row(2000::numeric, 1) then raise exception 'FAIL: One-Time values changed'; end if;
  perform pg_temp.expect_error_as(v_c, format($q$select public.admin_update_plan('%s', 15000, 8, 2, true)$q$, v_plan), 'NOT_AUTHORIZED');
  perform pg_temp.expect_error_as(v_a, format($q$select public.admin_update_plan('%s', 0, 8, 2, true)$q$, v_plan), 'INVALID_VALUE');
  perform pg_temp.expect_error_as(v_a, format($q$select public.admin_update_plan('%s', 15000, 0, 2, true)$q$, v_plan), 'INVALID_VALUE');
  perform pg_temp.expect_error_as(v_a, format($q$select public.admin_update_plan('%s', 15000, 8, 99, true)$q$, v_plan), 'INVALID_VALUE');
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_update_plan(v_plan, 16000, 8, 2, true);
  reset role;
  if (select price from public.membership_plans where id = v_plan) <> 16000 then raise exception 'FAIL: plan price not updated'; end if;
  if (select total_credits from public.memberships where id = v_m) <> 8 then raise exception 'FAIL: existing membership must not change when a plan is edited'; end if;
  if not exists (select 1 from public.audit_logs where action = 'PLAN_UPDATED' and record_id = v_plan) then raise exception 'FAIL: plan edit not audited'; end if;

  -- store metrics: staff only ---------------------------------------------
  perform pg_temp.expect_error_as(v_c, 'select * from public.admin_store_metrics()', 'NOT_AUTHORIZED');
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.admin_store_metrics() where active_memberships >= 1 and gold_memberships >= 1 and paid_orders + collected_orders + ready_orders >= 1;
  reset role;
  if v_n <> 1 then raise exception 'FAIL: store metrics did not reflect the new membership/order'; end if;

  -- lifecycle jobs are not callable by clients ------------------------------
  perform pg_temp.expect_error_as(v_c, 'select public.expire_memberships()', 'permission denied');
  perform pg_temp.expect_error_as(v_a, 'select public.expire_stale_orders()', 'permission denied');
  perform pg_temp.expect_error_as(v_a, 'select public.generate_future_sessions()', 'permission denied');
  perform pg_temp.expect_error_as(v_a, 'select public.send_lifecycle_notifications()', 'permission denied');

  -- stale pending orders expire (never delete), fresh ones survive ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_c2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into v_ord2 from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_helmet, 'quantity', 1)));
  select * into v_ord3 from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_helmet, 'quantity', 2)));
  reset role;
  update public.orders set created_at = now() - interval '48 hours' where id = v_ord2.order_id;
  v_n := public.expire_stale_orders();
  if v_n < 1 then raise exception 'FAIL: stale order not expired'; end if;
  if (select status from public.orders where id = v_ord2.order_id) <> 'cancelled' then raise exception 'FAIL: stale order should be cancelled'; end if;
  if (select status from public.payments where order_id = v_ord2.order_id) <> 'expired' then raise exception 'FAIL: stale payment should be expired'; end if;
  if (select status from public.orders where id = v_ord3.order_id) <> 'pending' then raise exception 'FAIL: fresh order must stay pending'; end if;
  -- an order with an online payment already started is left to the gateway
  update public.orders set created_at = now() - interval '48 hours' where id = v_ord3.order_id;
  update public.payments set gateway_order_id = 'order_inflight' where order_id = v_ord3.order_id;
  perform public.expire_stale_orders();
  if (select status from public.orders where id = v_ord3.order_id) <> 'pending' then raise exception 'FAIL: in-flight online payment order was expired'; end if;
  if (select count(*) from public.orders where id in (v_ord2.order_id, v_ord3.order_id)) <> 2 then raise exception 'FAIL: orders must never be deleted'; end if;

  -- memberships expire, credits lapse through the ledger, booking is refused
  update public.memberships set start_date = current_date - 40, end_date = current_date - 1 where id = v_m;
  v_n := public.expire_memberships();
  if v_n <> 1 then raise exception 'FAIL: expected 1 membership expired, got %', v_n; end if;
  if (select status from public.memberships where id = v_m) <> 'expired' then raise exception 'FAIL: membership not expired'; end if;
  if (select coalesce(sum(amount), 0) from public.credit_ledger where membership_id = v_m) <> 0 then raise exception 'FAIL: expired credits should net to 0'; end if;
  if not exists (select 1 from public.credit_ledger where membership_id = v_m and transaction_type = 'expiry' and amount = -7) then raise exception 'FAIL: expiry ledger row missing'; end if;
  if public.expire_memberships() <> 0 then raise exception 'FAIL: expiry must be idempotent'; end if;
  perform pg_temp.expect_error_as(v_c, format($q$select public.book_class('%s','%s')$q$, v_s, v_h), 'NO_ACTIVE_MEMBERSHIP');

  -- session generation: idempotent, correct shape ---------------------------
  perform public.generate_future_sessions();
  if public.generate_future_sessions() <> 0 then raise exception 'FAIL: session generation must not duplicate'; end if;
  if exists (select 1 from public.class_sessions where session_date >= current_date and extract(dow from session_date) = 1) then raise exception 'FAIL: Monday session exists'; end if;
  if exists (select 1 from public.class_sessions where session_date >= current_date and start_time = '06:00') then raise exception 'FAIL: 06:00 session exists'; end if;
  if exists (select 1 from public.class_sessions where session_date >= current_date and capacity <> 3) then raise exception 'FAIL: capacity must stay 3'; end if;

  -- reminders / expiry notices: sent once ---------------------------------
  update public.memberships set status = 'active', end_date = current_date + 2 where id = v_m;
  insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description) values (v_c, v_m, 3, 'admin_adjustment', 'test');
  v_n := public.send_lifecycle_notifications();
  if (select count(*) from public.notifications where user_id = v_c and type = 'membership_expiring') <> 1 then raise exception 'FAIL: expiry notice not sent once'; end if;
  perform public.send_lifecycle_notifications();
  if (select count(*) from public.notifications where user_id = v_c and type = 'membership_expiring') <> 1 then raise exception 'FAIL: expiry notice duplicated'; end if;

  raise notice 'ALL PHASE 6 CHECKS PASSED';
end $$;

rollback;
