import { breechesInfo } from "./breeches";
import { TACK_TYPES, tackTypeOf } from "./tackTypes";

/**
 * Joins the store catalogue (store_catalog(): price and "can it be bought", decided by the database) with the Tack Shop
 * display details (store_tack_details(): category, photos, specifications, sizes) that administrators edit in
 * Admin -> Tack Shop. Nothing here decides a price.
 *
 * Before migration 0039 is applied the details call does not exist; the shop then falls back to the photos and
 * categories that shipped with the site, so the store never breaks.
 */
export function mergeTackDetails(products, details) {
  const byId = new Map((details?.products ?? []).map((d) => [d.id, d]));
  return products.map((p) => {
    if (p.category !== "tack") return p;
    const d = byId.get(p.id);
    return d ? { ...p, ...d, name: p.name, price: p.price, is_purchasable: p.is_purchasable, hasDetails: true } : p;
  });
}

/** A tack product shaped for the shop: photo URLs with alt text, colour, audience, category, sizes. */
export function shopItem(p) {
  const fallback = breechesInfo(p.sku);
  const dbImages = Array.isArray(p.images) ? p.images.filter((i) => i && typeof i.url === "string") : [];
  const legacy = fallback ? fallback.images.map((url) => ({ url, alt: p.name })) : [];
  const photos = dbImages.length ? dbImages : legacy;
  return {
    ...p,
    photos,
    images: photos.map((i) => i.url),
    audience: p.audience ?? fallback?.audience ?? null,
    colour: p.specs?.colour ?? fallback?.colour ?? null,
    categorySlug: p.category_slug ?? fallbackSlug(p),
    variants: Array.isArray(p.variants) ? p.variants : [],
  };
}

const FALLBACK_SLUG = { helmet: "helmets", breeches: "breeches", chaps: "chaps", "half-boots": "half-boots", "full-boots": "full-boots" };
const fallbackSlug = (p) => FALLBACK_SLUG[tackTypeOf(p)] ?? null;

/** The category buttons: from the database when available, otherwise the built-in list. Only categories with products. */
export function shopCategories(details, items) {
  const list = details?.categories?.length
    ? details.categories.map((c) => ({ slug: c.slug, name: c.name, description: c.description ?? null }))
    : TACK_TYPES.filter((t) => t.key !== "all").map((t) => ({ slug: FALLBACK_SLUG[t.key], name: t.label, description: null }));
  return list.filter((c) => items.some((i) => i.categorySlug === c.slug));
}

export const inCategory = (items, slug) => (!slug || slug === "all" ? items : items.filter((i) => i.categorySlug === slug));

/** "S / Navy" for a variant. */
export const variantLabel = (v) => [v?.size, v?.colour].filter(Boolean).join(" / ");
