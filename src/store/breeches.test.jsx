import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { BREECHES, breechesProducts, coloursOf, filterBreeches, isBreeches, sortBreeches } from "./breeches";
import { addItem, resolveCart } from "./cartMath";
import { photoFor } from "./productPhotos";
import TackShop from "./TackShop";
import { shopItem } from "./tackCatalog";

// The shop as the store renders the Breeches category.
const BreechesShop = ({ items, ...rest }) => <TackShop heading="Breeches" items={items.map(shopItem)} {...rest} />;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migration = fs.readFileSync(path.join(root, "supabase/proposals/0037_breeches_products.sql"), "utf8");
const catalog = BREECHES.map((b, i) => ({ id: `p${i}`, sku: b.sku, name: `Name ${i}`, category: "tack", price: null, is_purchasable: false, fulfillment: "IN_STORE_ONLY" }));
const cart = { items: [], add() {} };

describe("breeches catalogue", () => {
  it("nine styles, every SKU in the migration, every photo file present", () => {
    expect(BREECHES).toHaveLength(9);
    for (const b of BREECHES) {
      expect(migration).toContain(`'${b.sku}'`);
      for (const img of b.images) expect(fs.existsSync(path.join(root, "public", img)), img).toBe(true);
    }
    expect(new Set(BREECHES.flatMap((b) => b.images)).size).toBe(BREECHES.reduce((n, b) => n + b.images.length, 0));
  });
  it("the migration sets no price and adds only tack collected in store", () => {
    const rows = migration.match(/\('TACK_BREECHES_[A-Z_]+',[^\n]+\)/g);
    expect(rows).toHaveLength(9);
    for (const r of rows) expect(r).toMatch(/'tack', '.+',\s+null, null, 'INR', 'IN_STORE_ONLY', true, \d+\)$/);
    expect(migration).toMatch(/on conflict \(sku\) do nothing/);
  });
  it("joins catalog rows with photos, filters and sorts", () => {
    const items = breechesProducts(catalog);
    expect(items).toHaveLength(9);
    expect(filterBreeches(items, { audience: "Kids" })).toHaveLength(6);
    expect(filterBreeches(items, { audience: "Women" })).toHaveLength(2);
    expect(filterBreeches(items, { audience: "Men" })).toHaveLength(1);
    expect(filterBreeches(items, { audience: "Kids", colour: "Black" })).toHaveLength(2);
    expect(coloursOf(items)).toContain("Charcoal");
    const priced = [{ price: 3000 }, { price: null }, { price: 2000 }];
    expect(sortBreeches(priced, "price-asc").map((x) => x.price)).toEqual([2000, 3000, null]);
    expect(sortBreeches(priced, "price-desc").map((x) => x.price)).toEqual([3000, 2000, null]);
    expect(isBreeches({ sku: "TACK_HELMET" })).toBe(false);
    expect(photoFor({ sku: "TACK_BREECHES_MEN_CHARCOAL" }).image).toBe("/assests/tack/breeches/men-charcoal/00.jpg");
    expect(photoFor({ sku: "TACK_HELMET" }).image).toBe("/assests/tack/helmet.jpeg");
  });
});

describe("no unconfirmed price is sold", () => {
  it("an unpriced style cannot enter the cart or reach a payment", () => {
    const p = catalog[0];
    expect(addItem([], p, 1)).toEqual([]);
    const r = resolveCart([{ productId: p.id, quantity: 1 }], catalog);
    expect(r.total).toBe(0);
    expect(r.lines.filter((l) => l.payable !== false && l.product?.price != null)).toHaveLength(0);
  });
  it("the grid shows Price coming soon, never a number or 'free'", () => {
    const html = renderToStaticMarkup(<BreechesShop items={breechesProducts(catalog)} cart={cart} selectedSku={null} onSelect={() => {}} />);
    expect(html.match(/Price coming soon/g)).toHaveLength(9);
    expect(html).not.toMatch(/₹|Free|free/);
    expect(html).toContain("Everyone"); // audience filter shown because the data has Women, Men and Kids
    for (const b of BREECHES) expect(html).toContain(b.images[0]);
  });
  it("the product page disables Add to cart and shows the gallery", () => {
    const items = breechesProducts(catalog);
    const html = renderToStaticMarkup(<BreechesShop items={items} cart={cart} selectedSku="TACK_BREECHES_MEN_CHARCOAL" onSelect={() => {}} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Price coming soon<\/button>/);
    expect(html).not.toContain(">Add to cart<");
    expect(html.match(/Show photo \d/g)).toHaveLength(6);
    expect(html).not.toMatch(/Sizes</); // no invented sizes
  });
  it("a style with a confirmed price becomes buyable, with its real price", () => {
    const items = breechesProducts(catalog.map((p, i) => (i === 2 ? { ...p, price: 4500, is_purchasable: true } : p)));
    const html = renderToStaticMarkup(<BreechesShop items={items} cart={cart} selectedSku="TACK_BREECHES_MEN_CHARCOAL" onSelect={() => {}} />);
    expect(html).toContain("₹4,500");
    expect(html).toContain(">Add to cart<");
  });
});

