import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { inCategory, mergeTackDetails, shopCategories, shopItem, variantLabel } from "./tackCatalog";
import { addItem, lineKey, removeItem, resolveCart, setQuantity, toOrderPayload } from "./cartMath";
import { photoFor } from "./productPhotos";
import TackShop from "./TackShop";

const catalog = [
  { id: "m1", sku: "PLAN_GOLD", category: "membership", name: "Gold", price: 15000, is_purchasable: true },
  { id: "h", sku: "TACK_HELMET", category: "tack", name: "Helmet", price: 2500, is_purchasable: true, fulfillment: "IN_STORE_ONLY" },
  { id: "g", sku: "TACK_GLOVES", category: "tack", name: "Gloves", price: 900, is_purchasable: true, fulfillment: "IN_STORE_ONLY" },
  { id: "n", sku: "TACK_BREECHES_WOMEN_NAVY", category: "tack", name: "Women's Navy", price: 8000, is_purchasable: true, fulfillment: "IN_STORE_ONLY" },
];
const details = {
  categories: [{ id: "c1", slug: "helmets", name: "Helmets" }, { id: "c2", slug: "gloves", name: "Gloves", description: "For grip." }, { id: "c3", slug: "empty", name: "Empty" }],
  products: [
    { id: "h", sku: "TACK_HELMET", category_slug: "helmets", images: [{ url: "https://x.supabase.co/storage/v1/object/public/tack-images/products/h.jpg", alt: "New helmet photo" }], short_description: "Edited by admin", specs: {}, variants: [], price: 1, name: "HACKED" },
    { id: "g", sku: "TACK_GLOVES", category_slug: "gloves", images: [], audience: "Unisex", specs: { colour: "Black" },
      variants: [{ id: "vs", size: "S", colour: null, price: null, in_stock: true }, { id: "vm", size: "M", colour: null, price: 950, in_stock: true }, { id: "vl", size: "L", colour: null, price: null, in_stock: false }] },
  ],
};

describe("the shop reads its products from the database", () => {
  const merged = mergeTackDetails(catalog, details);
  it("admin edits (photo, wording, sizes) show, but price and buyability stay the catalog's", () => {
    const h = merged.find((p) => p.id === "h");
    expect(h.short_description).toBe("Edited by admin");
    expect(h.images[0].url).toMatch(/tack-images/);
    expect(h.price).toBe(2500);
    expect(h.name).toBe("Helmet");
    expect(merged.find((p) => p.id === "m1")).toEqual(catalog[0]); // memberships untouched
  });
  it("without the details (migration not applied) the built-in photos are used", () => {
    const item = shopItem(mergeTackDetails(catalog, null).find((p) => p.id === "n"));
    expect(item.images[0]).toBe("/assests/tack/breeches/women-navy/00.jpg");
    expect(item.audience).toBe("Women");
    expect(item.categorySlug).toBe("breeches");
  });
  it("category buttons come from the database, only for categories with products", () => {
    const items = merged.filter((p) => p.category === "tack").map(shopItem);
    expect(shopCategories(details, items).map((c) => c.slug)).toEqual(["helmets", "gloves"]);
    expect(inCategory(items, "gloves").map((i) => i.id)).toEqual(["g"]);
    expect(inCategory(items, "all")).toHaveLength(3);
    expect(shopCategories(null, mergeTackDetails(catalog, null).filter((p) => p.category === "tack").map(shopItem)).map((c) => c.slug)).toEqual(["helmets", "breeches"]);
  });
  it("the cart photo follows the admin's main photo", () => {
    expect(photoFor(merged.find((p) => p.id === "h")).image).toMatch(/tack-images\/products\/h\.jpg$/);
  });
});

