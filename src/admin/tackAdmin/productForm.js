/**
 * Pure helpers for the Tack Shop editor: turn a product from the database into form values and back, and check the form
 * before it is sent. The database checks everything again (admin_save_product); these checks only give quicker,
 * clearer messages. No price is ever filled in automatically.
 */
export const STATUSES = ["draft", "published", "archived"];
export const AUDIENCES = ["", "Women", "Men", "Kids", "Unisex"];

const lines = (v) => (Array.isArray(v) ? v.join("\n") : "");
const list = (text) => String(text ?? "").split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);

export function emptyForm() {
  return {
    id: null, name: "", sku: "", status: "draft", category_id: "", audience: "", brand: "",
    short_description: "", description: "", price: "", compare_at_price: "", cost_price: "", sort_order: "0",
    images: [], colour: "", sizes: "", material: "", fit: "", care: "", features: "", extra: [],
    variants: [],
  };
}

export function toForm(p) {
  const specs = p.specs ?? {};
  return {
    id: p.id, name: p.name ?? "", sku: p.sku ?? "", status: p.status ?? "draft", category_id: p.tack_category_id ?? "",
    audience: p.audience ?? "", brand: p.brand ?? "", short_description: p.short_description ?? "", description: p.description ?? "",
    price: p.price == null ? "" : String(Number(p.price)), compare_at_price: p.compare_at_price == null ? "" : String(Number(p.compare_at_price)),
    cost_price: p.cost_price == null ? "" : String(Number(p.cost_price)), sort_order: String(p.sort_order ?? 0),
    images: (Array.isArray(p.images) ? p.images : []).map((i) => ({ url: i.url, alt: i.alt ?? "" })),
    colour: specs.colour ?? "", sizes: lines(specs.sizes), material: specs.material ?? "", fit: specs.fit ?? "", care: specs.care ?? "",
    features: lines(specs.features), extra: Array.isArray(specs.extra) ? specs.extra.map((e) => ({ label: e.label ?? "", value: e.value ?? "" })) : [],
    variants: (p.variants ?? []).map((v) => ({
      id: v.id, sku: v.sku ?? "", size: v.size ?? "", colour: v.colour ?? "", price: v.price == null ? "" : String(Number(v.price)),
      in_stock: v.in_stock !== false, is_active: v.is_active !== false, order_count: v.order_count ?? 0,
    })),
  };
}

/** Money as typed: "", or a number with at most 2 decimals. Returns { ok, value } (value null for empty). */
export function parseMoney(text) {
  const t = String(text ?? "").trim().replace(/,/g, "");
  if (t === "") return { ok: true, value: null };
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return { ok: false };
  return { ok: true, value: t }; // sent as text: the database stores it as an exact decimal, never a float
}

/** Checks the form. Returns { errors: {field: message}, data, variants } ready for the save calls. */
export function fromForm(f) {
  const errors = {};
  const name = f.name.trim();
  const sku = f.sku.trim().toUpperCase();
  if (name.length < 2 || name.length > 120) errors.name = "Enter a name of 2 to 120 characters.";
  if (!/^[A-Z0-9][A-Z0-9_-]{2,59}$/.test(sku)) errors.sku = "Use 3 to 60 capital letters, numbers, - or _ (for example TACK_GLOVES_BLACK).";
  if (!STATUSES.includes(f.status)) errors.status = "Choose a status.";
  const price = parseMoney(f.price);
  const compare = parseMoney(f.compare_at_price);
  const cost = parseMoney(f.cost_price);
  if (!price.ok || (price.value != null && Number(price.value) <= 0)) errors.price = "Enter a price above 0, like 3600 or 3600.50, or leave it empty for “Price coming soon”.";
  if (!compare.ok) errors.compare_at_price = "Enter a number, or leave it empty.";
  else if (compare.value != null && (price.value == null || Number(compare.value) < Number(price.value))) errors.compare_at_price = "The compare-at price must be at least the selling price.";
  if (!cost.ok) errors.cost_price = "Enter a number, or leave it empty.";
  if (f.status === "published" && price.value == null) errors.publishWarning = "Published without a price: shoppers will see “Price coming soon” and can't buy it.";
  if (f.images.length > 12) errors.images = "Use at most 12 photos.";
  if (f.short_description.length > 300) errors.short_description = "Keep the short description under 300 characters.";
  if (f.description.length > 4000) errors.description = "Keep the description under 4000 characters.";

  const specs = {};
  if (f.colour.trim()) specs.colour = f.colour.trim();
  if (list(f.sizes).length) specs.sizes = list(f.sizes);
  if (f.material.trim()) specs.material = f.material.trim();
  if (f.fit.trim()) specs.fit = f.fit.trim();
  if (f.care.trim()) specs.care = f.care.trim();
  const features = String(f.features ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (features.length) specs.features = features;
  const extra = f.extra.map((e) => ({ label: e.label.trim(), value: e.value.trim() })).filter((e) => e.label && e.value);
  if (extra.length) specs.extra = extra;

  const seen = new Set();
  const variants = f.variants.map((v, i) => {
    const vsku = v.sku.trim().toUpperCase();
    const vp = parseMoney(v.price);
    if (!/^[A-Z0-9][A-Z0-9_-]{2,79}$/.test(vsku)) errors[`variant${i}`] = `Size ${i + 1}: enter a SKU (capital letters, numbers, - or _).`;
    else if (seen.has(vsku) || vsku === sku) errors[`variant${i}`] = `Size ${i + 1}: SKU ${vsku} is used twice.`;
    if (!v.size.trim() && !v.colour.trim()) errors[`variant${i}`] = `Size ${i + 1}: enter a size or a colour.`;
    if (!vp.ok || (vp.value != null && Number(vp.value) <= 0)) errors[`variant${i}`] = `Size ${i + 1}: the price must be above 0, or empty to use the product price.`;
    seen.add(vsku);
    return { id: v.id ?? null, sku: vsku, size: v.size.trim(), colour: v.colour.trim(), price: vp.value, in_stock: v.in_stock, is_active: v.is_active };
  });

  const data = {
    name, sku, status: f.status, category_id: f.category_id || null, audience: f.audience || null, brand: f.brand.trim() || null,
    short_description: f.short_description.trim() || null, description: f.description.trim() || null,
    price: price.value, compare_at_price: compare.value, cost_price: cost.value, sort_order: Number.parseInt(f.sort_order, 10) || 0,
    images: f.images.map((i) => ({ url: i.url, alt: i.alt.trim() })), specs,
  };
  const blocking = Object.keys(errors).filter((k) => k !== "publishWarning");
  return { errors, ok: blocking.length === 0, data, variants };
}

/** Moves an item in a list (used to reorder photos; index 0 is the main photo). */
export function move(list, from, to) {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Shop availability in words, the way a shopper experiences it. */
export function availabilityOf(p) {
  if (p.status !== "published") return p.status === "archived" ? "Archived" : "Not visible (draft)";
  if (p.price == null) return "Visible · price coming soon";
  const vs = (p.variants ?? []).filter((v) => v.is_active);
  if (vs.length && !vs.some((v) => v.in_stock)) return "Visible · all sizes out of stock";
  return "On sale";
}
