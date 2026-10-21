import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, BellRing, Check, MapPin, Minus, Plus, Shirt } from "lucide-react";
import { formatINR } from "./cartMath";
import { sortBreeches } from "./breeches";
import { variantLabel } from "./tackCatalog";

const AUDIENCE_ORDER = ["Women", "Men", "Kids", "Unisex"];

/**
 * The Tack Shop: a grid of product cards and a product page with a photo gallery, sizes and specifications. Every word
 * and photo comes from the database (Admin -> Tack Shop). A product without a confirmed price is shown but can never be
 * added to the cart: the button is disabled here, the cart ignores it (cartMath) and the server refuses it
 * (create_order raises PRICE_NOT_SET). A product sold in sizes/colours needs one chosen and in stock.
 */
export default function TackShop({ items, heading, description, cart, selectedSku, onSelect }) {
  const [audience, setAudience] = useState("All");
  const [colour, setColour] = useState("All");
  const [sort, setSort] = useState("featured");

  const selected = items.find((i) => i.sku === selectedSku) ?? null;
  const audiences = AUDIENCE_ORDER.filter((a) => items.some((i) => i.audience === a));
  const byAudience = audience === "All" ? items : items.filter((i) => i.audience === audience);
  const colours = [...new Set(byAudience.map((i) => i.colour).filter(Boolean))];
  const shown = sortBreeches(colour === "All" ? byAudience : byAudience.filter((i) => i.colour === colour), sort);
  const canSortByPrice = items.filter((i) => i.price != null).length >= 2;

  if (selected) return <ProductDetail item={selected} cart={cart} onBack={() => onSelect(null)} />;

  return (
    <section aria-labelledby="tack-title" className="mb-14">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-[#B08D57]/25 pb-4">
        <div>
          <h2 id="tack-title" className="font-serif text-[1.9rem] leading-tight text-[#1F3A2E] sm:text-[2.2rem]">{heading}</h2>
          <p className="mt-1 font-sans text-sm text-warm-grey">
            {description || `${items.length} item${items.length === 1 ? "" : "s"}.`} Collect in store.
          </p>
        </div>
        {canSortByPrice && (
          <label className="flex items-center gap-2 font-sans text-xs tracking-[0.12em] text-warm-grey uppercase">
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value)} className="rounded-none border-0 border-b border-[#B08D57]/50 bg-transparent py-1 font-sans text-sm normal-case tracking-normal text-charcoal focus:outline-none focus-visible:border-[#1F3A2E]">
              <option value="featured">Featured</option>
              <option value="price-asc">Price: low to high</option>
              <option value="price-desc">Price: high to low</option>
            </select>
          </label>
        )}
      </div>

      {(audiences.length > 1 || colours.length > 1) && (
        <div className="mb-7 flex flex-col gap-3">
          {audiences.length > 1 && (
            <Chips label="Shop for" value={audience} options={["All", ...audiences]} onChange={(v) => { setAudience(v); setColour("All"); }} render={(v) => (v === "All" ? "Everyone" : v)} />
          )}
          {colours.length > 1 && <Chips label="Colour" value={colour} options={["All", ...colours]} onChange={setColour} small />}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="py-16 text-center font-sans text-sm text-warm-grey">Nothing matches these filters.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:gap-5 md:grid-cols-3 xl:grid-cols-4">
          {shown.map((item) => (
            <li key={item.sku} className="h-full">
              <ProductTile item={item} inCart={cart.items.some((c) => c.productId === item.id)} onOpen={() => onSelect(item.sku)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Chips({ label, value, options, onChange, render = (v) => v, small = false }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      {options.map((o) => {
        const on = o === value;
        return (
          <button key={o} type="button" aria-pressed={on} onClick={() => onChange(o)}
            className={`rounded-full border font-sans transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B08D57] ${small ? "px-3 py-1 text-xs" : "px-4 py-2 text-[13px]"} ${
              on ? "border-[#1F3A2E] bg-[#1F3A2E] text-[#F7F3EA]" : "border-[#B08D57]/35 bg-transparent text-charcoal hover:border-[#B08D57]"
            }`}>
            {render(o)}
          </button>
        );
      })}
    </div>
  );
}

/** A product photo that keeps its box (no layout jump), never crops the item, and shows a calm fallback. */
export function Photo({ src, alt, className = "", eager = false }) {
  const [state, setState] = useState("loading");
  const [shown, setShown] = useState(src);
  if (shown !== src) {
    setShown(src);
    setState("loading");
  }
  return (
    <div className={`relative overflow-hidden bg-white ${className}`}>
      {state === "loading" && <div aria-hidden="true" className="absolute inset-0 animate-pulse bg-[#F7F3EA]" />}
      {state === "error" || !src ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[#B08D57]">
          <Shirt size={28} strokeWidth={1.25} />
          <span className="font-sans text-[11px] tracking-[0.14em] uppercase">Photo unavailable</span>
        </div>
      ) : (
        <img ref={(el) => { if (el && el.complete && state === "loading") setState(el.naturalWidth > 0 ? "ready" : "error"); }} src={src} alt={alt} loading={eager ? "eager" : "lazy"} decoding="async" onLoad={() => setState("ready")} onError={() => setState("error")}
          className="absolute inset-0 h-full w-full object-contain p-[6%] transition-transform duration-500 ease-out group-hover:scale-[1.03]" />
      )}
    </div>
  );
}

function PriceLine({ item, large = false }) {
  if (item.price != null) {
    const discounted = item.compare_at_price != null && Number(item.compare_at_price) > Number(item.price);
    return (
      <p className={`flex items-baseline gap-2 font-sans text-charcoal ${large ? "text-2xl" : "text-sm"}`}>
        {formatINR(item.price)}
        {discounted && <s className={`text-warm-grey ${large ? "text-base" : "text-xs"}`}>{formatINR(item.compare_at_price)}</s>}
      </p>
    );
  }
  return <p className={`font-sans italic text-[#B08D57] ${large ? "text-lg" : "whitespace-nowrap text-[11.5px] sm:text-[13px]"}`}>Price coming soon</p>;
}

/** A product card: cream card, border, lift and shadow on hover, focus ring; opens the product page. */
function ProductTile({ item, inCart, onOpen }) {
  const kicker = [item.audience, item.colour].filter(Boolean).join(" · ");
  return (
    <a href={`?product=${encodeURIComponent(item.sku)}`} onClick={(e) => { e.preventDefault(); onOpen(); }}
      aria-label={`${item.name}, ${item.price != null ? formatINR(item.price) : "price coming soon"}. View details`}
      className={`group flex h-full flex-col overflow-hidden rounded-[18px] border bg-[#fcf9f3] text-charcoal shadow-[0_1px_2px_rgba(27,27,24,0.04),0_10px_26px_-18px_rgba(8,28,21,0.25)] transition-all duration-300 ease-out hover:-translate-y-1.5 hover:border-[#C9A86A] hover:shadow-[0_30px_56px_-28px_rgba(8,28,21,0.45)] active:translate-y-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B08D57] ${
        inCart ? "border-[#1F3A2E] ring-2 ring-[#1F3A2E]/20" : "border-[#e8e1d1]"
      }`}>
      <div className="relative m-2 overflow-hidden rounded-[12px]">
        <Photo src={item.images[0]} alt={item.photos[0]?.alt || item.name} className="aspect-[4/5] w-full" />
        {inCart && (
          <span className="absolute top-2.5 left-2.5 flex items-center gap-1 rounded-full bg-[#1F3A2E] px-2.5 py-1 font-sans text-[10px] tracking-[0.14em] text-[#F7F3EA] uppercase">
            <Check size={11} strokeWidth={2.25} /> In cart
          </span>
        )}
        {item.images.length > 1 && (
          <span className="absolute right-2.5 bottom-2.5 rounded-full bg-white/90 px-2 py-0.5 font-sans text-[10px] tracking-[0.08em] text-warm-grey">{item.images.length} photos</span>
        )}
      </div>
      <div className="flex flex-1 flex-col px-3.5 pt-1.5 pb-3.5 sm:px-4 sm:pb-4">
        {kicker && <p className="font-sans text-[10px] tracking-[0.18em] text-[#B08D57] uppercase sm:text-[10.5px]">{kicker}</p>}
        <h3 className="mt-1 font-serif text-[1.02rem] leading-snug text-balance sm:text-[1.15rem]">{item.name}</h3>
        {item.short_description && <p className="mt-1 line-clamp-2 font-sans text-[12px] leading-relaxed text-warm-grey sm:text-[13px]">{item.short_description}</p>}
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-charcoal/[0.07] pt-3">
          <PriceLine item={item} />
          <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#B08D57]/40 text-[#1F3A2E] transition-colors duration-200 group-hover:border-[#1F3A2E] group-hover:bg-[#1F3A2E] group-hover:text-[#F7F3EA] sm:h-8 sm:w-8">
            <ArrowRight size={15} strokeWidth={1.75} className="transition-transform duration-200 group-hover:translate-x-0.5" />
          </span>
        </div>
      </div>
    </a>
  );
}

const SPEC_ROWS = [
  ["colour", "Colour"], ["sizes", "Sizes"], ["material", "Material"], ["fit", "Fit"], ["care", "Care"],
];

function specValue(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join(", ");
  return v == null ? "" : String(v);
}

export function ProductDetail({ item, cart, onBack }) {
  const [index, setIndex] = useState(0);
  const [qty, setQty] = useState(1);
  const [variantId, setVariantId] = useState(null);
  const variants = item.variants ?? [];
  const needsVariant = variants.length > 0;
  const variant = variants.find((v) => v.id === variantId) ?? null;
  const price = variant?.price ?? item.price;
  const purchasable = Boolean(item.is_purchasable) && price != null;
  const inCart = cart.items.find((c) => c.productId === item.id && (c.variantId ?? null) === (variantId ?? null));
  const photos = item.photos;
  const specs = item.specs ?? {};
  const features = Array.isArray(specs.features) ? specs.features.filter(Boolean) : [];
  const extra = Array.isArray(specs.extra) ? specs.extra.filter((e) => e?.label && e?.value) : [];

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [item.sku]);

  const rows = [
    { icon: MapPin, text: "Collect in store at the club" },
    { icon: BellRing, text: "We tell you when it is ready" },
  ];
  const kicker = [item.audience, item.category_name ?? null].filter(Boolean).join(" · ");
  const buttonText = !purchasable ? "Price coming soon" : needsVariant && !variant ? "Choose a size" : "Add to cart";

  return (
    <article aria-labelledby="product-title" className="mb-14">
      <button type="button" onClick={onBack} className="mb-6 inline-flex items-center gap-2 font-sans text-xs tracking-[0.14em] text-warm-grey uppercase hover:text-charcoal focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#B08D57]">
        <ArrowLeft size={15} strokeWidth={1.75} /> Back to the shop
      </button>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-14">
        <div>
          <Photo src={photos[index]?.url} alt={photos[index]?.alt || `${item.name}, photo ${index + 1} of ${photos.length}`} className="aspect-[4/5] w-full" eager />
          {photos.length > 1 && (
            <ul className="mt-3 grid grid-cols-5 gap-2 sm:grid-cols-6" aria-label="More photos">
              {photos.map((p, i) => (
                <li key={p.url + i}>
                  <button type="button" aria-label={`Show photo ${i + 1}`} aria-current={i === index} onClick={() => setIndex(i)}
                    className={`block w-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B08D57] ${i === index ? "border-[#1F3A2E]" : "border-transparent hover:border-[#B08D57]/60"}`}>
                    <Photo src={p.url} alt="" className="aspect-square w-full" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="lg:pt-4">
          {kicker && <p className="font-sans text-[11px] tracking-[0.2em] text-[#B08D57] uppercase">{kicker}</p>}
          <h1 id="product-title" className="mt-2 font-serif text-[2rem] leading-tight text-[#1F3A2E] sm:text-[2.4rem]">{item.name}</h1>
          {item.brand && <p className="mt-1 font-sans text-sm text-warm-grey">by {item.brand}</p>}
          <div className="mt-4"><PriceLine item={{ ...item, price }} large /></div>
          {item.price == null && (
            <p className="mt-3 max-w-md font-sans text-sm leading-relaxed text-warm-grey">
              This item can't be bought online until its price is confirmed. Ask our team at the club, or check back soon.
            </p>
          )}
          {item.short_description && <p className="mt-5 max-w-prose font-sans text-[15px] leading-relaxed text-charcoal/85">{item.short_description}</p>}

          {needsVariant && (
            <fieldset className="mt-6">
              <legend className="font-sans text-xs tracking-[0.14em] text-warm-grey uppercase">Choose a size</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {variants.map((v) => {
                  const on = v.id === variantId;
                  const out = v.in_stock === false;
                  return (
                    <button key={v.id} type="button" aria-pressed={on} disabled={out} onClick={() => setVariantId(v.id)}
                      className={`min-h-[44px] min-w-[52px] border px-3 font-sans text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B08D57] ${
                        on ? "border-[#1F3A2E] bg-[#1F3A2E] text-[#F7F3EA]" : out ? "cursor-not-allowed border-charcoal/10 text-warm-grey/60 line-through" : "border-[#B08D57]/40 bg-white text-charcoal hover:border-[#1F3A2E]"
                      }`}>
                      {variantLabel(v)}{out ? " (out of stock)" : ""}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}

          <dl className="mt-7 border-t border-[#B08D57]/25">
            {SPEC_ROWS.map(([key, label]) => specValue(specs[key]) && (
              <div key={key} className="flex justify-between gap-6 border-b border-[#B08D57]/15 py-3 font-sans text-sm">
                <dt className="text-warm-grey">{label}</dt>
                <dd className="text-right text-charcoal">{specValue(specs[key])}</dd>
              </div>
            ))}
            {extra.map((e) => (
              <div key={e.label} className="flex justify-between gap-6 border-b border-[#B08D57]/15 py-3 font-sans text-sm">
                <dt className="text-warm-grey">{e.label}</dt>
                <dd className="text-right text-charcoal">{e.value}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-6 border-b border-[#B08D57]/15 py-3 font-sans text-sm">
              <dt className="text-warm-grey">Availability</dt>
              <dd className="text-charcoal">{purchasable ? "Available to order" : "Not yet available online"}</dd>
            </div>
          </dl>

          {features.length > 0 && (
            <ul className="mt-5 list-disc space-y-1 pl-5 font-sans text-sm text-charcoal/85">
              {features.map((f) => <li key={f}>{f}</li>)}
            </ul>
          )}
          {item.description && <p className="mt-6 max-w-prose whitespace-pre-line font-sans text-[15px] leading-relaxed text-charcoal/85">{item.description}</p>}

          <div className="mt-8 flex flex-wrap items-center gap-3">
            {purchasable && !inCart && (
              <div className="flex items-center border border-[#B08D57]/40">
                <button type="button" aria-label="Decrease quantity" onClick={() => setQty((q) => Math.max(1, q - 1))} className="flex h-12 w-11 items-center justify-center hover:text-[#1F3A2E]"><Minus size={15} /></button>
                <span className="w-8 text-center font-sans text-sm tabular-nums" aria-live="polite">{qty}</span>
                <button type="button" aria-label="Increase quantity" onClick={() => setQty((q) => Math.min(20, q + 1))} className="flex h-12 w-11 items-center justify-center hover:text-[#1F3A2E]"><Plus size={15} /></button>
              </div>
            )}
            {inCart ? (
              <a href="/cart" className="inline-flex h-12 items-center gap-2 bg-[#1F3A2E] px-7 font-sans text-[13px] tracking-[0.14em] text-[#F7F3EA] uppercase transition-colors hover:bg-[#162b22]">
                <Check size={15} /> In cart · view cart
              </a>
            ) : (
              <button type="button" disabled={!purchasable || (needsVariant && !variant)} onClick={() => cart.add(item, qty, variant?.id ?? null)}
                className="inline-flex h-12 min-w-[200px] items-center justify-center gap-2 bg-[#1F3A2E] px-7 font-sans text-[13px] tracking-[0.14em] text-[#F7F3EA] uppercase transition-colors hover:bg-[#162b22] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B08D57] disabled:cursor-not-allowed disabled:bg-[#1F3A2E]/35">
                {buttonText}
              </button>
            )}
          </div>

          <ul className="mt-8 space-y-2.5">
            {rows.map((r) => (
              <li key={r.text} className="flex items-center gap-2.5 font-sans text-[13px] text-warm-grey">
                <r.icon size={16} strokeWidth={1.5} className="shrink-0 text-[#B08D57]" /> {r.text}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}