describe("sizes in the cart", () => {
  const products = mergeTackDetails(catalog, details);
  const gloves = products.find((p) => p.id === "g");
  it("a product with sizes needs one, and an out-of-stock size can't be added", () => {
    expect(addItem([], gloves, 1)).toEqual([]);
    expect(addItem([], gloves, 1, "vl")).toEqual([]);
    expect(addItem([], gloves, 1, "nope")).toEqual([]);
    expect(addItem([], gloves, 2, "vm")).toEqual([{ productId: "g", category: "tack", quantity: 2, variantId: "vm" }]);
  });
  it("each size is its own line; quantity and removal work by line", () => {
    let items = addItem(addItem([], gloves, 1, "vs"), gloves, 1, "vm");
    items = addItem(items, gloves, 1, "vs");
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.variantId === "vs").quantity).toBe(2);
    items = setQuantity(items, "g:vm", 3);
    expect(items.find((i) => i.variantId === "vm").quantity).toBe(3);
    expect(removeItem(items, "g:vs")).toHaveLength(1);
    expect(lineKey({ productId: "h" })).toBe("h");
  });
  it("the shown total uses the size's own price; the order payload carries ids only", () => {
    const items = [{ productId: "g", category: "tack", quantity: 2, variantId: "vm" }, { productId: "g", category: "tack", quantity: 1, variantId: "vs" }, { productId: "h", category: "tack", quantity: 1 }];
    const r = resolveCart(items, products);
    expect(r.total).toBe(2 * 950 + 900 + 2500);
    expect(r.lines.find((l) => l.variantId === "vm").variantLabel).toBe("M");
    expect(toOrderPayload(items)).toEqual([{ product_id: "g", variant_id: "vm", quantity: 2 }, { product_id: "g", variant_id: "vs", quantity: 1 }, { product_id: "h", quantity: 1 }]);
    expect(JSON.stringify(toOrderPayload(items))).not.toMatch(/price/);
  });
  it("a size that went out of stock, or a size-less line for a sized product, is not charged", () => {
    const r = resolveCart([{ productId: "g", category: "tack", quantity: 1, variantId: "vl" }, { productId: "g", category: "tack", quantity: 1 }], products);
    expect(r.lines).toHaveLength(0);
    expect(r.unavailable).toHaveLength(2);
  });
  it("variant labels", () => {
    expect(variantLabel({ size: "M", colour: "Navy" })).toBe("M / Navy");
    expect(variantLabel({ colour: "Navy" })).toBe("Navy");
  });
});

describe("product page with sizes", () => {
  const items = mergeTackDetails(catalog, details).filter((p) => p.category === "tack").map(shopItem);
  const html = renderToStaticMarkup(<TackShop items={items} heading="" cart={{ items: [], add() {} }} selectedSku="TACK_GLOVES" onSelect={() => {}} />);
  it("asks for a size before Add to cart, and shows out-of-stock sizes as unavailable", () => {
    expect(html).toContain("Choose a size");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Choose a size<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>L \(out of stock\)<\/button>/);
    expect(html).toContain(">S<");
    expect(html).toContain(">M<");
  });
  it("shows only the specifications that exist", () => {
    expect(html).toContain("Colour");
    expect(html).toContain("Black");
    expect(html).not.toContain("Material");
    expect(html).not.toContain("Care");
  });
  it("a missing photo shows the placeholder instead of a broken image", () => {
    expect(html).toContain("Photo unavailable");
  });
  it("a compare-at price is shown crossed out, only above the selling price", () => {
    const one = shopItem({ ...items[0], compare_at_price: 3000 });
    const out = renderToStaticMarkup(<TackShop items={[one]} heading="X" cart={{ items: [] }} selectedSku={null} onSelect={() => {}} />);
    expect(out).toMatch(/<s[^>]*>₹3,000<\/s>/);
    const lower = renderToStaticMarkup(<TackShop items={[shopItem({ ...items[0], compare_at_price: 1000 })]} heading="X" cart={{ items: [] }} selectedSku={null} onSelect={() => {}} />);
    expect(lower).not.toMatch(/<s( [^>]*)?>/);
  });
});