describe("the old generic Breeches card is withdrawn and the collection cards look like cards", () => {
  it("TACK_BREECHES is retired in the store and hidden (not deleted) by the migration, and the rollback restores it", async () => {
    // no hard-coded hiding in the site: the database decides (it is archived there), so an admin can republish it
    expect(fs.readFileSync(path.join(root, "src/store/useCatalog.js"), "utf8")).not.toContain("TACK_BREECHES");
    const prices = fs.readFileSync(path.join(root, "supabase/proposals/0038_breeches_prices.sql"), "utf8");
    expect(prices).toMatch(/update public\.store_products set is_active = false[^;]*where sku = 'TACK_BREECHES'/);
    expect(prices).not.toMatch(/delete from/i);
    const down = fs.readFileSync(path.join(root, "supabase/proposals/0038_breeches_prices.down.sql"), "utf8");
    expect(down).toMatch(/set is_active = true[^;]*where sku = 'TACK_BREECHES'/);
  });
});

describe("confirmed prices (0038)", () => {
  it("sets exactly the prices the club gave, in rupees, in the shop's order", () => {
    const sql = fs.readFileSync(path.join(root, "supabase/proposals/0038_breeches_prices.sql"), "utf8");
    const set = Object.fromEntries([...sql.matchAll(/\('(TACK_BREECHES_[A-Z_]+)',\s+([\d.]+)\)/g)].map((m) => [m[1], Number(m[2])]));
    expect(set).toEqual({
      TACK_BREECHES_WOMEN_NAVY: 8000, TACK_BREECHES_WOMEN_RED_BLACK: 4500, TACK_BREECHES_MEN_CHARCOAL: 6000,
      TACK_BREECHES_KIDS_NAVY_PINK: 3600, TACK_BREECHES_KIDS_MAGENTA_FLORAL: 3600, TACK_BREECHES_KIDS_PINK: 3600,
      TACK_BREECHES_KIDS_PURPLE: 3600, TACK_BREECHES_KIDS_BLACK_STARS: 3600, TACK_BREECHES_KIDS_BLACK_CAMO: 3600,
    });
    expect(Object.keys(set)).toEqual(BREECHES.map((b) => b.sku));
  });
  it("priced styles show their rupee price and can be added to the cart", () => {
    const priced = catalog.map((p, i) => ({ ...p, price: [8000, 4500, 6000][i] ?? 3600, is_purchasable: true }));
    const html = renderToStaticMarkup(<BreechesShop items={breechesProducts(priced)} cart={cart} selectedSku={null} onSelect={() => {}} />);
    expect(html).toContain("₹8,000");
    expect(html).toContain("₹4,500");
    expect(html).toContain("₹6,000");
    expect(html.match(/₹3,600/g)).toHaveLength(12); // price text + card label, for six styles
    expect(html).not.toContain("Price coming soon");
    expect(addItem([], priced[0], 1)).toHaveLength(1);
  });
  it("every breeches tile is a card: bordered, raised, lifts on hover, focusable, and says what it opens", () => {
    const html = renderToStaticMarkup(<BreechesShop items={breechesProducts(catalog)} cart={cart} selectedSku={null} onSelect={() => {}} />);
    const tiles = html.match(/<a [^>]*href="\?product=[^"]+"[^>]*>/g);
    expect(tiles).toHaveLength(9);
    for (const t of tiles) {
      expect(t).toMatch(/rounded-\[18px\]/);
      expect(t).toMatch(/border/);
      expect(t).toMatch(/hover:-translate-y-1\.5/);
      expect(t).toMatch(/focus-visible:outline/);
      expect(t).toMatch(/aria-label="[^"]+price coming soon\. View details"/);
    }
  });
});
