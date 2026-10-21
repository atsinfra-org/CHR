import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { availabilityOf, emptyForm, fromForm, move, parseMoney, toForm } from "./productForm";
import { checkImageFile, sniffImageType, uploadProductImage } from "./images";

vi.mock("../../lib/supabaseClient", () => ({ supabase: { rpc: vi.fn(), storage: { from: vi.fn() } } }));
let hook = { data: null, status: "loading", error: null, reload: () => {} };
vi.mock("../useAdminQuery", () => ({ useAdminQuery: () => hook }));
const { default: AdminTackShop } = await import("../pages/AdminTackShop.jsx");
const { VALID_ROUTES } = await import("../useAdminRoute.js");
const { PAGE_META } = await import("../adminNav.js");

const product = (o = {}) => ({
  id: "p1", sku: "TACK_HELMET", name: "Helmet", status: "published", price: "2500.00", compare_at_price: null, tack_category_id: "c1",
  category_name: "Helmets", audience: null, brand: null, short_description: "Essential head protection.", description: null, sort_order: 0,
  specs: { colour: "Black", sizes: ["S", "M"], features: ["Vented"], extra: [{ label: "Standard", value: "VG1" }] },
  images: [{ url: "/assests/tack/helmet.jpeg", alt: "Riding helmet" }], variants: [], order_count: 1, cost_price: null, updated_at: "2026-10-21T05:00:00Z", ...o,
});
const file = (bytes, name = "x.jpg", size) => ({ name, size: size ?? Math.max(bytes.length, 200), slice: () => ({ arrayBuffer: async () => new Uint8Array(bytes).buffer }) });
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const WEBP = [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")];

describe("product form", () => {
  it("loads every current value (nothing reset to blank)", () => {
    const f = toForm(product());
    expect(f).toMatchObject({ name: "Helmet", sku: "TACK_HELMET", price: "2500", status: "published", category_id: "c1", colour: "Black", sizes: "S\nM", features: "Vented", short_description: "Essential head protection." });
    expect(f.extra).toEqual([{ label: "Standard", value: "VG1" }]);
    expect(f.images).toEqual([{ url: "/assests/tack/helmet.jpeg", alt: "Riding helmet" }]);
  });
  it("round-trips without changing anything", () => {
    const out = fromForm(toForm(product()));
    expect(out.ok).toBe(true);
    expect(out.data).toMatchObject({ name: "Helmet", sku: "TACK_HELMET", price: "2500", status: "published", category_id: "c1" });
    expect(out.data.specs).toEqual({ colour: "Black", sizes: ["S", "M"], features: ["Vented"], extra: [{ label: "Standard", value: "VG1" }] });
  });
  it("money is sent as exact text, never a float, and validated", () => {
    expect(parseMoney("3,600.50")).toEqual({ ok: true, value: "3600.50" });
    expect(parseMoney("")).toEqual({ ok: true, value: null });
    expect(parseMoney("12.345").ok).toBe(false);
    expect(parseMoney("-5").ok).toBe(false);
    expect(parseMoney("1e3").ok).toBe(false);
    expect(fromForm({ ...emptyForm(), name: "Gloves", sku: "TACK_GLOVES", price: "0" }).errors.price).toBeTruthy();
    expect(fromForm({ ...emptyForm(), name: "Gloves", sku: "TACK_GLOVES", price: "2000", compare_at_price: "1500" }).errors.compare_at_price).toMatch(/at least/);
    expect(fromForm({ ...emptyForm(), name: "Gloves", sku: "TACK_GLOVES", compare_at_price: "1500" }).errors.compare_at_price).toBeTruthy();
  });
  it("a new product has no price unless one is typed, and publishing without one only warns", () => {
    const f = { ...emptyForm(), name: "Gloves", sku: "tack_gloves", status: "published" };
    const out = fromForm(f);
    expect(out.ok).toBe(true);
    expect(out.data.price).toBeNull();
    expect(out.data.sku).toBe("TACK_GLOVES");
    expect(out.errors.publishWarning).toMatch(/Price coming soon/);
    expect(emptyForm().status).toBe("draft");
  });
  it("refuses bad names, SKUs and variants with field messages", () => {
    const out = fromForm({ ...emptyForm(), name: "G", sku: "x y", variants: [{ sku: "", size: "", colour: "", price: "-1", in_stock: true, is_active: true }] });
    expect(out.ok).toBe(false);
    expect(out.errors.name).toBeTruthy();
    expect(out.errors.sku).toBeTruthy();
    expect(out.errors.variant0).toBeTruthy();
    const dup = fromForm({ ...emptyForm(), name: "Gloves", sku: "TACK_GLOVES", variants: [{ sku: "TACK_GLOVES_S", size: "S", colour: "", price: "", in_stock: true, is_active: true }, { sku: "tack_gloves_s", size: "M", colour: "", price: "", in_stock: true, is_active: true }] });
    expect(dup.errors.variant1).toMatch(/twice/);
  });
  it("only real specifications are sent; empty ones are left out", () => {
    const out = fromForm({ ...emptyForm(), name: "Gloves", sku: "TACK_GLOVES", material: " Leather ", extra: [{ label: "", value: "x" }] });
    expect(out.data.specs).toEqual({ material: "Leather" });
  });
  it("reorders photos (the first is the main photo)", () => {
    expect(move(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(move(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  });
  it("says what a shopper sees", () => {
    expect(availabilityOf(product())).toBe("On sale");
    expect(availabilityOf(product({ price: null }))).toMatch(/price coming soon/);
    expect(availabilityOf(product({ status: "draft" }))).toMatch(/Not visible/);
    expect(availabilityOf(product({ status: "archived" }))).toBe("Archived");
    expect(availabilityOf(product({ variants: [{ is_active: true, in_stock: false }] }))).toMatch(/out of stock/);
  });
});

describe("photo uploads", () => {
  it("recognises JPEG, PNG and WebP by their bytes, not their names", () => {
    expect(sniffImageType(JPEG)).toBe("jpg");
    expect(sniffImageType(PNG)).toBe("png");
    expect(sniffImageType(WEBP)).toBe("webp");
    expect(sniffImageType([...Buffer.from("<svg onload=alert(1)>")])).toBeNull();
    expect(sniffImageType([...Buffer.from("GIF89a......")])).toBeNull();
  });
  it("refuses fakes, empty files and files over 5 MB", async () => {
    expect((await checkImageFile(file([...Buffer.from("<html>not an image</html>")], "photo.jpg"))).ok).toBe(false);
    expect((await checkImageFile(file(JPEG, "big.jpg", 6 * 1024 * 1024))).error).toMatch(/5 MB/);
    expect((await checkImageFile(file(JPEG, "tiny.jpg", 10))).ok).toBe(false);
    expect(await checkImageFile(file(PNG, "ok.png"))).toEqual({ ok: true, type: "png" });
  });
  it("uploads under a new unique name with the real type, and returns the public URL", async () => {
    const calls = [];
    const client = { storage: { from: (b) => ({
      upload: async (path, f, opts) => { calls.push({ b, path, opts }); return { error: null }; },
      getPublicUrl: (path) => ({ data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/${b}/${path}` } }),
    }) } };
    const out = await uploadProductImage(file(WEBP, "anything.jpg"), "TACK_GLOVES", client);
    expect(calls[0].b).toBe("tack-images");
    expect(calls[0].path).toMatch(/^products\/tack-gloves\/\d+-[a-z0-9]+\.webp$/);
    expect(calls[0].opts).toMatchObject({ contentType: "image/webp", upsert: false });
    expect(out.url).toMatch(/^https:\/\/x\.supabase\.co\/storage\/v1\/object\/public\/tack-images\/products\/tack-gloves\/.+\.webp$/);
  });
  it("a refused upload (not an administrator) says so; a fake image never reaches storage", async () => {
    const client = { storage: { from: () => ({ upload: async () => ({ error: { message: "new row violates row-level security policy" } }), getPublicUrl: () => ({}) }) } };
    expect((await uploadProductImage(file(JPEG), "X", client)).error).toBe("Only administrators can upload shop photos.");
    const spy = vi.fn();
    expect((await uploadProductImage(file([...Buffer.from("text text text text")]), "X", { storage: { from: () => ({ upload: spy }) } })).error).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Admin -> Tack Shop page", () => {
  const render = (state) => { hook = { reload: () => {}, error: null, data: null, ...state }; return renderToStaticMarkup(<AdminTackShop />); };
  it("is an administrators-only route", () => {
    expect(VALID_ROUTES).toContain("tack");
    expect(PAGE_META.tack).toMatchObject({ title: "Tack Shop", adminOnly: true });
  });
  it("loading and error states", () => {
    expect(render({ status: "loading" })).toContain("Loading the Tack Shop");
    expect(render({ status: "error", error: "Boom" })).toContain("Boom");
  });
  it("lists products with photo, SKU, category, price, status and actions", () => {
    const html = render({ status: "ready", data: { categories: [{ id: "c1", name: "Helmets", is_active: true, product_count: 1, sort_order: 10 }], products: [product(), product({ id: "p2", sku: "TACK_GLOVES", name: "Gloves", status: "draft", price: null, order_count: 0, images: [] })] } });
    for (const t of ["Helmet", "TACK_HELMET", "Helmets", "₹2,500", "Gloves", "Not set", "Add product", "Unpublish", "Publish", "Archive", "On sale", "Not visible (draft)"]) expect(html).toContain(t);
    expect(html).toContain('aria-label="Delete Gloves"'); // never ordered, not published
    expect(html).not.toContain('aria-label="Delete Helmet"'); // ordered: archive only
    expect(html).toContain('aria-label="Duplicate Helmet"');
    expect(html).toContain('aria-label="Edit Helmet"');
  });
  it("an empty shop says so", () => {
    expect(render({ status: "ready", data: { categories: [], products: [] } })).toContain("No products");
  });
});
