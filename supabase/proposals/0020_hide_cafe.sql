-- Phase 6.2 — Hide the café from the customer store (kept for the future).
-- store_catalog() and create_order() both ignore inactive products, so this removes café
-- from the store AND blocks any hand-crafted café order on the server. Nothing is deleted:
-- products, prices and historical order items are untouched, and staff can still see and
-- price them in Admin → Orders → "Tack & café prices".
update public.store_products set is_active = false where category = 'cafe';

-- To bring the café back later (also add "cafe" to STORE_CATEGORIES in src/store/storeConfig.js):
--   update public.store_products set is_active = true where category = 'cafe';
-- (Cold Drink and Water stay unpurchasable until an admin sets a price.)
