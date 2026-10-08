import { ArrowRight, BellRing, Check, Footprints, Layers, MapPin, Minus, Plus, Shirt, ShieldCheck, Trash2 } from "lucide-react";
import { formatINR } from "./cartMath";
import { PHOTO_MASK } from "./cardStyles";

/**
 * Tack-shop product card — the same two-tier design as MembershipCard (text
 * and photo on top, solid footer with price and action), so the store reads
 * as one system. Photos are Unsplash stand-ins in /public/assests/tack/;
 * swap a file to change a photo and tweak `focus` (CSS object-position) to
 * move the crop. Items are collected in store, so the two info rows state
 * exactly that and nothing about delivery.
 *
 * The whole card selects on click / Enter / Space; inner controls stop
 * propagation.
 */
const ITEMS = {
  TACK_BREECHES: { image: "/assests/tack/breeches.jpg", focus: "50% 55%", icon: Shirt, tagline: "Comfortable, hard-wearing breeches for every ride." },
  TACK_HELMET: { image: "/assests/tack/helmet.jpg", focus: "12% 30%", icon: ShieldCheck, tagline: "Essential head protection for every ride." },
  TACK_CHAPS: { image: "/assests/tack/chaps.jpg", focus: "50% 60%", icon: Layers, tagline: "Added leg protection and a secure grip." },
  TACK_HALF_BOOTS: { image: "/assests/tack/half-boots.jpg", focus: "75% 60%", icon: Footprints, tagline: "Practical ankle-height boots for yard and arena." },
  TACK_FULL_BOOTS: { image: "/assests/tack/full-boots.jpg", focus: "38% 55%", icon: Footprints, tagline: "Classic tall boots for a polished finish." },
};

const FALLBACK = { image: null, focus: "50% 50%", icon: Layers, tagline: "" };

export default function TackCard({ product: p, inCart, onAdd, onSetQty, onRemove }) {
  const v = ITEMS[p.sku] ?? FALLBACK;
  const Icon = v.icon;
  const interactive = p.is_purchasable;
  const priced = p.price != null;
  const selected = Boolean(inCart) && interactive;

  const activate = () => interactive && !selected && onAdd();
  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };

  const state = !interactive
    ? "cursor-not-allowed opacity-70"
    : selected
      ? "cursor-pointer ring-2 ring-racing-green/30 shadow-[0_26px_50px_-26px_rgba(8,28,21,0.5)]"
      : "cursor-pointer hover:-translate-y-1.5 hover:shadow-[0_30px_56px_-28px_rgba(8,28,21,0.45)] active:translate-y-0";

  const rows = [
    { icon: MapPin, text: "Collect in store" },
    { icon: BellRing, text: "Notified when ready" },
  ];

  return (
    <div
      role="button"
      tabIndex={interactive ? 0 : -1}
      aria-pressed={selected}
      aria-disabled={!interactive}
      aria-label={`${p.name}${priced ? `, ${formatINR(p.price)}` : ""}${selected ? ", in your cart" : interactive ? ", add to cart" : ", unavailable"}`}
      onClick={activate}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          activate();
        }
      }}
      className={`group relative flex flex-col overflow-hidden rounded-[22px] border border-[#e8e1d1] bg-[#fcf9f3] text-charcoal transition-all duration-300 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-antique-gold ${state}`}
    >
      <div className="relative flex-1 px-6 pt-6 pb-5 sm:px-7 sm:pt-7">
        {v.image && (
          <div aria-hidden="true" className="pointer-events-none absolute top-0 right-0 bottom-0 w-[44%] overflow-hidden" style={PHOTO_MASK}>
            <img
              src={v.image}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]"
              style={{ objectPosition: v.focus }}
            />
          </div>
        )}

        {selected && (
          <span className="absolute top-4 right-4 z-10 flex items-center gap-1 rounded-full bg-racing-green px-2.5 py-1 font-sans text-[10px] tracking-[0.14em] text-warm-ivory uppercase shadow-sm">
            <Check size={11} strokeWidth={2.25} /> In cart
          </span>
        )}

        <div className="relative z-[1] max-w-[58%]">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-antique-gold/50 bg-antique-gold/10 text-antique-gold">
            <Icon size={20} strokeWidth={1.5} />
          </span>
          <h3 className="mt-5 font-serif text-[1.5rem] leading-[1.1] text-balance">{p.name}</h3>
          <p className="mt-2.5 min-h-[3.4rem] font-sans text-[13.5px] leading-relaxed text-warm-grey">{v.tagline}</p>
          <span className="mt-3 block h-px w-full bg-charcoal/10" aria-hidden="true" />
          <ul className="mt-4 space-y-2.5">
            {rows.map((r) => (
              <li key={r.text} className="flex items-center gap-2.5 font-sans text-[13px]">
                <r.icon size={16} strokeWidth={1.5} className="shrink-0 text-warm-grey" />
                <span>{r.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="relative z-[1] flex flex-wrap items-center justify-between gap-3 border-t border-charcoal/[0.07] bg-white/55 px-6 py-4 sm:px-7">
        <p className="font-serif text-[2rem] leading-none">{priced ? formatINR(p.price) : <span className="text-base text-warm-grey">Price coming soon</span>}</p>

        {!interactive ? (
          <span className="font-sans text-xs tracking-[0.12em] text-warm-grey uppercase">Unavailable</span>
        ) : selected ? (
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center rounded-full border border-antique-gold/40 bg-white">
              <button type="button" aria-label={`Decrease ${p.name}`} onClick={stop(() => (inCart.quantity <= 1 ? onRemove() : onSetQty(inCart.quantity - 1)))} className="flex h-9 w-9 items-center justify-center text-charcoal transition-colors hover:text-racing-green">
                {inCart.quantity <= 1 ? <Trash2 size={14} strokeWidth={1.75} /> : <Minus size={14} />}
              </button>
              <span className="w-5 text-center font-sans text-sm tabular-nums" aria-live="polite">
                {inCart.quantity}
              </span>
              <button type="button" aria-label={`Increase ${p.name}`} onClick={stop(() => onSetQty(inCart.quantity + 1))} className="flex h-9 w-9 items-center justify-center text-charcoal transition-colors hover:text-racing-green">
                <Plus size={14} />
              </button>
            </div>
            <a href="/cart" className="flex h-10 items-center gap-1.5 rounded-[10px] bg-racing-green px-3.5 font-sans text-[13px] font-medium text-warm-ivory transition-colors hover:bg-deep-forest">
              Cart <ArrowRight size={15} strokeWidth={1.75} />
            </a>
          </div>
        ) : (
          <button
            type="button"
            onClick={stop(onAdd)}
            className="flex h-12 items-center gap-2.5 rounded-[10px] bg-racing-green px-5 font-sans text-[13.5px] font-medium text-warm-ivory shadow-sm transition-all duration-200 hover:-translate-y-px hover:bg-deep-forest hover:shadow-md"
          >
            <Plus size={16} strokeWidth={1.75} />
            Add to Cart
            <ArrowRight size={15} strokeWidth={1.75} className="ml-1.5 transition-transform duration-200 group-hover:translate-x-0.5" />
          </button>
        )}
      </div>
    </div>
  );
}
