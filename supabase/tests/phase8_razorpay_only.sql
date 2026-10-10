-- Phase 8 test: Razorpay is the only way to pay. NOT YET RUN.
-- Apply 0023_razorpay_only.sql first, then run this in the SQL Editor.
-- One transaction, ends in ROLLBACK (nothing persists, no real payment is made:
-- the "payments" here are calls to the same database function the server uses
-- after Razorpay has confirmed one). A failed check aborts with "FAIL: ...";
-- success prints "ALL PHASE 8 CHECKS PASSED".
--
-- Harness rule: role switching is done inline (set_config + SET LOCAL ROLE / RESET
-- ROLE). No helper functions are called while impersonating.

begin;

-- Test-only: allow promoting the throwaway admin inside this transaction.
alter table public.profiles disable trigger trg_prevent_privilege_escalation;

do $$
declare
  v_u1 uuid := gen_random_uuid();      -- pays after the order timed out
  v_u2 uuid := gen_random_uuid();      -- pays an order staff had cancelled
  v_u3 uuid := gen_random_uuid();      -- pays normally
  v_admin uuid := gen_random_uuid();
  v_gold uuid; v_one uuid;
  v_gold_classes int; v_one_classes int;
  v_o1 record; v_o2 record; v_o3 record;
  v_n int;
