import { describe, expect, it } from "vitest";
import { addItem, cartTotals, friendlyOrderError, removeItem, resolveCart, setQuantity, toOrderPayload } from "./cartMath";

const catalog = [
  { id: "gold", category: "membership", name: "Gold Membership", price: 15000, fulfillment: "SERVICE", is_purchasable: true },
  { id: "plat", category: "membership", name: "Platinum Membership", price: 18000, fulfillment: "SERVICE", is_purchasable: true },
  { id: "helmet", category: "tack", name: "Helmet", price: 2500, fulfillment: "IN_STORE_ONLY", is_purchasable: true },
  { id: "sandwich", category: "cafe", name: "Chicken Sandwich", price: 150, fulfillment: "IN_STORE_ONLY", is_purchasable: true },
  { id: "water", category: "cafe", name: "Water", price: null, fulfillment: "IN_STORE_ONLY", is_purchasable: false },
];
const byId = (id) => catalog.find((p) => p.id === id);

describe("cart", () => {
  it("mixed cart totals match the brief's example (₹17,650)", () => {
    let items = [];
    items = addItem(items, byId("gold"));
    items = addItem(items, byId("helmet"));
    items = addItem(items, byId("sandwich"));
    const r = resolveCart(items, catalog);
    expect(r.total).toBe(17650);
    expect(r.count).toBe(3);
    expect(r.hasMembership).toBe(true);
    expect(r.hasInStore).toBe(true);
  });

  it("adding the same tack item increments quantity; removal works", () => {
    let items = addItem([], byId("helmet"));
    items = addItem(items, byId("helmet"));
    expect(items).toEqual([{ productId: "helmet", category: "tack", quantity: 2 }]);
    expect(resolveCart(items, catalog).total).toBe(5000);
    expect(removeItem(items, "helmet")).toEqual([]);
  });

  it("only one membership can be in the cart; a second replaces the first", () => {
    let items = addItem([], byId("gold"));
    items = addItem(items, byId("plat"));
    expect(items.filter((i) => i.category === "membership")).toHaveLength(1);
    expect(items[0].productId).toBe("plat");
  });

  it("a membership plan the customer already holds cannot be added", () => {
    const held = { ...byId("gold"), is_purchasable: false, active_until: "2026-11-05" };
    expect(addItem([], held)).toEqual([]);
  });

  it("a held plan already in a stale cart is treated as unavailable and not charged", () => {
    const stale = [{ productId: "gold", category: "membership", quantity: 1 }];
    const r = resolveCart(stale, [{ ...byId("gold"), is_purchasable: false, active_until: "2026-11-05" }]);
    expect(r.total).toBe(0);
    expect(r.unavailable).toHaveLength(1);
  });

  it("maps the already-active error", () => {
    expect(friendlyOrderError({ message: "MEMBERSHIP_ALREADY_ACTIVE", details: "You already have Gold Membership until 5 Nov 2026." })).toMatch(/until 5 Nov/);
  });

  it("unpriced items (Water) cannot be added", () => {
    expect(addItem([], byId("water"))).toEqual([]);
  });

  it("an item that becomes unavailable is excluded from the total", () => {
    const r = resolveCart([{ productId: "water", category: "cafe", quantity: 2 }, { productId: "helmet", category: "tack", quantity: 1 }], catalog);
    expect(r.total).toBe(2500);
    expect(r.unavailable).toHaveLength(1);
  });

  it("quantity is clamped, memberships stay at 1, zero removes", () => {
    let items = addItem([], byId("helmet"));
    expect(setQuantity(items, "helmet", 999)[0].quantity).toBe(20);
    expect(setQuantity(items, "helmet", 0)).toEqual([]);
    const m = addItem([], byId("gold"));
    expect(setQuantity(m, "gold", 5)[0].quantity).toBe(1);
  });

  it("the order payload carries ids and quantities only — never prices", () => {
    const payload = toOrderPayload([{ productId: "helmet", category: "tack", quantity: 2 }]);
    expect(payload).toEqual([{ product_id: "helmet", quantity: 2 }]);
    expect(JSON.stringify(payload)).not.toMatch(/price/i);
  });

  it("cartTotals on no lines is zero", () => {
    expect(cartTotals([])).toMatchObject({ total: 0, count: 0, hasInStore: false, hasMembership: false });
  });

  it("maps server error codes to friendly copy", () => {
    expect(friendlyOrderError({ message: "PRICE_NOT_SET", details: "Water is not available to buy yet." })).toMatch(/Water/);
    expect(friendlyOrderError({ message: "ACTIVE_MEMBERSHIP_EXISTS" })).toMatch(/active membership/i);
    expect(friendlyOrderError({ message: "SOMETHING_ELSE" })).toMatch(/couldn't start/i);
  });
});
