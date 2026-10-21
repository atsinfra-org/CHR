# Tack Shop management (Admin → Tack Shop)

Administrators manage every Tack Shop product and category here. No code change, redeploy or SQL is needed for routine
work: the shop reads products, photos, prices, categories and sizes live from the database.

**Status:** built and tested locally. Migration `0039_tack_catalog_management.sql` is **not applied**. Apply it after 0038.

## What you can do
| Area | Actions |
|---|---|
| Products | search (name/SKU), filter (category, status), sort (shop order, name, price, recently updated), 20 per page |
| | add, edit, duplicate (a copy is a draft **with no price**), preview as a shopper, publish / unpublish, archive |
| | delete permanently: only a product that is not published and has **never been ordered** |
| Editing | name, SKU, status, category, audience (Women/Men/Kids/Unisex), brand, position, short and full description |
| | selling price, compare-at price (shown crossed out; must be at least the price), cost price (administrators only) |
| | photos: upload JPEG/PNG/WebP up to 5 MB (max 12), main photo, reorder, remove, alt text |
| | specifications (colour, sizes offered, material, fit, care, features, other details): all optional |
| | sizes & stock: per size/colour SKU, optional own price, in stock / out of stock, on sale |
| Categories | add, rename, describe, order, switch on/off; delete only when empty |

Statuses: **Draft** (not in the shop), **Published** (in the shop), **Archived** (discontinued, not buyable).
An empty price means "Price coming soon": the product can be published but never bought.

## Safety
* Every change goes through administrator-only database functions (`admin_save_product`, `admin_save_variants`,
  `admin_save_category`, …). Each re-checks the role, validates the values and writes the audit log (who, what, old and
  new price/status). Staff and members get `FORBIDDEN`; signed-out callers cannot call them. Members and staff cannot
  write the tables directly (row level security), and cost prices are readable by administrators only.
* Photos go to the public Supabase Storage bucket `tack-images`. Only administrators can upload, replace or remove
  (storage policies); the bucket accepts only JPEG/PNG/WebP up to 5 MB. The admin screen also checks the file's real
  type from its bytes. Removing a photo from a product does not delete the file, so old links keep working. A product may
  only reference its own site images (`/assests/...`) or files in this bucket.
* Checkout (`create_order`) still prices every line from the database. A product with sizes needs a valid, on-sale,
  in-stock size; a size's own price is used if set. Drafts, archived and unpriced products are refused even if the
  browser is bypassed. Prices sent by the browser are ignored.
* Orders keep the name, price and size they were bought at (`order_items.name`, `unit_price`, `variant_label`), so
  later edits never change past orders. A product or size that was ordered is archived / switched off, never deleted.

## Stock
There is **no counted inventory**: the order flow does not reserve or deduct stock, so each size is simply in stock or
out of stock. Counted stock would need: a reservation when the order is created, release when an unpaid order expires
(the existing expiry job), and the deduction confirmed when payment succeeds. Recommended only if the club needs it.

## Apply (production, when approved)
1. Run `supabase/proposals/0039_tack_catalog_management.sql` in the SQL Editor (safe to run twice). It keeps every
   product, price and order; the retired generic Breeches stays hidden (archived); hidden café items stay hidden.
   Rollback: `0039_tack_catalog_management.down.sql` (keeps all product data and orders).
2. Check Storage → Buckets shows `tack-images` (public, 5 MB, JPEG/PNG/WebP) with three admin policies.
3. Deploy the website. Then Admin → Tack Shop, edit one product, upload one photo, and check the shop.

## Tests
`npm test` (form, uploads, admin page, shop, cart with sizes) and, on a local copy with 0016–0039 plus a storage stub:
`supabase/tests/phase24_tack_catalog.sql` (permissions, validation, publish/archive/delete rules, sizes at checkout,
server prices, unchanged past orders, audit, storage rules) and `phase23_breeches_prices.sql`.
