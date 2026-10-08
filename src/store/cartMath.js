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

/** Adds a product. Only one membership may be in the cart: adding another replaces it. */
export function addItem(items, product, quantity = 1) {
  if (!product?.is_purchasable) return items;
  if (product.category === "membership") {
    const rest = items.filter((i) => i.category !== "membership");
    return [...rest, { productId: product.id, category: "membership", quantity: 1 }];
  }
  const existing = items.find((i) => i.productId === product.id);
  if (existing) {
    return items.map((i) => (i.productId === product.id ? { ...i, quantity: Math.min(i.quantity + quantity, MAX_QUANTITY) } : i));
  }
  return [...items, { productId: product.id, category: product.category, quantity: Math.min(quantity, MAX_QUANTITY) }];
}

export function removeItem(items, productId) {
  return items.filter((i) => i.productId !== productId);
}

/** Sets a line's quantity (clamped 1–20). Memberships are fixed at 1; 0 removes the line. */
export function setQuantity(items, productId, quantity) {
  if (quantity <= 0) return removeItem(items, productId);
  return items.map((i) => {
    if (i.productId !== productId) return i;
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
    lines.push({
      productId: product.id,
      category: product.category,
      name: product.name,
      unitPrice: Number(product.price),
      quantity: item.quantity,
      lineTotal: Number(product.price) * item.quantity,
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
  return items.map((i) => ({ product_id: i.productId, quantity: i.quantity }));
}

export function friendlyOrderError(error) {
  const code = error?.message?.trim();
  const detail = error?.details;
  const known = {
    EMPTY_CART: "Your cart is empty.",
    CART_TOO_LARGE: "That's a lot of items — please split this into two orders.",
    PRODUCT_UNAVAILABLE: "One of the items is no longer available. Please review your cart.",
    PRICE_NOT_SET: detail || "One of the items isn't priced yet. Please remove it to continue.",
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