begin
  -- no order can be marked paid by hand any more --------------------------------
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'admin_mark_order_paid') then
    raise exception 'FAIL: admin_mark_order_paid() still exists'; end if;
  if (select value from public.system_settings where key = 'online_payments_enabled') is distinct from 'true'::jsonb then
    raise exception 'FAIL: online_payments_enabled should be true'; end if;

  -- people and products ----------------------------------------------------------
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select u, 'p8-' || left(u::text, 8) || '@test.invalid', '{"full_name":"Test Payer"}', 'authenticated', 'authenticated'
  from unnest(array[v_u1, v_u2, v_u3, v_admin]) u;
  update public.profiles set role = 'admin' where id = v_admin;

  select id into v_gold from public.store_products where sku = 'MEM_GOLD';
  select id into v_one  from public.store_products where sku = 'MEM_ONE_TIME_RIDE';
  select class_credits into v_gold_classes from public.membership_plans where plan_code = 'GOLD';
  select class_credits into v_one_classes  from public.membership_plans where plan_code = 'ONE_TIME_RIDE';
  if v_gold is null or v_one is null or v_gold_classes is null or v_one_classes is null then
    raise exception 'FAIL: need the Gold and One-Time Ride products and plans'; end if;

  -- three customers each start an order and open the payment window --------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_u1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into v_o1 from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_gold, 'quantity', 1)));
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_u2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into v_o2 from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_one, 'quantity', 1)));
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_u3, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into v_o3 from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_one, 'quantity', 1)));
  reset role;
  perform set_config('request.jwt.claims', '', true);

  update public.payments set gateway_order_id = 'order_p8_1' where id = v_o1.payment_id;
  update public.payments set gateway_order_id = 'order_p8_2' where id = v_o2.payment_id;
  update public.payments set gateway_order_id = 'order_p8_3' where id = v_o3.payment_id;
  if (select count(*) from public.orders where id in (v_o1.order_id, v_o2.order_id, v_o3.order_id) and status = 'pending') <> 3 then
    raise exception 'FAIL: new orders should start as pending'; end if;

  -- 1. an order nobody pays is cancelled, even though its payment window was opened
  update public.orders set created_at = now() - interval '30 days' where id = v_o1.order_id;
  perform public.expire_stale_orders();
  if (select status from public.orders where id = v_o1.order_id) <> 'cancelled' then
    raise exception 'FAIL: an old unpaid order with a started payment should be cancelled'; end if;
  if (select status from public.payments where id = v_o1.payment_id) <> 'expired' then
    raise exception 'FAIL: its payment should be marked expired'; end if;
  if (select status from public.orders where id = v_o3.order_id) <> 'pending' then
    raise exception 'FAIL: a fresh unpaid order must not be cancelled'; end if;

  -- 2. the customer's payment then arrives: the order is reopened and fulfilled
  perform public.process_payment_webhook('evt_p8_1', 'payment.captured', 'order_p8_1', 'pay_p8_1', 'success', v_o1.total_amount, 'INR');
  if (select status from public.orders where id = v_o1.order_id) <> 'paid' then
    raise exception 'FAIL: a payment for a timed-out order should reopen and pay it'; end if;
  if (select status from public.payments where id = v_o1.payment_id) <> 'success' then
    raise exception 'FAIL: that payment should be recorded as successful'; end if;
  if (select count(*) from public.memberships where user_id = v_u1 and status = 'active') <> 1
     or (select coalesce(sum(amount), 0) from public.credit_ledger where user_id = v_u1) <> v_gold_classes then
    raise exception 'FAIL: the late payer should have one active Gold plan with its classes'; end if;

  -- the same confirmation delivered twice changes nothing
  perform public.process_payment_webhook('evt_p8_1', 'payment.captured', 'order_p8_1', 'pay_p8_1', 'success', v_o1.total_amount, 'INR');
  perform public.process_payment_webhook('evt_p8_1b', 'payment.captured', 'order_p8_1', 'pay_p8_1', 'success', v_o1.total_amount, 'INR');
  if (select count(*) from public.memberships where user_id = v_u1) <> 1
     or (select coalesce(sum(amount), 0) from public.credit_ledger where user_id = v_u1) <> v_gold_classes then
    raise exception 'FAIL: a repeated confirmation must not give a second plan or more classes'; end if;

  -- 3. staff cancel an order, then its payment arrives: nothing is given, a refund is flagged
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_set_order_status(v_o2.order_id, 'cancelled');
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform public.process_payment_webhook('evt_p8_2', 'payment.captured', 'order_p8_2', 'pay_p8_2', 'success', v_o2.total_amount, 'INR');
  if (select status from public.orders where id = v_o2.order_id) <> 'cancelled' then
    raise exception 'FAIL: an order staff cancelled must stay cancelled'; end if;
  if exists (select 1 from public.memberships where user_id = v_u2) then
    raise exception 'FAIL: no plan may be given for an order staff cancelled'; end if;
  if (select status from public.payments where id = v_o2.payment_id) <> 'success' then
    raise exception 'FAIL: the money received must still be recorded'; end if;
  if not exists (select 1 from public.audit_logs where action = 'PAYMENT_FOR_CLOSED_ORDER' and record_id = v_o2.payment_id) then
    raise exception 'FAIL: the payment for a cancelled order was not written to the audit log'; end if;
  select count(*) into v_n from public.notifications
  where type = 'payment_needs_refund' and data ->> 'order_id' = v_o2.order_id::text;
  if v_n <> 2 then raise exception 'FAIL: staff and the customer should both be told about the refund (saw %)', v_n; end if;

  -- 4. the ordinary case still works: pay, and the plan starts
  perform public.process_payment_webhook('evt_p8_3', 'payment.captured', 'order_p8_3', 'pay_p8_3', 'success', v_o3.total_amount, 'INR');
  if (select status from public.orders where id = v_o3.order_id) <> 'paid' then
    raise exception 'FAIL: a normal payment should mark the order paid'; end if;
  if (select count(*) from public.memberships where user_id = v_u3 and status = 'active') <> 1
     or (select coalesce(sum(amount), 0) from public.credit_ledger where user_id = v_u3) <> v_one_classes then
    raise exception 'FAIL: a normal payment should start the plan with its classes'; end if;
  if exists (select 1 from public.notifications where type = 'payment_needs_refund' and data ->> 'order_id' in (v_o1.order_id::text, v_o3.order_id::text)) then
    raise exception 'FAIL: a refund was flagged for an order that was paid properly'; end if;

  -- 5. a wrong amount never pays an order (unchanged rule, checked again)
  perform set_config('request.jwt.claims', json_build_object('sub', v_u2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select * into v_o2 from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_one, 'quantity', 1)));
  reset role;
  perform set_config('request.jwt.claims', '', true);
  update public.payments set gateway_order_id = 'order_p8_4' where id = v_o2.payment_id;
  perform public.process_payment_webhook('evt_p8_4', 'payment.captured', 'order_p8_4', 'pay_p8_4', 'success', 1, 'INR');
  if (select status from public.orders where id = v_o2.order_id) <> 'pending' or exists (select 1 from public.memberships where user_id = v_u2) then
    raise exception 'FAIL: a payment of the wrong amount must not pay the order'; end if;

  raise notice 'ALL PHASE 8 CHECKS PASSED';
end $$;

rollback;
