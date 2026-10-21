-- Phase 21 test: admin export data sources (0036). Apply 0016-0036 first. One transaction, ends in ROLLBACK.
-- Test users are @test.org. Prints "ALL PHASE 21 CHECKS PASSED".
-- Role switching is inline (set_config + SET LOCAL ROLE) and no helper is called while impersonating, like phase 12.
begin;

alter table public.profiles disable trigger trg_prevent_privilege_escalation;

create function pg_temp.mkorder(p_user uuid, p_status text) returns uuid language plpgsql as $$
declare v_o uuid;
begin
  insert into public.orders (user_id, status, total_amount, currency) values (p_user, p_status, 100, 'INR') returning id into v_o;
  insert into public.order_items (order_id, product_id, category, name, unit_price, quantity, fulfillment)
    select v_o, (select id from public.store_products limit 1), 'tack', 'Test item', 100, 1, 'IN_STORE_ONLY';
  return v_o;
end $$;

create function pg_temp.must(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL: %', p_msg; end if; end $$;
grant execute on function pg_temp.must(boolean, text) to public;

do $$
declare
  v_adm uuid := gen_random_uuid(); v_stf uuid := gen_random_uuid(); v_mem uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();   -- two memberships, three payments, an order with three items, a phone
  v_b uuid := gen_random_uuid();   -- no membership at all
  v_e uuid := gen_random_uuid();   -- erased account
  v_i uuid := gen_random_uuid();   -- placeholder *.invalid address
  v_gold uuid; v_plat uuid; v_one uuid; v_prod uuid;
  v_m1 uuid; v_m2 uuid; v_o1 uuid; v_o2 uuid; v_oi1 uuid;
  v_p_ok1 uuid; v_p_ok2 uuid; v_p_fail uuid; v_p_pend uuid; v_p_ref uuid; v_p_part uuid; v_p_late uuid;
  v_s1 uuid; v_s2 uuid; v_bk1 uuid; v_bk2 uuid; v_sch uuid;
  v_res text; v_n bigint; v_sum jsonb; v_ids uuid[]; v_all int; v_page int; v_seen uuid[] := '{}'; v_off int;
  r record;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select u, 'p21-' || left(u::text, 8) || '@test.org', '{"full_name":"Test Person"}', 'authenticated', 'authenticated'
  from unnest(array[v_adm, v_stf, v_mem, v_a, v_b, v_e, v_i]) u;
  update public.profiles set role = 'admin' where id = v_adm;
  update public.profiles set role = 'staff' where id = v_stf;
  update public.profiles set full_name = 'Asha Rao', phone = '+919800000001' where id = v_a;
  update public.profiles set full_name = '=HYPERLINK("http://x")', phone = '   ' where id = v_b;
  update public.profiles set erased_at = now(), full_name = 'Should Not Show', phone = '+919800000009' where id = v_e;
  update public.profiles set email = 'gone-' || left(v_i::text, 8) || '@erased.invalid' where id = v_i;

  select id into v_gold from public.membership_plans where plan_code = 'GOLD';
  select id into v_plat from public.membership_plans where plan_code = 'PLATINUM';
  select id into v_one from public.membership_plans where name ilike '%one%time%' limit 1;
  select id into v_prod from public.store_products limit 1;

  -- Member A: an expired Gold and a current Platinum (one-to-many on purpose)
  insert into public.memberships (id, user_id, plan_id, status, start_date, end_date, total_credits, credits_remaining, reschedules_allowed, created_at)
    values (gen_random_uuid(), v_a, v_gold, 'expired', current_date - 90, current_date - 60, 8, 0, 2, now() - interval '90 days') returning id into v_m1;
  insert into public.memberships (id, user_id, plan_id, status, start_date, end_date, total_credits, credits_remaining, reschedules_allowed, created_at)
    values (gen_random_uuid(), v_a, v_plat, 'active', current_date - 3, current_date + 27, 15, 11, 2, now() - interval '3 days') returning id into v_m2;

  -- An order with THREE items, paid once (fan-out trap), and a second order
  insert into public.orders (id, user_id, status, total_amount, currency) values (gen_random_uuid(), v_a, 'paid', 18500, 'INR') returning id into v_o1;
  insert into public.order_items (order_id, product_id, category, name, unit_price, quantity, fulfillment, plan_id)
    values (v_o1, v_prod, 'membership', 'Platinum Membership', 18000, 1, 'SERVICE', v_plat),
           (v_o1, v_prod, 'tack', 'Riding Helmet', 300, 1, 'IN_STORE_ONLY', null),
           (v_o1, v_prod, 'tack', 'Gloves', 100, 2, 'IN_STORE_ONLY', null);
  select id into v_oi1 from public.order_items where order_id = v_o1 and category = 'membership';
  update public.memberships set order_item_id = v_oi1 where id = v_m2;
  insert into public.orders (id, user_id, status, total_amount, currency) values (gen_random_uuid(), v_b, 'cancelled', 3000, 'INR') returning id into v_o2;

  insert into public.payments (id, user_id, order_id, gateway, gateway_order_id, gateway_payment_id, amount, currency, status, paid_at, created_at, metadata)
    values (gen_random_uuid(), v_a, v_o1, 'razorpay', 'order_A1', 'pay_A1', 18500, 'INR', 'success', now() - interval '3 days', now() - interval '3 days', '{"secret":"do-not-export","method":"upi"}') returning id into v_p_ok1;
  update public.memberships set payment_id = v_p_ok1 where id = v_m2;
  insert into public.payments (id, user_id, order_id, gateway, gateway_order_id, amount, currency, status, created_at)
    values (gen_random_uuid(), v_b, pg_temp.mkorder(v_b, 'cancelled'), 'razorpay', 'order_B1', 3000, 'INR', 'failed', now() - interval '2 days') returning id into v_p_fail;
  insert into public.payments (id, user_id, order_id, gateway, gateway_order_id, amount, currency, status, created_at)
    values (gen_random_uuid(), v_b, pg_temp.mkorder(v_b, 'cancelled'), 'razorpay', 'order_B2', 3000, 'INR', 'pending', now() - interval '1 day') returning id into v_p_pend;
  insert into public.payments (id, user_id, order_id, gateway, gateway_order_id, gateway_payment_id, amount, currency, status, paid_at, created_at)
    values (gen_random_uuid(), v_a, pg_temp.mkorder(v_a, 'paid'), 'razorpay', 'order_A2', 'pay_A2', 3000, 'INR', 'success', now() - interval '20 days', now() - interval '20 days') returning id into v_p_ok2;
  insert into public.payments (id, user_id, order_id, gateway, gateway_order_id, gateway_payment_id, amount, currency, status, paid_at, created_at)
    values (gen_random_uuid(), v_a, pg_temp.mkorder(v_a, 'paid'), 'razorpay', 'order_A3', 'pay_A3', 5000, 'INR', 'refunded', now() - interval '30 days', now() - interval '30 days') returning id into v_p_ref;
  insert into public.payments (id, user_id, order_id, gateway, gateway_order_id, gateway_payment_id, amount, currency, status, paid_at, created_at)
    values (gen_random_uuid(), v_a, pg_temp.mkorder(v_a, 'paid'), 'razorpay', 'order_A4', 'pay_A4', 2000, 'INR', 'partially_refunded', now() - interval '31 days', now() - interval '31 days') returning id into v_p_part;
  -- IST boundary: 18:45 UTC on day X is 00:15 IST on day X+1
  insert into public.payments (id, user_id, order_id, gateway, gateway_order_id, amount, currency, status, created_at)
    values (gen_random_uuid(), v_a, pg_temp.mkorder(v_a, 'paid'), 'razorpay', 'order_A5', 111, 'INR', 'created', timestamptz '2026-03-10 18:45:00+00') returning id into v_p_late;

  -- credits: the ledger is the authority; remaining on the membership equals its ledger sum
  insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description) values (v_a, v_m2, 15, 'membership_purchase', 't'), (v_a, v_m2, -4, 'booking', 't');

  -- bookings: one single booking, one from a weekly schedule, with attendance
  select id into v_s1 from public.class_sessions where session_date >= current_date + 1 order by session_date, start_time limit 1;
  select id into v_s2 from public.class_sessions where session_date >= current_date + 2 and id <> v_s1 order by session_date, start_time limit 1;
  insert into public.bookings (id, user_id, membership_id, session_id, status, reschedule_count) values (gen_random_uuid(), v_a, v_m2, v_s1, 'confirmed', 1) returning id into v_bk1;
  insert into public.bookings (id, user_id, membership_id, session_id, status) values (gen_random_uuid(), v_a, v_m2, v_s2, 'completed') returning id into v_bk2;
  insert into public.attendance (booking_id, status, marked_by) values (v_bk2, 'present', v_adm);
  insert into public.recurring_schedules (id, user_id, membership_id) values (gen_random_uuid(), v_a, v_m2) returning id into v_sch;
  insert into public.recurring_occurrences (schedule_id, user_id, session_id, booking_id, status) values (v_sch, v_a, v_s2, v_bk2, 'booked');
  -- a schedule PREFERENCE without any booking must never show up as a booking
  insert into public.recurring_schedule_slots (schedule_id, day_of_week, start_time, end_time)
    select v_sch, t.day_of_week, t.start_time, t.end_time from public.schedule_templates t where t.is_active limit 1;

  -- ═══ Authorization: only an administrator ═══
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  begin perform public.admin_report_members(); v_res := 'allowed'; exception when others then v_res := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_res like 'permission denied%', 'anonymous callers cannot execute the report functions: ' || v_res);

  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.admin_report_members(); v_res := 'allowed'; exception when others then v_res := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_res = 'FORBIDDEN', 'a member cannot export members: ' || v_res);
  perform set_config('request.jwt.claims', json_build_object('sub', v_mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.admin_report_payments(); v_res := 'allowed'; exception when others then v_res := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_res = 'FORBIDDEN', 'a member cannot export payments: ' || v_res);

  perform set_config('request.jwt.claims', json_build_object('sub', v_stf, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.admin_report_memberships(); v_res := 'allowed'; exception when others then v_res := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_res = 'FORBIDDEN', 'staff cannot export memberships: ' || v_res);
  perform set_config('request.jwt.claims', json_build_object('sub', v_stf, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.admin_report_bookings(); v_res := 'allowed'; exception when others then v_res := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_res = 'FORBIDDEN', 'staff cannot export bookings: ' || v_res);
  perform set_config('request.jwt.claims', json_build_object('sub', v_stf, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.admin_report_summary('payments'); v_res := 'allowed'; exception when others then v_res := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_res = 'FORBIDDEN', 'staff cannot read the summary: ' || v_res);
  perform set_config('request.jwt.claims', json_build_object('sub', v_stf, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.admin_log_export('payments', 'xlsx', '{}', 1, 'success'); v_res := 'allowed'; exception when others then v_res := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_res = 'FORBIDDEN', 'staff cannot write export audit rows: ' || v_res);
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public._rpt_payments(null, null, null, null); v_res := 'allowed'; exception when others then v_res := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_res like 'permission denied%', 'even an admin cannot call the internal row source directly: ' || v_res);

  -- ═══ From here on: the administrator ═══
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- validation
  begin perform * from public.admin_report_payments(null, null, null, null, 0, 0); v_res := 'ok'; exception when others then v_res := sqlerrm; end;
  perform pg_temp.must(v_res = 'INVALID_LIMIT', 'limit 0 is refused: ' || v_res);
  begin perform * from public.admin_report_payments(null, null, null, null, 501, 0); v_res := 'ok'; exception when others then v_res := sqlerrm; end;
  perform pg_temp.must(v_res = 'INVALID_LIMIT', 'limit 501 is refused: ' || v_res);
  begin perform * from public.admin_report_payments(null, null, null, null, 10, -1); v_res := 'ok'; exception when others then v_res := sqlerrm; end;
  perform pg_temp.must(v_res = 'INVALID_OFFSET', 'a negative offset is refused: ' || v_res);
  begin perform * from public.admin_report_payments('2026-02-01', '2026-01-01'); v_res := 'ok'; exception when others then v_res := sqlerrm; end;
  perform pg_temp.must(v_res = 'INVALID_DATE_RANGE', 'from after to is refused: ' || v_res);
  begin perform * from public.admin_report_payments('1900-01-01', null); v_res := 'ok'; exception when others then v_res := sqlerrm; end;
  perform pg_temp.must(v_res = 'INVALID_DATE_RANGE', 'an absurd date is refused: ' || v_res);
  begin perform * from public.admin_report_payments(null, null, 'paid'); v_res := 'ok'; exception when others then v_res := sqlerrm; end;
  perform pg_temp.must(v_res = 'INVALID_STATUS', 'an unknown payment status is refused: ' || v_res);
  begin perform * from public.admin_report_bookings(null, null, 'success'); v_res := 'ok'; exception when others then v_res := sqlerrm; end;
  perform pg_temp.must(v_res = 'INVALID_STATUS', 'a payment status is not a booking status: ' || v_res);
  begin perform * from public.admin_report_memberships(null, null, null, 'GOLD; drop table x'); v_res := 'ok'; exception when others then v_res := sqlerrm; end;
  perform pg_temp.must(v_res = 'INVALID_PLAN', 'a plan filter with odd characters is refused: ' || v_res);
  begin perform * from public.admin_report_payments(null, null, null, 'x y'); v_res := 'ok'; exception when others then v_res := sqlerrm; end;
  perform pg_temp.must(v_res = 'INVALID_GATEWAY', 'a gateway filter with odd characters is refused: ' || v_res);
  begin perform public.admin_report_summary('nonsense'); v_res := 'ok'; exception when others then v_res := sqlerrm; end;
  perform pg_temp.must(v_res = 'INVALID_REPORT', 'an unknown report is refused: ' || v_res);

  -- ═══ Members: one row per member, current membership chosen without duplicates ═══
  select count(*) into v_n from public.admin_report_members(null, null, null, null, 500, 0) where member_id = v_a;
  perform pg_temp.must(v_n = 1, 'a member with two memberships appears once, got ' || v_n);
  select plan_name, membership_status into r from public.admin_report_members(null, null, null, null, 500, 0) where member_id = v_a;
  perform pg_temp.must(r.plan_name = 'Platinum Membership' and r.membership_status = 'active', 'the active membership is the current one: ' || coalesce(r.plan_name, '-') || '/' || coalesce(r.membership_status, '-'));
  select count(*) into v_n from public.admin_report_members(null, null, null, null, 500, 0) where member_id in (v_adm, v_stf);
  perform pg_temp.must(v_n = 0, 'administrators and staff are not in the member export');
  select count(*) into v_n from public.admin_report_members(null, null, 'none', null, 500, 0) where member_id = v_b;
  perform pg_temp.must(v_n = 1, 'status none lists a member with no membership');
  select count(*) into v_n from public.admin_report_members(null, null, 'active', null, 500, 0) where member_id = v_b;
  perform pg_temp.must(v_n = 0, 'status active excludes a member with no membership');
  select * into r from public.admin_report_members(null, null, null, null, 500, 0) where member_id = v_b;
  perform pg_temp.must(r.phone is null, 'a whitespace-only phone is exported as blank, not invented');
  perform pg_temp.must(r.full_name = '=HYPERLINK("http://x")', 'the stored value is returned unchanged (protection happens when the sheet is written)');
  select * into r from public.admin_report_members(null, null, null, null, 500, 0) where member_id = v_a;
  perform pg_temp.must(r.phone = '+919800000001' and r.full_name = 'Asha Rao', 'a real phone and name are exported as stored');
  select * into r from public.admin_report_members(null, null, null, null, 500, 0) where member_id = v_e;
  perform pg_temp.must(r.full_name is null and r.phone is null and r.email is null, 'an erased account is blank');
  select * into r from public.admin_report_members(null, null, null, null, 500, 0) where member_id = v_i;
  perform pg_temp.must(r.email is null, 'a *.invalid placeholder address is blank');
  select count(*) into v_n from public.admin_report_members(current_date + 1, null, null, null, 500, 0);
  perform pg_temp.must(v_n = 0, 'registration date filter: nobody registered tomorrow');
  select count(*) into v_n from public.admin_report_members(current_date, current_date, null, null, 500, 0) where member_id = v_a;
  perform pg_temp.must(v_n = 1, 'registration date filter includes today');

  -- ═══ Memberships ═══
  select count(*) into v_n from public.admin_report_memberships(null, null, null, null, 500, 0) where member_id = v_a;
  perform pg_temp.must(v_n = 2, 'two memberships, two rows, got ' || v_n);
  select * into r from public.admin_report_memberships(null, null, 'active', 'PLATINUM', 500, 0) where member_id = v_a;
  perform pg_temp.must(r.plan_price = 18000 and r.currency = 'INR', 'plan price and currency come from the plan: ' || coalesce(r.plan_price::text, '-'));
  perform pg_temp.must(r.total_credits = 15 and r.credits_remaining = 11 and r.credits_used = 4, 'credits: 15 total, 11 left, 4 used, got ' || r.total_credits || '/' || r.credits_remaining || '/' || r.credits_used);
  perform pg_temp.must(r.payment_status = 'success' and r.payment_amount = 18500, 'the linked payment status and amount are reported');
  perform pg_temp.must(r.credits_remaining = (select m.credits_remaining from public.memberships m where m.id = v_m2), 'remaining equals the membership''s own balance');
  select count(*) into v_n from public.admin_report_memberships(null, null, null, 'GOLD', 500, 0) where member_id = v_a;
  perform pg_temp.must(v_n = 1, 'plan filter keeps only the Gold membership');
  select count(*) into v_n from public.admin_report_memberships(null, null, 'expired', null, 500, 0) where member_id = v_a;
  perform pg_temp.must(v_n = 1, 'status filter keeps only the expired membership');

  -- ═══ Payments: one row per payment (an order with three items must not triple anything) ═══
  select count(*) into v_n from public.admin_report_payments(null, null, null, null, 500, 0) where member_id = v_a;
  perform pg_temp.must(v_n = 5, 'member A has five payments, five rows (no fan-out from the three-item order), got ' || v_n);
  select * into r from public.admin_report_payments(null, null, 'success', null, 500, 0) where payment_id = v_p_ok1;
  perform pg_temp.must(r.items = 'Gloves x2; Platinum Membership; Riding Helmet', 'items are collapsed into one value: ' || coalesce(r.items, '-'));
  perform pg_temp.must(r.membership_state = 'active', 'membership state comes from the membership made from this order: ' || coalesce(r.membership_state, '-'));
  perform pg_temp.must(r.amount = 18500 and r.currency = 'INR', 'amount is exported as stored (INR, not paise)');
  select count(*) into v_n from public.admin_report_payments(null, null, 'failed', null, 500, 0);
  perform pg_temp.must(v_n >= 1 and not exists (select 1 from public.admin_report_payments(null, null, 'failed', null, 500, 0) where payment_status <> 'failed'), 'status filter returns only failed payments');
  select count(*) into v_n from public.admin_report_payments('2026-03-11', '2026-03-11', null, null, 500, 0) where payment_id = v_p_late;
  perform pg_temp.must(v_n = 1, 'a payment at 00:15 IST on the 11th (18:45 UTC on the 10th) belongs to the 11th');
  select count(*) into v_n from public.admin_report_payments('2026-03-10', '2026-03-10', null, null, 500, 0) where payment_id = v_p_late;
  perform pg_temp.must(v_n = 0, '...and not to the 10th');
  perform pg_temp.must(not exists (select 1 from public.admin_report_payments(null, null, null, null, 500, 0) r2 where r2::text like '%do-not-export%'), 'payment metadata is never exported');

  -- pagination: pages add up to the whole, in a stable order, with no duplicates and a constant total
  select count(*) into v_all from public.admin_report_payments(null, null, null, null, 500, 0);
  v_off := 0; v_seen := '{}';
  loop
    select count(*) into v_page from public.admin_report_payments(null, null, null, null, 3, v_off);
    exit when v_page = 0;
    select v_seen || array_agg(payment_id) into v_seen from public.admin_report_payments(null, null, null, null, 3, v_off);
    perform pg_temp.must((select count(distinct total_count) from public.admin_report_payments(null, null, null, null, 3, v_off)) = 1
                         and (select max(total_count) from public.admin_report_payments(null, null, null, null, 3, v_off)) = v_all, 'total_count is the full filtered count on every page');
    v_off := v_off + 3;
  end loop;
  perform pg_temp.must(coalesce(array_length(v_seen, 1), 0) = v_all and (select count(distinct x) from unnest(v_seen) x) = v_all, 'pages of 3 add up to all ' || v_all || ' payments with no duplicates');

  -- revenue: success only; refunds separate; failed/pending/created never counted
  v_sum := public.admin_report_summary('payments', null, null, null, null, null);
  perform pg_temp.must((v_sum -> 'successful_revenue' ->> 'count')::int = (select count(*) from public.payments where status = 'success'), 'successful revenue count = success payments only');
  perform pg_temp.must((v_sum -> 'successful_revenue' ->> 'amount')::numeric = (select sum(amount) from public.payments where status = 'success'), 'successful revenue amount = success payments only');
  perform pg_temp.must((v_sum -> 'successful_revenue' ->> 'amount')::numeric = 21500, 'successful revenue is 18500 + 3000 = 21500, got ' || (v_sum -> 'successful_revenue' ->> 'amount'));
  perform pg_temp.must((v_sum -> 'refunded_original_amount' ->> 'amount')::numeric = 5000 and (v_sum -> 'partially_refunded_original_amount' ->> 'amount')::numeric = 2000, 'refunded and partially refunded are reported separately, at their original amounts');
  perform pg_temp.must((v_sum -> 'by_status' -> 'failed' ->> 'count')::int >= 1 and (v_sum -> 'by_status' -> 'pending' ->> 'count')::int >= 1, 'failed and pending are visible but are not revenue');
  perform pg_temp.must((v_sum ->> 'total')::int = v_all, 'the summary total equals the report row count');
  v_sum := public.admin_report_summary('payments', null, null, 'failed', null, null);
  perform pg_temp.must((v_sum -> 'successful_revenue' ->> 'amount')::numeric = 0, 'filtering to failed payments shows zero successful revenue');

  -- ═══ Bookings: real reservations only ═══
  select count(*) into v_n from public.admin_report_bookings(null, null, null, null, 500, 0) where member_id = v_a;
  perform pg_temp.must(v_n = 2, 'member A has two bookings; the schedule preference is not a third, got ' || v_n);
  select * into r from public.admin_report_bookings(null, null, null, null, 500, 0) where booking_id = v_bk2;
  perform pg_temp.must(r.recurring_schedule_id = v_sch and r.booking_source = 'Weekly schedule', 'a booking made by a weekly schedule carries the schedule reference');
  perform pg_temp.must(r.attendance_status = 'present', 'attendance is reported');
  select * into r from public.admin_report_bookings(null, null, null, null, 500, 0) where booking_id = v_bk1;
  perform pg_temp.must(r.recurring_schedule_id is null and r.booking_source = 'Single booking' and r.reschedule_count = 1 and r.attendance_status is null, 'a single booking has no schedule reference and no attendance yet');
  perform pg_temp.must(r.weekday = trim(to_char(r.session_date, 'FMDay')) and r.plan_name = 'Platinum Membership', 'weekday and membership type are right');
  select count(*) into v_n from public.admin_report_bookings(null, null, 'completed', 'PLATINUM', 500, 0) where member_id = v_a;
  perform pg_temp.must(v_n = 1, 'booking status and plan filters combine');
  perform pg_temp.must(position('horse' in lower(pg_get_function_result('public.admin_report_bookings(date,date,text,text,int,int)'::regprocedure))) = 0, 'no horse column in the booking report');

  -- summary equals the report for every type
  perform pg_temp.must((public.admin_report_summary('members') ->> 'total')::bigint = (select max(total_count) from public.admin_report_members(null, null, null, null, 1, 0)), 'members summary = report total');
  perform pg_temp.must((public.admin_report_summary('memberships') ->> 'total')::bigint = (select max(total_count) from public.admin_report_memberships(null, null, null, null, 1, 0)), 'memberships summary = report total');
  perform pg_temp.must((public.admin_report_summary('bookings') ->> 'total')::bigint = (select max(total_count) from public.admin_report_bookings(null, null, null, null, 1, 0)), 'bookings summary = report total');
  perform pg_temp.must((public.admin_report_summary('memberships') ->> 'credits_remaining')::bigint = (select coalesce(sum(credits_remaining), 0) from public.memberships), 'credit totals equal the memberships'' own balances');
  perform pg_temp.must((public.admin_report_summary('members', null, null, 'none') ->> 'total')::bigint >= 1, 'members summary honours the none filter');
  -- empty dataset
  perform pg_temp.must((public.admin_report_summary('payments', '2099-01-01', '2099-01-02') ->> 'total')::int = 0, 'an empty date range summarises to zero');
  perform pg_temp.must((select count(*) from public.admin_report_payments('2099-01-01', '2099-01-02')) = 0, 'an empty date range returns no rows');

  -- ═══ Audit: metadata only ═══
  perform public.admin_log_export('payments', 'pdf', jsonb_build_object('status', 'failed', 'from', '2026-01-01', 'email', 'a@b.org', 'status2', 'x', 'plan', 'GOLD; drop', 'notes', jsonb_build_object('name', 'Asha Rao')), 42, 'success');
  perform public.admin_log_export('combined', 'xlsx', null, 7, 'failure');
  reset role;
  select * into r from public.audit_logs where table_name = 'admin_exports' and new_values ->> 'report' = 'payments' and performed_by = v_adm;
  perform pg_temp.must(r.action = 'REPORT_EXPORT' and r.record_id = v_adm, 'the export is audited against the administrator');
  perform pg_temp.must(r.new_values ->> 'format' = 'pdf' and (r.new_values ->> 'rows')::int = 42 and r.new_values ->> 'outcome' = 'success', 'format, row count and outcome are recorded');
  perform pg_temp.must(r.new_values -> 'filters' = jsonb_build_object('status', 'failed', 'from', '2026-01-01'), 'only known, plain filter values are kept: ' || (r.new_values -> 'filters')::text);
  perform pg_temp.must(r.new_values::text not like '%a@b.org%' and r.new_values::text not like '%Asha%' and r.new_values::text not like '%drop%', 'no email, name or odd text reaches the audit log');
  perform pg_temp.must((select count(*) from public.audit_logs where table_name = 'admin_exports' and new_values ->> 'outcome' = 'failure') = 1, 'a failed export is audited too');
  perform set_config('request.jwt.claims', json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.admin_log_export('payments', 'csv', '{}', 1, 'success'); v_res := 'ok'; exception when others then v_res := sqlerrm; end;
  perform pg_temp.must(v_res = 'INVALID_FORMAT', 'an unknown format is refused');
  begin perform public.admin_log_export('secrets', 'pdf', '{}', 1, 'success'); v_res := 'ok'; exception when others then v_res := sqlerrm; end;
  perform pg_temp.must(v_res = 'INVALID_REPORT', 'an unknown report is refused');
  begin perform public.admin_log_export('payments', 'pdf', '{}', 1, 'maybe'); v_res := 'ok'; exception when others then v_res := sqlerrm; end;
  perform pg_temp.must(v_res = 'INVALID_OUTCOME', 'an unknown outcome is refused');
  reset role;

  -- reading changed nothing
  perform pg_temp.must((select count(*) from public.payments where user_id in (v_a, v_b)) = 7, 'no payment was created or removed by the reports');

  raise notice 'ALL PHASE 21 CHECKS PASSED';
end $$;

rollback;
