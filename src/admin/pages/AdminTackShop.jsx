import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Eye, ImagePlus, Pencil, Plus, RefreshCw, Star, Trash2, X } from "lucide-react";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import { ActionButton, Card, Empty, ErrorBox, InlineError, Loading, PageHeader, SearchField, SelectField, StatusPill, TableShell, Toolbar } from "../ui";
import { fmtDateTime, fmtMoney } from "../adminUtils";
import { ACCEPT, uploadProductImage } from "../tackAdmin/images";
import { AUDIENCES, STATUSES, availabilityOf, emptyForm, fromForm, move, toForm } from "../tackAdmin/productForm";
import { ProductDetail } from "../../store/TackShop";
import { shopItem } from "../../store/tackCatalog";

/**
 * Admin -> Tack Shop: every Tack Shop product and category, managed here. Saves go through the administrator-only
 * functions of migration 0039 (each re-checks the role, validates and audits); the shop reads the same data live.
 * Prices are never filled in automatically, and a product with orders is archived, never deleted.
 */
const PAGE = 20;

export default function AdminTackShop({ initialEditing = null }) {
  const { data, status, error, reload } = useAdminQuery(() => adminApi.tackCatalog());
  const [tab, setTab] = useState("products");
  const [editing, setEditing] = useState(initialEditing); // product id, "new", or null
  const [notice, setNotice] = useState(null);
  const products = data?.products ?? [];
  const categories = data?.categories ?? [];

  const done = (msg) => {
    setNotice(msg);
    reload();
  };

  if (editing) {
    const product = editing === "new" ? null : products.find((p) => p.id === editing);
    return (
      <ProductEditor key={editing} product={product} categories={categories}
        onClose={(msg) => { setEditing(null); if (msg) done(msg); }} />
    );
  }

  return (
    <div>
      <PageHeader route="tack" actions={
        <>
          <ActionButton icon={RefreshCw} onClick={reload}>Refresh</ActionButton>
          {tab === "products" && <ActionButton variant="primary" icon={Plus} onClick={() => setEditing("new")}>Add product</ActionButton>}
        </>
      } />
      <div className="mb-5 flex gap-2" role="tablist">
        {[["products", "Products"], ["categories", "Categories"]].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`rounded-full border px-4 py-2 font-sans text-sm ${tab === k ? "border-[#1F3A2E] bg-[#1F3A2E] text-[#F7F3EA]" : "border-[#B08D57]/35 bg-white text-charcoal hover:border-[#B08D57]"}`}>{l}</button>
        ))}
      </div>
      {notice && <p role="status" className="mb-4 rounded-[12px] border border-racing-green/25 bg-racing-green/[0.06] px-4 py-3 font-sans text-sm text-racing-green">{notice}</p>}
      {status === "error" && <ErrorBox message={error} onRetry={reload} />}
      {status === "loading" && !data && <Loading>Loading the Tack Shop…</Loading>}
      {data && (tab === "products"
        ? <ProductList products={products} categories={categories} onEdit={setEditing} onDone={done} />
        : <Categories categories={categories} onDone={done} />)}
    </div>
  );
}

/* ================================================================ LIST */

