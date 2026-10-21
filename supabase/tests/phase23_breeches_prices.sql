-- Phase 23 test: breeches prices (0037 + 0038) and checkout. Apply 0016-0038 first. One transaction, ends in ROLLBACK.
-- Prints "ALL PHASE 23 CHECKS PASSED".
begin;
alter table public.profiles disable trigger trg_prevent_privilege_escalation;
create function pg_temp.must(p_ok boolean, p_msg text) returns void language plpgsql as $$ begin if p_ok is not true then raise exception 'FAIL: %', p_msg; end if; end $$;
grant execute on function pg_temp.must(boolean, text) to public;

do $$
declare
  u uuid := gen_random_uuid(); v_items jsonb; r record; v_err text; v_pay public.payments; n int;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role) values (u, 'p23@test.org', '{"full_name":"Test Buyer"}', 'authenticated', 'authenticated');

  -- confirmed prices, exactly
  perform pg_temp.must((select jsonb_object_agg(sku, price) from public.store_products where sku like 'TACK\_BREECHES\_%' escape '\') =
    '{"TACK_BREECHES_WOMEN_NAVY": 8000.00, "TACK_BREECHES_WOMEN_RED_BLACK": 4500.00, "TACK_BREECHES_MEN_CHARCOAL": 6000.00,
      "TACK_BREECHES_KIDS_NAVY_PINK": 3600.00, "TACK_BREECHES_KIDS_MAGENTA_FLORAL": 3600.00, "TACK_BREECHES_KIDS_PINK": 3600.00,
      "TACK_BREECHES_KIDS_PURPLE": 3600.00, "TACK_BREECHES_KIDS_BLACK_STARS": 3600.00, "TACK_BREECHES_KIDS_BLACK_CAMO": 3600.00}'::jsonb, 'the nine prices are exactly as confirmed');
  perform pg_temp.must((select not is_active from public.store_products where sku = 'TACK_BREECHES'), 'the old generic Breeches is hidden');
  perform pg_temp.must((select price from public.store_products where sku = 'TACK_HELMET') = 2500, 'other tack prices unchanged');

  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.store_catalog() where sku like 'TACK\_BREECHES\_%' escape '\' and is_purchasable;
  perform pg_temp.must(n = 9, 'all nine are now buyable (' || n || ')');
  perform pg_temp.must(not exists (select 1 from public.store_catalog() where sku = 'TACK_BREECHES'), 'the old card is not in the catalog');
  -- 1 x women navy + 2 x kids purple = 8000 + 7200 = 15200; the client sends no amount
  select jsonb_build_array(
    jsonb_build_object('product_id', (select id from public.store_products where sku = 'TACK_BREECHES_WOMEN_NAVY'), 'quantity', 1),
    jsonb_build_object('product_id', (select id from public.store_products where sku = 'TACK_BREECHES_KIDS_PURPLE'), 'quantity', 2, 'price', 1)) into v_items;
  select * into r from public.create_order(v_items);
  begin perform public.create_order(jsonb_build_array(jsonb_build_object('product_id', (select id from public.store_products where sku = 'TACK_BREECHES'), 'quantity', 1))); v_err := 'created'; exception when others then v_err := sqlerrm; end;
  reset role;
  perform pg_temp.must(r.total_amount = 15200 and r.amount_due = 15200 and r.currency = 'INR', 'order total is priced by the server: ' || r.total_amount);
  select * into v_pay from public.payments where id = r.payment_id;
  perform pg_temp.must(v_pay.amount = 15200 and v_pay.status = 'created' and v_pay.gateway = 'razorpay', 'a Razorpay payment record for 15200 INR is ready for checkout');
  perform pg_temp.must((select has_in_store from public.orders where id = r.order_id), 'the order is collected in store');
  perform pg_temp.must((select count(*) from public.order_items where order_id = r.order_id and unit_price in (8000, 3600)) = 2, 'order lines carry the server prices');
  perform pg_temp.must(v_err <> 'created', 'the hidden old product cannot be ordered: ' || v_err);
  raise notice 'ALL PHASE 23 CHECKS PASSED';
end $$;
rollback;
