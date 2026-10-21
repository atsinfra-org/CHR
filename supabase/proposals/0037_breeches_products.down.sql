-- Reverses 0037: removes the nine breeches products, but ONLY those never ordered (order history is kept intact).
-- Anything already ordered is hidden instead (is_active = false).
begin;
update public.store_products set is_active = false, updated_at = now()
 where sku like 'TACK_BREECHES\_%' escape '\' and sku <> 'TACK_BREECHES'
   and exists (select 1 from public.order_items oi where oi.product_id = store_products.id);
delete from public.store_products sp
 where sp.sku in ('TACK_BREECHES_WOMEN_NAVY','TACK_BREECHES_WOMEN_RED_BLACK','TACK_BREECHES_MEN_CHARCOAL','TACK_BREECHES_KIDS_NAVY_PINK',
                  'TACK_BREECHES_KIDS_MAGENTA_FLORAL','TACK_BREECHES_KIDS_PINK','TACK_BREECHES_KIDS_PURPLE','TACK_BREECHES_KIDS_BLACK_STARS','TACK_BREECHES_KIDS_BLACK_CAMO')
   and not exists (select 1 from public.order_items oi where oi.product_id = sp.id);
commit;
