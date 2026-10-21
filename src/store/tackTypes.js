import { isBreeches } from "./breeches";

/**
 * The product types a member can pick on the Tack tab, in the order the club asked for. A product belongs to a type
 * by its SKU; the breeches collection (src/store/breeches.js) and the older generic TACK_BREECHES (now retired) were both "Breeches".
 * A tack product with no type here still shows under "All".
 */
export const TACK_TYPES = [
  { key: "all", label: "All" },
  { key: "helmet", label: "Helmets", skus: ["TACK_HELMET"] },
  { key: "breeches", label: "Breeches" },
  { key: "chaps", label: "Chaps", skus: ["TACK_CHAPS"] },
  { key: "half-boots", label: "Half Boots", skus: ["TACK_HALF_BOOTS"] },
  { key: "full-boots", label: "Full Boots", skus: ["TACK_FULL_BOOTS"] },
];

/** The type key of a tack product, or null if it has none. */
export function tackTypeOf(product) {
  if (isBreeches(product)) return "breeches";
  return TACK_TYPES.find((t) => t.skus?.includes(product?.sku))?.key ?? null;
}

/** Keeps the products of the chosen type ("all" keeps everything). */
export const ofTackType = (products, type) => (type === "all" ? products : products.filter((p) => tackTypeOf(p) === type));

/** Types that have at least one product, so no button ever leads to an empty page. */
export const availableTackTypes = (products) => TACK_TYPES.filter((t) => t.key === "all" || products.some((p) => tackTypeOf(p) === t.key));

export const isTackType = (key) => TACK_TYPES.some((t) => t.key === key);
