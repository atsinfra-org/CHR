/**
 * The breeches range in the Tack Shop. Name, description, price and availability live in the database
 * (store_products, migration 0037); this file only says which photos belong to which product and how to group them.
 *
 * Photos are web copies of the originals in /public/CHR Tack Shop/ (unchanged), resized to at most 1400 px and saved as
 * JPEG on white in /public/assests/tack/breeches/<slug>/. 00.jpg is the main photo shown on the product card.
 * Audience and colour come from the folder each photo was supplied in; nothing here is a guess about sizes or fabric.
 */
const photos = (slug, count) => Array.from({ length: count }, (_, i) => `/assests/tack/breeches/${slug}/${String(i).padStart(2, "0")}.jpg`);

export const BREECHES = [
  { sku: "TACK_BREECHES_WOMEN_NAVY", audience: "Women", colour: "Navy", images: photos("women-navy", 6) },
  { sku: "TACK_BREECHES_WOMEN_RED_BLACK", audience: "Women", colour: "Red", images: photos("women-red-black", 6) },
  { sku: "TACK_BREECHES_MEN_CHARCOAL", audience: "Men", colour: "Charcoal", images: photos("men-charcoal", 6) },
  { sku: "TACK_BREECHES_KIDS_NAVY_PINK", audience: "Kids", colour: "Navy", images: photos("kids-navy-pink-details", 4) },
  { sku: "TACK_BREECHES_KIDS_MAGENTA_FLORAL", audience: "Kids", colour: "Magenta", images: photos("kids-magenta-floral-cuffs", 4) },
  { sku: "TACK_BREECHES_KIDS_PINK", audience: "Kids", colour: "Pink", images: photos("kids-pink", 5) },
  { sku: "TACK_BREECHES_KIDS_PURPLE", audience: "Kids", colour: "Purple", images: photos("kids-purple", 5) },
  { sku: "TACK_BREECHES_KIDS_BLACK_STARS", audience: "Kids", colour: "Black", images: photos("kids-black-pink-stars", 3) },
  { sku: "TACK_BREECHES_KIDS_BLACK_CAMO", audience: "Kids", colour: "Black", images: photos("kids-black-pink-camo", 5) },
];

const BY_SKU = Object.fromEntries(BREECHES.map((b) => [b.sku, b]));

export const breechesInfo = (sku) => BY_SKU[sku] ?? null;
export const isBreeches = (product) => Boolean(product && BY_SKU[product.sku]);

export const AUDIENCES = ["Women", "Men", "Kids"];

/** Catalog products that are breeches, each joined with its photos, in the order above. */
export function breechesProducts(products) {
  return BREECHES.map((b) => {
    const p = products.find((x) => x.sku === b.sku);
    return p ? { ...p, ...b } : null;
  }).filter(Boolean);
}

/** Applies the audience and colour filters ("All" means no filter). */
export function filterBreeches(items, { audience = "All", colour = "All" } = {}) {
  return items.filter((i) => (audience === "All" || i.audience === audience) && (colour === "All" || i.colour === colour));
}

/** Colours that actually exist among the given items, in a stable order. */
export const coloursOf = (items) => [...new Set(items.map((i) => i.colour))];

/** Price sorting only makes sense once prices exist; unpriced items always go last. */
export function sortBreeches(items, sort) {
  if (sort !== "price-asc" && sort !== "price-desc") return items;
  const dir = sort === "price-asc" ? 1 : -1;
  return [...items].sort((a, b) => (a.price == null) - (b.price == null) || (a.price == null ? 0 : (a.price - b.price) * dir));
}
