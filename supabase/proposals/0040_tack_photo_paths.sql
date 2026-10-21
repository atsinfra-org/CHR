-- 0040_tack_photo_paths.sql  (safe to run twice)
-- 0039 was applied while it still pointed Helmet, Chaps and Full Boots at the old photo files, which have since been
-- replaced. This points those products at the new files. It only changes a product whose photo list is still exactly
-- the old single photo, so a photo set later in Admin -> Tack Shop is never overwritten. Nothing else changes.
begin;
update public.store_products set images = '[{"url":"/assests/tack/helmet.jpeg","alt":"Riding helmet"}]'::jsonb, updated_at = now()
 where sku = 'TACK_HELMET' and images = '[{"url":"/assests/tack/helmet.jpg","alt":"Riding helmet"}]'::jsonb;
update public.store_products set images = '[{"url":"/assests/tack/chaps.webp","alt":"Chaps"}]'::jsonb, updated_at = now()
 where sku = 'TACK_CHAPS' and images = '[{"url":"/assests/tack/chaps.jpg","alt":"Chaps"}]'::jsonb;
update public.store_products set images = '[{"url":"/assests/tack/full-boots-web.jpg","alt":"Full boots"}]'::jsonb, updated_at = now()
 where sku = 'TACK_FULL_BOOTS' and images = '[{"url":"/assests/tack/full-boots.jpg","alt":"Full boots"}]'::jsonb;
-- the hidden old generic Breeches: its photo file no longer exists
update public.store_products set images = '[]'::jsonb, updated_at = now()
 where sku = 'TACK_BREECHES' and images = '[{"url":"/assests/tack/breeches.jpg","alt":"Breeches"}]'::jsonb;
commit;
