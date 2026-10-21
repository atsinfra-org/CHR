-- Reverses 0038: the nine styles go back to "Price coming soon" (unbuyable) and the old generic Breeches card returns.
-- Orders already placed keep the price they were placed at (order_items.unit_price).
begin;
update public.store_products set price = null, updated_at = now()
 where sku in ('TACK_BREECHES_WOMEN_NAVY','TACK_BREECHES_WOMEN_RED_BLACK','TACK_BREECHES_MEN_CHARCOAL','TACK_BREECHES_KIDS_NAVY_PINK',
               'TACK_BREECHES_KIDS_MAGENTA_FLORAL','TACK_BREECHES_KIDS_PINK','TACK_BREECHES_KIDS_PURPLE','TACK_BREECHES_KIDS_BLACK_STARS','TACK_BREECHES_KIDS_BLACK_CAMO');
update public.store_products set is_active = true, updated_at = now() where sku = 'TACK_BREECHES';
commit;