function ProductList({ products, categories, onEdit, onDone }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [st, setSt] = useState("all");
  const [sort, setSort] = useState("order");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [preview, setPreview] = useState(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = products.filter((p) => (cat === "all" || (p.tack_category_id ?? "none") === cat) && (st === "all" || p.status === st)
      && (!needle || p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle)));
    const by = {
      order: (a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
      price: (a, b) => (a.price == null) - (b.price == null) || Number(a.price) - Number(b.price),
      updated: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)),
    }[sort];
    return [...list].sort(by);
  }, [products, q, cat, st, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);

  async function act(p, fn, msg, confirm) {
    if (busy) return;
    if (confirm && !window.confirm(confirm)) return;
    setBusy(p.id);
    setErr(null);
    const res = await fn();
    setBusy(null);
    if (res.error) setErr(res.error);
    else onDone(msg);
  }

  return (
    <>
      <Toolbar>
        <SearchField value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="Search by name or SKU" className="w-full sm:w-64" />
        <SelectField label="Category" value={cat} onChange={(e) => { setCat(e.target.value); setPage(0); }} className="w-full sm:w-44">
          <option value="all">All</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value="none">No category</option>
        </SelectField>
        <SelectField label="Status" value={st} onChange={(e) => { setSt(e.target.value); setPage(0); }} className="w-full sm:w-36">
          <option value="all">All</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </SelectField>
        <SelectField label="Sort" value={sort} onChange={(e) => setSort(e.target.value)} className="w-full sm:w-40">
          <option value="order">Shop order</option>
          <option value="name">Name</option>
          <option value="price">Price</option>
          <option value="updated">Recently updated</option>
        </SelectField>
      </Toolbar>
      {err && <InlineError message={err} />}
      {rows.length === 0 ? (
        <Empty icon={ImagePlus} detail="Add a product, or change the filters.">No products</Empty>
      ) : (
        <TableShell head={["", "Product", "SKU", "Category", "Price", "Status", "In the shop", "Updated", ""]} minWidth="1080px">
          {shown.map((p) => (
            <tr key={p.id} className="border-b border-charcoal/[0.06] align-middle last:border-0 hover:bg-soft-cream/40">
              <td className="py-2.5 pl-4">
                <div className="h-14 w-12 overflow-hidden rounded-[8px] border border-[#e8e1d1] bg-white">
                  {p.images?.[0]?.url ? <img src={p.images[0].url} alt="" loading="lazy" className="h-full w-full object-contain" /> : null}
                </div>
              </td>
              <td className="px-4 py-2.5 font-sans text-sm font-medium text-charcoal">{p.name}</td>
              <td className="px-4 py-2.5 font-mono text-[11px] text-warm-grey">{p.sku}</td>
              <td className="px-4 py-2.5 font-sans text-sm text-warm-grey">{p.category_name ?? "—"}</td>
              <td className="whitespace-nowrap px-4 py-2.5 font-sans text-sm text-charcoal">
                {p.price == null ? <span className="italic text-[#B08D57]">Not set</span> : fmtMoney(p.price)}
                {p.compare_at_price != null && <s className="ml-1.5 text-xs text-warm-grey">{fmtMoney(p.compare_at_price)}</s>}
              </td>
              <td className="px-4 py-2.5"><StatusPill value={p.status} /></td>
              <td className="px-4 py-2.5 font-sans text-xs text-warm-grey">{availabilityOf(p)}</td>
              <td className="whitespace-nowrap px-4 py-2.5 font-sans text-xs text-warm-grey">{p.updated_at ? fmtDateTime(p.updated_at) : "—"}</td>
              <td className="px-4 py-2.5">
                <div className="flex flex-wrap justify-end gap-1.5">
                  <IconBtn label={`Preview ${p.name}`} onClick={() => setPreview(p)}><Eye size={15} /></IconBtn>
                  <IconBtn label={`Edit ${p.name}`} onClick={() => onEdit(p.id)}><Pencil size={15} /></IconBtn>
                  <IconBtn label={`Duplicate ${p.name}`} disabled={busy === p.id} onClick={() => act(p, () => adminApi.duplicateProduct(p.id), `${p.name} copied as a draft with no price.`)}><Copy size={15} /></IconBtn>
                  {p.status === "published" ? (
                    <SmallBtn disabled={busy === p.id} onClick={() => act(p, () => adminApi.setProductStatus(p.id, "draft"), `${p.name} unpublished.`, `Unpublish ${p.name}? It disappears from the shop.`)}>Unpublish</SmallBtn>
                  ) : (
                    <SmallBtn disabled={busy === p.id} onClick={() => act(p, () => adminApi.setProductStatus(p.id, "published"), `${p.name} published.`, p.price == null ? `Publish ${p.name} without a price? Shoppers will see “Price coming soon” and can't buy it.` : `Publish ${p.name} at ${fmtMoney(p.price)}?`)}>Publish</SmallBtn>
                  )}
                  {p.status !== "archived" && (
                    <SmallBtn disabled={busy === p.id} onClick={() => act(p, () => adminApi.setProductStatus(p.id, "archived"), `${p.name} archived.`, `Archive ${p.name}? It leaves the shop and can't be bought. Orders are kept.`)}>Archive</SmallBtn>
                  )}
                  {p.status !== "published" && Number(p.order_count) === 0 && (
                    <IconBtn label={`Delete ${p.name}`} danger disabled={busy === p.id} onClick={() => act(p, () => adminApi.deleteProduct(p.id), `${p.name} deleted.`, `Delete ${p.name} permanently? It has never been ordered. This can't be undone.`)}><Trash2 size={15} /></IconBtn>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </TableShell>
      )}
      {pages > 1 && (
        <div className="mt-4 flex items-center justify-end gap-2 font-sans text-sm text-warm-grey">
          <SmallBtn disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</SmallBtn>
          Page {page + 1} of {pages}
          <SmallBtn disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</SmallBtn>
        </div>
      )}
      {preview && <PreviewModal product={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

function IconBtn({ label, children, danger = false, ...rest }) {
  return (
    <button type="button" aria-label={label} title={label} {...rest}
      className={`flex h-8 w-8 items-center justify-center rounded-[8px] border bg-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#B08D57] disabled:opacity-40 ${danger ? "border-destructive/30 text-destructive hover:bg-destructive/5" : "border-[#B08D57]/35 text-charcoal hover:border-[#1F3A2E]"}`}>
      {children}
    </button>
  );
}
function SmallBtn({ children, ...rest }) {
  return <button type="button" {...rest} className="h-8 rounded-[8px] border border-[#B08D57]/35 bg-white px-2.5 font-sans text-xs text-charcoal hover:border-[#1F3A2E] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#B08D57] disabled:opacity-40">{children}</button>;
}

/** How the product page looks to a shopper (the real shop component, with a dummy cart). */
function PreviewModal({ product, onClose }) {
  const item = shopItem({ ...product, is_purchasable: product.status === "published" && product.price != null, variants: (product.variants ?? []).filter((v) => v.is_active) });
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-deep-forest/50 p-4" role="dialog" aria-modal="true" aria-label={`Preview of ${product.name}`} onClick={onClose}>
      <div className="relative w-full max-w-5xl rounded-[18px] bg-[#F7F3EA] p-5 sm:p-8" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <p className="font-sans text-xs tracking-[0.14em] text-warm-grey uppercase">Shopper preview{product.status !== "published" ? ` · ${product.status}, not visible in the shop` : ""}</p>
          <IconBtn label="Close preview" onClick={onClose}><X size={15} /></IconBtn>
        </div>
        <ProductDetail item={item} cart={{ items: [], add() {} }} onBack={onClose} />
      </div>
    </div>
  );
}

/* ================================================================ EDITOR */

function Field({ label, error, hint, children, className = "" }) {
  return (
    <label className={`block ${className}`}>
      <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && !error && <span className="mt-1 block font-sans text-xs text-warm-grey">{hint}</span>}
      {error && <span role="alert" className="mt-1 block font-sans text-xs text-destructive">{error}</span>}
    </label>
  );
}
const input = "block w-full rounded-[12px] border border-antique-gold/25 bg-white px-3 py-2.5 font-sans text-sm text-charcoal outline-none focus:border-[#1F3A2E]";

function ProductEditor({ product, categories, onClose }) {
  const initial = useMemo(() => (product ? toForm(product) : emptyForm()), [product]);
  const [f, setF] = useState(initial);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState(null);
  const fileRef = useRef(null);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);

  useEffect(() => {
    const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const cancel = () => { if (!dirty || window.confirm("Discard your unsaved changes?")) onClose(null); };

  async function addFiles(files) {
    setUploadError(null);
    const list = [...files].slice(0, Math.max(0, 12 - f.images.length));
    for (const file of list) {
      setUploading((n) => n + 1);
      const res = await uploadProductImage(file, f.sku || f.name);
      setUploading((n) => n - 1);
      if (res.error) setUploadError(res.error);
      else setF((s) => ({ ...s, images: [...s.images, { url: res.url, alt: s.name }] }));
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  async function save() {
    const out = fromForm(f);
    setErrors(out.errors);
    setSaveError(null);
    if (!out.ok) return;
    if (out.errors.publishWarning && !window.confirm(out.errors.publishWarning + " Save anyway?")) return;
    setSaving(true);
    const res = await adminApi.saveProduct(f.id, out.data);
    if (res.error) { setSaving(false); setSaveError(res.error); return; }
    const id = res.data;
    const variantsChanged = JSON.stringify(f.variants) !== JSON.stringify(initial.variants);
    if (variantsChanged) {
      const v = await adminApi.saveVariants(id, out.variants);
      if (v.error) {
        setSaving(false);
        setF((s) => ({ ...s, id }));
        setSaveError(`The product was saved, but the sizes were not: ${v.error}`);
        return;
      }
    }
    setSaving(false);
    onClose(`${out.data.name} saved.`);
  }

  const variantErrors = Object.entries(errors).filter(([k]) => k.startsWith("variant")).map(([, v]) => v);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-sans text-[10.5px] tracking-[0.22em] text-antique-gold uppercase">Tack Shop</p>
          <h1 className="mt-1 font-serif text-[1.85rem] leading-tight text-charcoal">{product ? `Edit ${product.name}` : "Add a product"}</h1>
          {product && Number(product.order_count) > 0 && <p className="mt-1 font-sans text-xs text-warm-grey">Ordered {product.order_count} time{Number(product.order_count) === 1 ? "" : "s"}. Past orders keep the price and name they were bought at.</p>}
        </div>
        <div className="flex gap-2">
          <ActionButton onClick={cancel} disabled={saving}>Cancel</ActionButton>
          <ActionButton variant="primary" onClick={save} disabled={saving || uploading > 0}>{saving ? "Saving…" : "Save changes"}</ActionButton>
        </div>
      </div>
      {saveError && <div className="mb-4"><InlineError message={saveError} /></div>}
      {dirty && <p className="mb-4 font-sans text-xs text-warm-grey">You have unsaved changes.</p>}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card>
            <h2 className="mb-4 font-serif text-lg text-charcoal">Basic information</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Product name" error={errors.name} className="sm:col-span-2"><input className={input} value={f.name} onChange={set("name")} maxLength={120} /></Field>
              <Field label="SKU (product code)" error={errors.sku} hint={product ? "Changing it doesn't affect past orders." : "For example TACK_GLOVES_BLACK"}><input className={`${input} font-mono uppercase`} value={f.sku} onChange={set("sku")} maxLength={60} /></Field>
              <Field label="Status" error={errors.status}>
                <select className={input} value={f.status} onChange={set("status")}>
                  <option value="draft">Draft (not in the shop)</option>
                  <option value="published">Published (in the shop)</option>
                  <option value="archived">Archived (discontinued)</option>
                </select>
              </Field>
              <Field label="Category">
                <select className={input} value={f.category_id} onChange={set("category_id")}>
                  <option value="">No category</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_active ? "" : " (switched off)"}</option>)}
                </select>
              </Field>
              <Field label="For">
                <select className={input} value={f.audience} onChange={set("audience")}>
                  {AUDIENCES.map((a) => <option key={a} value={a}>{a || "Not specified"}</option>)}
                </select>
              </Field>
              <Field label="Brand (optional)"><input className={input} value={f.brand} onChange={set("brand")} maxLength={60} /></Field>
              <Field label="Position in the shop" hint="Lower numbers come first."><input className={input} inputMode="numeric" value={f.sort_order} onChange={set("sort_order")} /></Field>
              <Field label="Short description" error={errors.short_description} className="sm:col-span-2" hint="One or two lines, shown on the product card."><input className={input} value={f.short_description} onChange={set("short_description")} maxLength={300} /></Field>
              <Field label="Full description" error={errors.description} className="sm:col-span-2"><textarea className={`${input} min-h-[120px]`} value={f.description} onChange={set("description")} maxLength={4000} /></Field>
            </div>
          </Card>

          <Card>
            <h2 className="mb-1 font-serif text-lg text-charcoal">Photos</h2>
            <p className="mb-4 font-sans text-xs text-warm-grey">JPEG, PNG or WebP, up to 5 MB each, at most 12. The first photo is the main one on the product card.</p>
            {errors.images && <InlineError message={errors.images} />}
            {uploadError && <div className="mb-3"><InlineError message={uploadError} /></div>}
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {f.images.map((img, i) => (
                <li key={img.url + i} className="rounded-[12px] border border-[#e8e1d1] bg-white p-2">
                  <div className="relative aspect-[4/5] overflow-hidden rounded-[8px] bg-white">
                    <img src={img.url} alt={img.alt || ""} className="h-full w-full object-contain" />
                    {i === 0 && <span className="absolute top-1.5 left-1.5 rounded-full bg-[#1F3A2E] px-2 py-0.5 font-sans text-[10px] text-[#F7F3EA]">Main photo</span>}
                  </div>
                  <input className="mt-2 block w-full rounded-[8px] border border-antique-gold/25 px-2 py-1.5 font-sans text-xs" placeholder="Describe the photo" aria-label={`Description of photo ${i + 1}`}
                    value={img.alt} maxLength={200} onChange={(e) => setF((s) => ({ ...s, images: s.images.map((x, j) => (j === i ? { ...x, alt: e.target.value } : x)) }))} />
                  <div className="mt-2 flex justify-between gap-1">
                    <IconBtn label="Make main photo" disabled={i === 0} onClick={() => setF((s) => ({ ...s, images: move(s.images, i, 0) }))}><Star size={14} /></IconBtn>
                    <IconBtn label="Move earlier" disabled={i === 0} onClick={() => setF((s) => ({ ...s, images: move(s.images, i, i - 1) }))}><ArrowUp size={14} /></IconBtn>
                    <IconBtn label="Move later" disabled={i === f.images.length - 1} onClick={() => setF((s) => ({ ...s, images: move(s.images, i, i + 1) }))}><ArrowDown size={14} /></IconBtn>
                    <IconBtn label="Remove photo" danger onClick={() => setF((s) => ({ ...s, images: s.images.filter((_, j) => j !== i) }))}><Trash2 size={14} /></IconBtn>
                  </div>
                </li>
              ))}
              {f.images.length < 12 && (
                <li>
                  <label className="flex aspect-[4/5] h-full cursor-pointer flex-col items-center justify-center gap-2 rounded-[12px] border-2 border-dashed border-[#B08D57]/40 bg-white/60 p-3 text-center font-sans text-xs text-warm-grey hover:border-[#1F3A2E]">
                    <ImagePlus size={22} className="text-[#B08D57]" />
                    {uploading > 0 ? "Uploading…" : "Add photos"}
                    <input ref={fileRef} type="file" accept={ACCEPT} multiple className="sr-only" disabled={uploading > 0} onChange={(e) => addFiles(e.target.files)} />
                  </label>
                </li>
              )}
            </ul>
            <p className="mt-3 font-sans text-xs text-warm-grey">Removing a photo here doesn't delete the file, so past orders and links keep working.</p>
          </Card>

          <Card>
            <h2 className="mb-1 font-serif text-lg text-charcoal">Specifications</h2>
            <p className="mb-4 font-sans text-xs text-warm-grey">All optional. Fill in only what is true for this product; empty fields are not shown to shoppers.</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Colour"><input className={input} value={f.colour} onChange={set("colour")} maxLength={60} /></Field>
              <Field label="Sizes offered" hint="Comma or one per line. For sizes shoppers must choose, use Sizes & stock below."><input className={input} value={f.sizes} onChange={set("sizes")} /></Field>
              <Field label="Material / fabric"><input className={input} value={f.material} onChange={set("material")} maxLength={200} /></Field>
              <Field label="Fit"><input className={input} value={f.fit} onChange={set("fit")} maxLength={200} /></Field>
              <Field label="Care instructions" className="sm:col-span-2"><input className={input} value={f.care} onChange={set("care")} maxLength={300} /></Field>
              <Field label="Features" hint="One per line." className="sm:col-span-2"><textarea className={`${input} min-h-[80px]`} value={f.features} onChange={set("features")} /></Field>
            </div>
            <div className="mt-4">
              <p className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">Other details</p>
              {f.extra.map((e, i) => (
                <div key={i} className="mt-2 flex gap-2">
                  <input className={input} placeholder="Label, e.g. Certification" value={e.label} onChange={(ev) => setF((s) => ({ ...s, extra: s.extra.map((x, j) => (j === i ? { ...x, label: ev.target.value } : x)) }))} />
                  <input className={input} placeholder="Value" value={e.value} onChange={(ev) => setF((s) => ({ ...s, extra: s.extra.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)) }))} />
                  <IconBtn label="Remove detail" danger onClick={() => setF((s) => ({ ...s, extra: s.extra.filter((_, j) => j !== i) }))}><X size={14} /></IconBtn>
                </div>
              ))}
              <SmallBtn onClick={() => setF((s) => ({ ...s, extra: [...s.extra, { label: "", value: "" }] }))}>+ Add a detail</SmallBtn>
            </div>
          </Card>

          <Card>
            <h2 className="mb-1 font-serif text-lg text-charcoal">Sizes & stock</h2>
            <p className="mb-4 font-sans text-xs text-warm-grey">Only if shoppers must pick a size or colour. Each needs its own SKU. Leave the price empty to use the product price. Stock is in stock / out of stock (no counted inventory).</p>
            {variantErrors.map((m) => <p key={m} role="alert" className="mb-1 font-sans text-xs text-destructive">{m}</p>)}
            {f.variants.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] font-sans text-sm">
                  <thead><tr className="text-left text-[10.5px] tracking-[0.14em] text-warm-grey uppercase"><th className="py-2">SKU</th><th>Size</th><th>Colour</th><th>Price (₹)</th><th>In stock</th><th>On sale</th><th /></tr></thead>
                  <tbody>
                    {f.variants.map((v, i) => {
                      const upd = (k, val) => setF((s) => ({ ...s, variants: s.variants.map((x, j) => (j === i ? { ...x, [k]: val } : x)) }));
                      return (
                        <tr key={v.id ?? `new${i}`} className="border-t border-charcoal/[0.06]">
                          <td className="py-1.5 pr-2"><input aria-label="Size SKU" className={`${input} font-mono uppercase`} value={v.sku} onChange={(e) => upd("sku", e.target.value)} /></td>
                          <td className="pr-2"><input aria-label="Size" className={input} value={v.size} onChange={(e) => upd("size", e.target.value)} /></td>
                          <td className="pr-2"><input aria-label="Colour" className={input} value={v.colour} onChange={(e) => upd("colour", e.target.value)} /></td>
                          <td className="pr-2"><input aria-label="Size price" className={input} inputMode="decimal" placeholder="Product price" value={v.price} onChange={(e) => upd("price", e.target.value)} /></td>
                          <td className="text-center"><input type="checkbox" aria-label="In stock" checked={v.in_stock} onChange={(e) => upd("in_stock", e.target.checked)} /></td>
                          <td className="text-center"><input type="checkbox" aria-label="On sale" checked={v.is_active} onChange={(e) => upd("is_active", e.target.checked)} /></td>
                          <td><IconBtn label={v.order_count > 0 ? "Remove (it was ordered, so it is switched off instead)" : "Remove size"} danger onClick={() => setF((s) => ({ ...s, variants: s.variants.filter((_, j) => j !== i) }))}><Trash2 size={14} /></IconBtn></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-3"><SmallBtn onClick={() => setF((s) => ({ ...s, variants: [...s.variants, { id: null, sku: s.sku ? `${s.sku.toUpperCase()}_` : "", size: "", colour: "", price: "", in_stock: true, is_active: true, order_count: 0 }] }))}>+ Add a size or colour</SmallBtn></div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <h2 className="mb-4 font-serif text-lg text-charcoal">Pricing</h2>
            <div className="space-y-4">
              <Field label="Selling price (₹)" error={errors.price} hint="Leave empty for “Price coming soon”: the product then can't be bought."><input className={input} inputMode="decimal" value={f.price} onChange={set("price")} placeholder="Not set" /></Field>
              <Field label="Compare-at price (₹, optional)" error={errors.compare_at_price} hint="Shown crossed out, only for a genuine reduction."><input className={input} inputMode="decimal" value={f.compare_at_price} onChange={set("compare_at_price")} /></Field>
              <Field label="Cost price (₹, optional)" error={errors.cost_price} hint="Only administrators can see this."><input className={input} inputMode="decimal" value={f.cost_price} onChange={set("cost_price")} /></Field>
              {errors.publishWarning && <p className="font-sans text-xs text-[#8a6a33]">{errors.publishWarning}</p>}
            </div>
          </Card>
          <Card>
            <h2 className="mb-3 font-serif text-lg text-charcoal">Card preview</h2>
            <EditorPreview f={f} categories={categories} />
          </Card>
        </div>
      </div>
    </div>
  );
}

function EditorPreview({ f }) {
  const price = Number.parseFloat(f.price);
  const kicker = [f.audience, f.colour].filter(Boolean).join(" · ");
  return (
    <div className="mx-auto max-w-[260px] overflow-hidden rounded-[18px] border border-[#e8e1d1] bg-[#fcf9f3] shadow-[0_10px_26px_-18px_rgba(8,28,21,0.25)]">
      <div className="m-2 aspect-[4/5] overflow-hidden rounded-[12px] bg-white">
        {f.images[0] ? <img src={f.images[0].url} alt="" className="h-full w-full object-contain p-[6%]" /> : <div className="flex h-full items-center justify-center font-sans text-xs text-warm-grey">No photo yet</div>}
      </div>
      <div className="px-4 pb-4">
        {kicker && <p className="font-sans text-[10px] tracking-[0.18em] text-[#B08D57] uppercase">{kicker}</p>}
        <p className="mt-1 font-serif text-[1.1rem] leading-snug text-charcoal">{f.name || "Product name"}</p>
        {f.short_description && <p className="mt-1 font-sans text-xs text-warm-grey">{f.short_description}</p>}
        <p className="mt-3 border-t border-charcoal/[0.07] pt-3 font-sans text-sm">{Number.isFinite(price) && price > 0 ? fmtMoney(price) : <span className="italic text-[#B08D57]">Price coming soon</span>}</p>
      </div>
    </div>
  );
}

/* ================================================================ CATEGORIES */

function Categories({ categories, onDone }) {
  const [draft, setDraft] = useState({ name: "", description: "", sort_order: "" });
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  async function run(fn, msg, confirm) {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setErr(null);
    const res = await fn();
    setBusy(false);
    if (res.error) setErr(res.error);
    else { setEdit(null); setDraft({ name: "", description: "", sort_order: "" }); onDone(msg); }
  }

  return (
    <div className="space-y-5">
      {err && <InlineError message={err} />}
      <Card>
        <h2 className="mb-3 font-serif text-lg text-charcoal">Add a category</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_2fr_120px_auto] sm:items-end">
          <Field label="Name"><input className={input} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={60} /></Field>
          <Field label="Description (optional)"><input className={input} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} maxLength={500} /></Field>
          <Field label="Position"><input className={input} inputMode="numeric" value={draft.sort_order} onChange={(e) => setDraft({ ...draft, sort_order: e.target.value })} /></Field>
          <ActionButton variant="primary" disabled={busy || draft.name.trim().length < 2} onClick={() => run(() => adminApi.saveCategory(null, { name: draft.name.trim(), description: draft.description, sort_order: Number.parseInt(draft.sort_order, 10) || 0 }), `Category ${draft.name.trim()} added.`)}>Add</ActionButton>
        </div>
      </Card>
      <TableShell head={["Category", "Description", "Position", "Products", "Shown in the shop", ""]} minWidth="760px">
        {categories.map((c) => {
          const e = edit?.id === c.id ? edit : null;
          return (
            <tr key={c.id} className="border-b border-charcoal/[0.06] last:border-0">
              <td className="px-4 py-2.5 font-sans text-sm text-charcoal">{e ? <input className={input} value={e.name} onChange={(ev) => setEdit({ ...e, name: ev.target.value })} /> : c.name}</td>
              <td className="px-4 py-2.5 font-sans text-sm text-warm-grey">{e ? <input className={input} value={e.description} onChange={(ev) => setEdit({ ...e, description: ev.target.value })} /> : c.description || "—"}</td>
              <td className="px-4 py-2.5 font-sans text-sm">{e ? <input className={`${input} w-20`} value={e.sort_order} onChange={(ev) => setEdit({ ...e, sort_order: ev.target.value })} /> : c.sort_order}</td>
              <td className="px-4 py-2.5 font-sans text-sm">{c.product_count}</td>
              <td className="px-4 py-2.5"><StatusPill value={c.is_active ? "active" : "inactive"} /></td>
              <td className="px-4 py-2.5">
                <div className="flex justify-end gap-1.5">
                  {e ? (
                    <>
                      <SmallBtn disabled={busy} onClick={() => run(() => adminApi.saveCategory(c.id, { name: e.name, description: e.description, sort_order: Number.parseInt(e.sort_order, 10) || 0 }), "Category saved.")}>Save</SmallBtn>
                      <SmallBtn onClick={() => setEdit(null)}>Cancel</SmallBtn>
                    </>
                  ) : (
                    <>
                      <SmallBtn onClick={() => setEdit({ id: c.id, name: c.name, description: c.description ?? "", sort_order: String(c.sort_order) })}>Edit</SmallBtn>
                      <SmallBtn disabled={busy} onClick={() => run(() => adminApi.saveCategory(c.id, { is_active: !c.is_active }), c.is_active ? `${c.name} hidden from the shop.` : `${c.name} shown in the shop.`)}>{c.is_active ? "Switch off" : "Switch on"}</SmallBtn>
                      {Number(c.product_count) === 0 && <IconBtn label={`Delete ${c.name}`} danger disabled={busy} onClick={() => run(() => adminApi.deleteCategory(c.id), `${c.name} deleted.`, `Delete the empty category ${c.name}?`)}><Trash2 size={14} /></IconBtn>}
                    </>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </TableShell>
    </div>
  );
}
