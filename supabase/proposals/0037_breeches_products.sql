-- 0037_breeches_products.sql  (APPLIED in production. Safe to run twice.)
--
-- Adds the nine breeches styles supplied in public/CHR Tack Shop/ to the Tack Shop as tack products.
--   * price is NULL on purpose: prices are not confirmed yet. The existing rules then keep them unbuyable everywhere:
--     store_catalog() reports is_purchasable = false, the cart ignores them, and create_order() raises PRICE_NOT_SET.
--     The store shows "Price coming soon".
--   * Set a price later in Admin -> Orders -> "Tack & cafe prices" (admin_set_product_price), or:
--       update public.store_products set price = <rupees>, updated_at = now() where sku = '<SKU>';
--   * No schema change. Names can be edited the same way. Photos are mapped in src/store/breeches.js by SKU.
--   * Existing products are not touched (the old generic TACK_BREECHES is retired by 0038).
-- Rollback: 0037_breeches_products.down.sql.
begin;

insert into public.store_products (sku, category, name, description, price, currency, fulfillment, is_active, sort_order) values
  ('TACK_BREECHES_WOMEN_NAVY',          'tack', 'Women''s Navy Equestrian Breeches',              null, null, 'INR', 'IN_STORE_ONLY', true, 101),
  ('TACK_BREECHES_WOMEN_RED_BLACK',     'tack', 'Women''s Red and Black Riding Breeches',         null, null, 'INR', 'IN_STORE_ONLY', true, 102),
  ('TACK_BREECHES_MEN_CHARCOAL',        'tack', 'Men''s Charcoal Riding Breeches',                null, null, 'INR', 'IN_STORE_ONLY', true, 103),
  ('TACK_BREECHES_KIDS_NAVY_PINK',      'tack', 'Kids'' Navy Riding Breeches with Pink Details',  null, null, 'INR', 'IN_STORE_ONLY', true, 104),
  ('TACK_BREECHES_KIDS_MAGENTA_FLORAL', 'tack', 'Kids'' Magenta Breeches with Floral Cuffs',      null, null, 'INR', 'IN_STORE_ONLY', true, 105),
  ('TACK_BREECHES_KIDS_PINK',           'tack', 'Kids'' Pink Riding Breeches',                    null, null, 'INR', 'IN_STORE_ONLY', true, 106),
  ('TACK_BREECHES_KIDS_PURPLE',         'tack', 'Kids'' Purple Riding Breeches',                  null, null, 'INR', 'IN_STORE_ONLY', true, 107),
  ('TACK_BREECHES_KIDS_BLACK_STARS',    'tack', 'Kids'' Black Riding Leggings with Pink Stars',   null, null, 'INR', 'IN_STORE_ONLY', true, 108),
  ('TACK_BREECHES_KIDS_BLACK_CAMO',     'tack', 'Kids'' Black Riding Leggings with Pink Camo',    null, null, 'INR', 'IN_STORE_ONLY', true, 109)
on conflict (sku) do nothing;


commit;
