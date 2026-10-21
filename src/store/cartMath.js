/**
 * Pure cart logic — no React, no network. The cart only ever stores
 * { productId, quantity }; names, prices and availability always come from
 * the live catalog (store_catalog()), and create_order() re-prices
 * everything server-side. A price shown here is a convenience, never the
 * amount charged.
 */

export const MAX_QUANTITY = 20;

export const CATEGORY_LABEL = {
  membership: "Memberships",
  tack: "Tack Shop",
  cafe: "Café",
};

export function formatINR(amount) {
  if (amount == null) return "";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount);
}

/**
 * One cart line per product, or per product AND size/colour (variant). The line key is the product id, or
 * "productId:variantId" for a variant, so a cart without variants behaves exactly as before.
 */
export const lineKey = (item) => (item.variantId ? `${item.productId}:${item.variantId}` : item.productId);

/** Adds a product (and, for a product sold in sizes/colours, its variant). Only one membership may be in the cart. */
export function addItem(items, product, quantity = 1, variantId = null) {
  if (!product?.is_purchasable) return items;
  if (product.category === "membership") {
    const rest = items.filter((i) => i.category !== "membership");
    return [...rest, { productId: product.id, category: "membership", quantity: 1 }];
  }
  const all = product.variants ?? [];
  // A product sold in sizes/colours needs one chosen, and it must be in stock.
  if ((all.length > 0 || variantId) && !all.some((v) => v.id === variantId && v.in_stock !== false)) return items;
  const key = lineKey({ productId: product.id, variantId });
  const existing = items.find((i) => lineKey(i) === key);
  if (existing) {
    return items.map((i) => (lineKey(i) === key ? { ...i, quantity: Math.min(i.quantity + quantity, MAX_QUANTITY) } : i));
  }
  const line = { productId: product.id, category: product.category, quantity: Math.min(quantity, MAX_QUANTITY) };
  return [...items, variantId ? { ...line, variantId } : line];
}

/** Removes a line by its key (a plain product id still works for lines without a variant). */
export function removeItem(items, key) {
  return items.filter((i) => lineKey(i) !== key);
}

/** Sets a line's quantity (clamped 1–20). Memberships are fixed at 1; 0 removes the line. */
export function setQuantity(items, key, quantity) {
  if (quantity <= 0) return removeItem(items, key);
  return items.map((i) => {
    if (lineKey(i) !== key) return i;
    if (i.category === "membership") return { ...i, quantity: 1 };
    return { ...i, quantity: Math.min(Math.floor(quantity), MAX_QUANTITY) };
  });
}

/**
 * Joins stored items with the live catalog. Lines whose product vanished or
 * is no longer purchasable (e.g. price not set) are returned in `unavailable`
 * and excluded from the total.
 */
export function resolveCart(items, catalog) {
  const byId = new Map((catalog ?? []).map((p) => [p.id, p]));
  const lines = [];
  const unavailable = [];
  for (const item of items) {
    const product = byId.get(item.productId);
    if (!product || !product.is_purchasable || product.price == null) {
      unavailable.push(item);
      continue;
    }
    // A product sold in sizes/colours: the line must name a size still on sale. Its own price, if set, applies.
    const variants = product.variants ?? [];
    const variant = item.variantId ? variants.find((v) => v.id === item.variantId) : null;
    if ((variants.length > 0 || item.variantId) && (!variant || variant.in_stock === false)) {
      unavailable.push(item);
      continue;
    }
    const unitPrice = Number(variant?.price ?? product.price);
    lines.push({
      key: lineKey(item),
      productId: product.id,
      variantId: variant?.id ?? null,
      variantLabel: variant ? [variant.size, variant.colour].filter(Boolean).join(" / ") : null,
      category: product.category,
      name: product.name,
      unitPrice,
      quantity: item.quantity,
      lineTotal: unitPrice * item.quantity,
      fulfillment: product.fulfillment,
    });
  }
  return { lines, unavailable, ...cartTotals(lines) };
}

export function cartTotals(lines) {
  return {
    total: lines.reduce((sum, l) => sum + l.lineTotal, 0),
    count: lines.reduce((sum, l) => sum + l.quantity, 0),
    hasInStore: lines.some((l) => l.fulfillment === "IN_STORE_ONLY"),
    hasMembership: lines.some((l) => l.category === "membership"),
  };
}

/** The payload create_order() accepts — ids and quantities only, never prices. */
export function toOrderPayload(items) {
  return items.map((i) => (i.variantId ? { product_id: i.productId, variant_id: i.variantId, quantity: i.quantity } : { product_id: i.productId, quantity: i.quantity }));
}

export function friendlyOrderError(error) {
  const code = error?.message?.trim();
  const detail = error?.details;
  const known = {
    EMPTY_CART: "Your cart is empty.",
    CART_TOO_LARGE: "That's a lot of items — please split this into two orders.",
    PRODUCT_UNAVAILABLE: "One of the items is no longer available. Please review your cart.",
    PRICE_NOT_SET: detail || "One of the items isn't priced yet. Please remove it to continue.",
    VARIANT_REQUIRED: detail || "Choose a size or colour for each item.",
    VARIANT_UNAVAILABLE: "One of the sizes you chose is no longer available. Please review your cart.",
    OUT_OF_STOCK: detail || "One of the items is out of stock. Please review your cart.",
    INVALID_QUANTITY: detail || "One of the quantities isn't valid.",
    INVALID_CART: "Something is wrong with your cart. Please review it and try again.",
    ONE_MEMBERSHIP_PER_ORDER: "Choose one membership per order.",
    MEMBERSHIP_ALREADY_ACTIVE: detail || "You already have this membership. You can buy it again once it ends.",
    ACTIVE_MEMBERSHIP_EXISTS: detail || "You already have an active membership with classes remaining.",
    TOO_MANY_PENDING_ORDERS: "You have several unpaid orders — please complete or wait before starting another.",
    ACCOUNT_NOT_ACTIVE: "Your account can't place orders right now. Please contact us.",
    "Not authenticated": "Your session has expired — please sign in again.",
  }[code];
  return known || "We couldn't start your order. Please try again.";
}
