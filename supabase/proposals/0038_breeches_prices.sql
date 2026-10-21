-- 0038_breeches_prices.sql  (REVIEW: apply in the Supabase SQL Editor after 0037; safe to run twice.)
--
-- Sets the confirmed prices of the nine breeches styles (INR, as stored; no paise) and retires the old generic
-- "Breeches" product (TACK_BREECHES, Rs 4,000, never ordered), which the collection replaces.
-- Nothing else changes: once a price is set, the existing rules make the style buyable through the existing checkout
-- (create_order prices every line from this table, then the existing Razorpay flow takes payment).
-- Rollback: 0038_breeches_prices.down.sql.
begin;

update public.store_products as sp set price = v.price, updated_at = now()
from (values
  ('TACK_BREECHES_WOMEN_NAVY',          8000.00),
  ('TACK_BREECHES_WOMEN_RED_BLACK',     4500.00),
  ('TACK_BREECHES_MEN_CHARCOAL',        6000.00),
  ('TACK_BREECHES_KIDS_NAVY_PINK',      3600.00),
  ('TACK_BREECHES_KIDS_MAGENTA_FLORAL', 3600.00),
  ('TACK_BREECHES_KIDS_PINK',           3600.00),
  ('TACK_BREECHES_KIDS_PURPLE',         3600.00),
  ('TACK_BREECHES_KIDS_BLACK_STARS',    3600.00),
  ('TACK_BREECHES_KIDS_BLACK_CAMO',     3600.00)
) as v(sku, price)
where sp.sku = v.sku and sp.category = 'tack';

-- The old generic card is hidden, not deleted.
update public.store_products set is_active = false, updated_at = now() where sku = 'TACK_BREECHES' and is_active;

do $$
begin
  if (select count(*) from public.store_products where sku like 'TACK\_BREECHES\_%' escape '\' and price is not null and is_active) <> 9 then
    raise exception '0038: expected 9 priced breeches styles; run 0037 first';
  end if;
end $$;

commit;
