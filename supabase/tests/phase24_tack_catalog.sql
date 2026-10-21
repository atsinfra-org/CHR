-- Phase 24 test: Tack Shop management (0039). Apply 0016-0039 first. One transaction, ends in ROLLBACK.
-- On a plain Postgres copy, load a tiny storage stub first so the bucket rules can be checked (see docs/TACK_SHOP_ADMIN.md).
-- Prints "ALL PHASE 24 CHECKS PASSED". Role switching is inline; only pg_temp.must is called while impersonating.
begin;
alter table public.profiles disable trigger trg_prevent_privilege_escalation;
create function pg_temp.must(p_ok boolean, p_msg text) returns void language plpgsql as $$ begin if p_ok is not true then raise exception 'FAIL: %', p_msg; end if; end $$;
grant execute on function pg_temp.must(boolean, text) to public;

do $$
declare
  adm uuid := gen_random_uuid(); stf uuid := gen_random_uuid(); mem uuid := gen_random_uuid();
  v_cat uuid; v_new uuid; v_copy uuid; v_helmet uuid; v_err text; v_res jsonb; r record; v_old_total numeric; v_order uuid; v_var uuid; v_n int;
  v_store_ok boolean := to_regclass('storage.objects') is not null;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select u, 'p24-' || left(u::text, 8) || '@test.org', '{"full_name":"T"}', 'authenticated', 'authenticated' from unnest(array[adm, stf, mem]) u;
  update public.profiles set role = 'admin' where id = adm;
  update public.profiles set role = 'staff' where id = stf;
  select id into v_helmet from public.store_products where sku = 'TACK_HELMET';

  -- ═══ Existing catalogue survived the migration ═══
  perform pg_temp.must((select count(*) from public.store_products where category = 'tack') = 14, 'all 14 tack products kept, none duplicated');
  perform pg_temp.must((select status from public.store_products where sku = 'TACK_BREECHES') = 'archived' and not (select is_active from public.store_products where sku = 'TACK_BREECHES'), 'the hidden generic Breeches stays hidden (archived)');
  perform pg_temp.must((select count(*) from public.store_products where category = 'tack' and tack_category_id is null) = 0, 'every tack product has a category');
  perform pg_temp.must((select price from public.store_products where sku = 'TACK_BREECHES_WOMEN_NAVY') = 8000 and (select price from public.store_products where sku = 'TACK_HELMET') = 2500, 'prices unchanged');
  perform pg_temp.must((select count(*) from public.store_products where category = 'cafe' and status = 'draft') = (select count(*) from public.store_products where category = 'cafe' and not is_active), 'hidden cafe items stay hidden');

  -- ═══ Nobody but an administrator can change the catalogue ═══
  perform set_config('request.jwt.claims', json_build_object('sub', mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.admin_save_product(v_helmet, '{"price": 1}'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'FORBIDDEN', 'a member cannot change a price: ' || v_err);
  begin update public.store_products set price = 1 where id = v_helmet; get diagnostics v_n = row_count; v_err := 'rows ' || v_n; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err like 'permission denied%' or v_err = 'rows 0', 'a member cannot update the table directly: ' || v_err);
  begin insert into public.store_categories (slug, name) values ('x-hack', 'Hack'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err like 'permission denied%' or v_err like 'new row violates%', 'a member cannot add a category: ' || v_err);
  begin perform public.admin_tack_products(); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'FORBIDDEN', 'a member cannot read the admin catalogue (costs)');
  perform pg_temp.must((select count(*) from public.store_product_costs) = 0, 'a member sees no cost prices');
  if v_store_ok then
    begin insert into storage.objects (bucket_id, name) values ('tack-images', 'products/x.jpg'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
    perform pg_temp.must(v_err like 'new row violates row-level security%', 'a member cannot upload shop photos: ' || v_err);
  end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', stf, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.admin_set_product_status(v_helmet, 'archived'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'FORBIDDEN', 'staff cannot archive: ' || v_err);
  if v_store_ok then
    begin insert into storage.objects (bucket_id, name) values ('tack-images', 'products/y.jpg'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
    perform pg_temp.must(v_err like 'new row violates row-level security%', 'staff cannot upload shop photos');
  end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  begin perform public.admin_save_product(null, '{"name":"x"}'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_err like 'permission denied%', 'signed-out callers cannot even call the admin functions');

  -- ═══ The administrator manages everything ═══
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if v_store_ok then
    insert into storage.objects (bucket_id, name) values ('tack-images', 'products/new.jpg');
  end if;
  v_cat := public.admin_save_category(null, '{"name": "Saddle Pads", "description": "Pads and numnahs", "sort_order": 70}');
  perform public.admin_save_category(v_cat, '{"name": "Saddle Pads & Numnahs"}');
  -- create: a draft with no price is allowed and is NOT visible or buyable
  v_new := public.admin_save_product(null, jsonb_build_object('name', 'Quilted Saddle Pad', 'sku', 'tack_pad_quilted', 'category_id', v_cat,
            'short_description', 'Soft quilted pad.', 'audience', 'Unisex',
            'specs', jsonb_build_object('colour', 'Navy', 'material', 'Cotton', 'sizes', jsonb_build_array('Pony', 'Cob', 'Full')),
            'images', jsonb_build_array(jsonb_build_object('url', 'https://abcdefgh.supabase.co/storage/v1/object/public/tack-images/products/new.jpg', 'alt', 'Navy saddle pad'))));
  perform pg_temp.must((select sku from public.store_products where id = v_new) = 'TACK_PAD_QUILTED', 'SKU stored in capitals');
  perform pg_temp.must(not exists (select 1 from public.store_catalog() where id = v_new), 'a draft is not in the store');
  perform pg_temp.must(not (public.store_tack_details() -> 'products' @> jsonb_build_array(jsonb_build_object('id', v_new))), 'a draft has no public details');
  begin perform * from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_new, 'quantity', 1))); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'PRODUCT_UNAVAILABLE', 'a draft cannot be bought: ' || v_err);
  -- validation
  begin perform public.admin_save_product(null, '{"name": "X", "sku": "TACK_X"}'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'INVALID_VALUE', 'name too short refused');
  begin perform public.admin_save_product(null, '{"name": "Copy helmet", "sku": "TACK_HELMET"}'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'SKU_TAKEN', 'duplicate SKU refused: ' || v_err);
  begin perform public.admin_save_product(v_new, '{"price": -5}'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'INVALID_VALUE', 'negative price refused');
  begin perform public.admin_save_product(v_new, '{"price": 0}'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'INVALID_VALUE', 'zero price refused');
  begin perform public.admin_save_product(v_new, '{"price": "abc"}'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'INVALID_VALUE', 'non-numeric price refused');
  begin perform public.admin_save_product(v_new, '{"price": 2000, "compare_at_price": 1500}'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'INVALID_VALUE', 'compare-at below the price refused');
  begin perform public.admin_save_product(v_new, '{"images": [{"url": "https://evil.example.com/x.jpg"}]}'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'INVALID_VALUE', 'a photo from another site refused');
  begin perform public.admin_save_product(v_new, '{"images": [{"url": "javascript:alert(1)"}]}'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'INVALID_VALUE', 'a script URL refused');
  begin perform public.admin_save_product(v_new, '{"specs": {"price": 1}}'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'INVALID_VALUE', 'unknown specification refused');
  begin perform public.admin_save_product((select id from public.store_products where category = 'membership' limit 1), '{"price": 1}'); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'NOT_A_TACK_PRODUCT', 'memberships cannot be edited here: ' || v_err);
  -- edit keeps what is not sent
  perform public.admin_save_product(v_new, '{"price": 2200, "compare_at_price": 2600, "description": "A soft pad."}');
  perform pg_temp.must((select price = 2200 and compare_at_price = 2600 and short_description = 'Soft quilted pad.' and specs ->> 'material' = 'Cotton' and jsonb_array_length(images) = 1
                        from public.store_products where id = v_new), 'editing price and description kept the other fields');
  -- images: replace, reorder
  perform public.admin_save_product(v_new, jsonb_build_object('images', jsonb_build_array(
    jsonb_build_object('url', '/assests/tack/helmet.jpg', 'alt', 'second'),
    jsonb_build_object('url', 'https://abcdefgh.supabase.co/storage/v1/object/public/tack-images/products/new.jpg', 'alt', 'first'))));
  perform pg_temp.must((select images -> 0 ->> 'alt' from public.store_products where id = v_new) = 'second', 'photos reordered (first is the main photo)');
  -- publish -> visible and buyable at the server price
  perform public.admin_set_product_status(v_new, 'published');
  perform pg_temp.must(exists (select 1 from public.store_catalog() where id = v_new and is_purchasable and price = 2200), 'published product is in the store and buyable');
  perform pg_temp.must(public.store_tack_details() -> 'products' @> jsonb_build_array(jsonb_build_object('id', v_new, 'category_slug', 'saddle-pads')), 'public details include it with its category');
  -- variants: size required; variant price wins; out of stock refused
  perform public.admin_save_variants(v_new, '[{"sku": "TACK_PAD_QUILTED_PONY", "size": "Pony"}, {"sku": "TACK_PAD_QUILTED_FULL", "size": "Full", "price": 2500}, {"sku": "TACK_PAD_QUILTED_COB", "size": "Cob", "in_stock": false}]');
  select id into v_var from public.store_product_variants where sku = 'TACK_PAD_QUILTED_FULL';
  reset role;
  update public.profiles set role = 'admin' where id = adm; -- no-op, keeps the admin
  perform set_config('request.jwt.claims', json_build_object('sub', mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform * from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_new, 'quantity', 1))); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'VARIANT_REQUIRED', 'a product with sizes needs a size: ' || v_err);
  begin perform * from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_new, 'variant_id', (select id from public.store_product_variants where sku = 'TACK_PAD_QUILTED_COB'), 'quantity', 1))); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'OUT_OF_STOCK', 'an out-of-stock size cannot be bought: ' || v_err);
  begin perform * from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_helmet, 'variant_id', v_var, 'quantity', 1))); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'VARIANT_UNAVAILABLE', 'a size of another product is refused: ' || v_err);
  select * into r from public.create_order(jsonb_build_array(
    jsonb_build_object('product_id', v_new, 'variant_id', v_var, 'quantity', 2, 'unit_price', 1, 'price', 1, 'amount', 1),
    jsonb_build_object('product_id', v_helmet, 'quantity', 1)));
  reset role;
  perform pg_temp.must(r.total_amount = 2 * 2500 + 2500 and (select amount from public.payments where id = r.payment_id) = 7500, 'server price: 2 x 2500 (size price) + helmet 2500 = 7500; browser prices ignored');
  perform pg_temp.must((select variant_label from public.order_items where order_id = r.order_id and variant_id = v_var) = 'Full', 'the order line keeps the size');
  v_order := r.order_id; v_old_total := r.total_amount;

  -- ═══ Historical orders never change ═══
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_save_product(v_new, '{"price": 9999, "compare_at_price": null, "name": "Renamed pad"}');
  perform public.admin_save_variants(v_new, '[{"sku": "TACK_PAD_QUILTED_PONY", "size": "Pony"}]'); -- Full (ordered) and Cob dropped
  perform public.admin_save_product(v_new, '{"images": []}');
  reset role;
  perform pg_temp.must((select total_amount from public.orders where id = v_order) = v_old_total, 'order total unchanged after a price change');
  perform pg_temp.must((select unit_price = 2500 and name = 'Quilted Saddle Pad' and variant_label = 'Full' from public.order_items where order_id = v_order and variant_id = v_var), 'order line keeps its price, name and size');
  perform pg_temp.must((select not is_active from public.store_product_variants where id = v_var), 'an ordered size is switched off, not deleted');
  perform pg_temp.must(not exists (select 1 from public.store_product_variants where sku = 'TACK_PAD_QUILTED_COB'), 'a never-ordered size is deleted');

  -- ═══ Duplicate, archive, delete ═══
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_copy := public.admin_duplicate_product(v_helmet);
  perform pg_temp.must((select status = 'draft' and price is null and sku = 'TACK_HELMET_COPY' from public.store_products where id = v_copy), 'a copy is a draft with no price');
  perform public.admin_delete_product(v_copy);
  perform pg_temp.must(not exists (select 1 from public.store_products where id = v_copy), 'a never-ordered draft can be deleted');
  begin perform public.admin_delete_product(v_new); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'UNPUBLISH_FIRST', 'a published product cannot be deleted: ' || v_err);
  perform public.admin_set_product_status(v_new, 'archived');
  begin perform public.admin_delete_product(v_new); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'PRODUCT_HAS_ORDERS', 'a product with orders is never deleted: ' || v_err);
  begin perform public.admin_delete_category(v_cat); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'CATEGORY_IN_USE', 'a category in use is not deleted');
  perform public.admin_save_category(v_cat, '{"is_active": false}');
  v_res := public.admin_tack_products();
  reset role;
  perform pg_temp.must(not exists (select 1 from public.store_catalog() where id = v_new), 'an archived product is not in the store');
  perform set_config('request.jwt.claims', json_build_object('sub', mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform * from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_new, 'variant_id', (select id from public.store_product_variants where sku = 'TACK_PAD_QUILTED_PONY'), 'quantity', 1))); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_err = 'PRODUCT_UNAVAILABLE', 'an archived product cannot be bought: ' || v_err);
  perform pg_temp.must(jsonb_array_length(v_res -> 'products') = 15 and (v_res -> 'categories') @> '[{"slug":"saddle-pads","is_active":false}]', 'the admin list includes everything, with the switched-off category');

  -- ═══ Unpriced published product is still never buyable ═══
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_copy := public.admin_save_product(null, jsonb_build_object('name', 'Coming Soon Gloves', 'sku', 'TACK_GLOVES', 'status', 'published', 'category_id', (select id from public.store_categories where slug = 'accessories')));
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', mem, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform * from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_copy, 'quantity', 1))); v_err := 'ok'; exception when others then v_err := sqlerrm; end;
  perform pg_temp.must(v_err = 'PRICE_NOT_SET', 'a published product with no price cannot be bought: ' || v_err);
  perform pg_temp.must(exists (select 1 from public.store_catalog() where id = v_copy and not is_purchasable), 'it shows as not purchasable');
  reset role;

  -- ═══ The audit log has the history ═══
  perform pg_temp.must((select count(*) from public.audit_logs where record_id = v_new and action in ('PRODUCT_CREATED', 'PRODUCT_PRICE_CHANGED', 'PRODUCT_STATUS_CHANGED', 'PRODUCT_UPDATED', 'PRODUCT_VARIANTS_CHANGED')) >= 5, 'changes are audited');
  perform pg_temp.must(exists (select 1 from public.audit_logs where record_id = v_new and action = 'PRODUCT_PRICE_CHANGED' and old_values ->> 'price' = '2200.00' and new_values ->> 'price' = '9999.00'), 'a price change records the old and new price');
  perform pg_temp.must((select performed_by from public.audit_logs where record_id = v_new and action = 'PRODUCT_CREATED') = adm, 'the administrator is recorded');

  -- ═══ The old price tool still works and keeps status in step ═══
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_set_product_price(v_helmet, 2600, false);
  reset role;
  perform pg_temp.must((select status = 'draft' and price = 2600 from public.store_products where id = v_helmet), 'unlisting through the old price tool makes it a draft');

  raise notice 'ALL PHASE 24 CHECKS PASSED (storage rules checked: %)', v_store_ok;
end $$;
rollback;
