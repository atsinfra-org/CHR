import { ArrowRight, Calendar, Check, Crown, Gem, Layers, Plus, RefreshCw, Trash2 } from "lucide-react";
import HorseMark from "../components/ui/HorseMark";
import { formatINR } from "./cartMath";
import { formatDate } from "../account/dashboardUtils";
import { PHOTO_MASK } from "./cardStyles";

/**
 * Membership product card. Layout is deliberately two-tier so nothing ever
 * sits on top of the photograph:
 *
 *   ┌───────────────────────────┬────────────┐
 *   │ emblem · name · tagline   │   photo    │  ← "stage": text column (≤58%)
 *   │ divider · 3 feature rows  │  (fades    │    + photo on the right
 *   │                           │   in)      │
 *   ├───────────────────────────┴────────────┤
 *   │ ₹ price                  [Add to Cart] │  ← footer bar, solid background
 *   └────────────────────────────────────────┘
 *
 * Photos live in /public/assests/membership/{one-time,gold,platinum}.jpg and
 * are shown at natural scale (object-cover, never zoomed past the container),
 * so a lower-resolution file is not enlarged into blur. Swap a file to change
 * a photo; tune `focus` (CSS object-position) if the crop needs moving.
 *
 * The whole card is the "select" target (click / Enter / Space), like the
 * tack cards; buttons inside stop propagation.
 */
const VARIANTS = {
  ONE_TIME_RIDE: {
    image: "/assests/membership/one-time.jpg",
    focus: "70% 30%",
    icon: HorseMark,
    tagline: "A single session to experience the joy of riding.",
    dark: false,
    popular: false,
  },
  GOLD: {
    image: "/assests/membership/gold.jpg",
    focus: "50% 25%",
    icon: Crown,
    tagline: "The perfect rhythm for regular riders.",
    dark: false,
    popular: true,
  },
  PLATINUM: {
    image: "/assests/membership/platinum.jpg",
    focus: "62% 30%",
    icon: Gem,
    tagline: "For riders who want more time in the saddle.",
    dark: true,
    popular: false,
  },
};

const FALLBACK = { ...VARIANTS.ONE_TIME_RIDE, image: null, icon: Crown, tagline: "" };

export default function MembershipCard({ product: p, inCart, onAdd, onRemove }) {
  const v = VARIANTS[p.plan_code] ?? FALLBACK;
  const Icon = v.icon;
  const heldUntil = p.active_until ?? null;
  const interactive = p.is_purchasable;
  const selected = Boolean(inCart) && interactive;
  const dark = v.dark;
  const gold = p.plan_code === "GOLD";

  const activate = () => interactive && !selected && onAdd();
  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };

  const surface = dark
    ? "border-[#1d4a37] bg-[linear-gradient(145deg,#0d2a1f_0%,#16402f_100%)] text-warm-ivory"
    : gold
      ? "border-antique-gold bg-[#fcf9f1] text-charcoal"
      : "border-[#e8e1d1] bg-[#fcf9f3] text-charcoal";

  const state = !interactive
    ? "cursor-not-allowed opacity-70"
    : selected
      ? `cursor-pointer ring-2 ${dark ? "ring-antique-gold/60" : "ring-racing-green/30"} shadow-[0_26px_50px_-26px_rgba(8,28,21,0.5)]`
      : "cursor-pointer hover:-translate-y-1.5 hover:shadow-[0_30px_56px_-28px_rgba(8,28,21,0.45)] active:translate-y-0";

  const muted = dark ? "text-warm-ivory/70" : "text-warm-grey";
  const rule = dark ? "bg-warm-ivory/15" : "bg-charcoal/10";
  const iconTone = dark ? "text-champagne-gold" : "text-antique-gold";
  const footerBg = dark ? "bg-black/15" : "bg-white/55";

  const features = [
    { icon: Layers, text: `${p.class_credits} riding class${p.class_credits === 1 ? "" : "es"}` },
    { icon: Calendar, text: `Valid ${p.validity_days} days` },
    { icon: RefreshCw, text: `${p.reschedules_allowed} reschedule${p.reschedules_allowed === 1 ? "" : "s"} included` },
  ];

  const primary = dark ? "bg-warm-ivory text-racing-green hover:bg-white" : "bg-racing-green text-warm-ivory hover:bg-deep-forest";

  return (
    <div
      role="button"
      tabIndex={interactive ? 0 : -1}
      aria-pressed={selected}
      aria-disabled={!interactive}
      aria-label={`${p.name}, ${formatINR(p.price)}${selected ? ", in your cart" : interactive ? ", add to cart" : ", unavailable"}`}
      onClick={activate}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          activate();
        }
      }}
      className={`group relative flex flex-col overflow-hidden rounded-[22px] border transition-all duration-300 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-antique-gold ${surface} ${state}`}
    >
      {/* ---- stage: text on the left, photo on the right ---- */}
      <div className="relative flex-1 px-6 pt-6 pb-5 sm:px-7 sm:pt-7">
        {v.image && (
          <div aria-hidden="true" className="pointer-events-none absolute top-0 right-0 bottom-0 w-[42%] overflow-hidden" style={PHOTO_MASK}>
            <img
              src={v.image}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]"
              style={{ objectPosition: v.focus, filter: dark ? "brightness(0.9) contrast(1.05)" : "none" }}
            />
          </div>
        )}

        {v.popular && !selected && (
          <span className="absolute top-4 right-4 z-10 rounded-full bg-[#b98a35] px-3.5 py-1.5 font-sans text-[10px] font-medium tracking-[0.2em] text-warm-ivory uppercase shadow-sm">
            Popular
          </span>
        )}
        {selected && (
          <span
            className={`absolute top-4 right-4 z-10 flex items-center gap-1 rounded-full px-2.5 py-1 font-sans text-[10px] tracking-[0.14em] uppercase shadow-sm ${
              dark ? "bg-warm-ivory text-racing-green" : "bg-racing-green text-warm-ivory"
            }`}
          >
            <Check size={11} strokeWidth={2.25} /> In cart
          </span>
        )}

        <div className="relative z-[1] max-w-[60%]">
          <span
            className={`flex h-12 w-12 items-center justify-center rounded-full border ${
              dark ? "border-champagne-gold/50 bg-white/5" : "border-antique-gold/50 bg-antique-gold/10"
            } ${iconTone}`}
          >
            <Icon className={Icon === HorseMark ? "h-8 w-8 stroke-[1.9]" : ""} {...(Icon === HorseMark ? {} : { size: 20, strokeWidth: 1.5 })} />
          </span>

          <h3 className="mt-5 font-serif text-[1.5rem] leading-[1.1] text-balance">{p.name}</h3>
          <p className={`mt-2.5 font-sans text-[13.5px] leading-relaxed ${muted}`}>{v.tagline}</p>
          <span className={`mt-4 block h-px w-full ${rule}`} aria-hidden="true" />

          <ul className="mt-4 space-y-2.5">
            {features.map((f) => (
              <li key={f.text} className="flex items-center gap-2.5 font-sans text-[13px]">
                <f.icon size={16} strokeWidth={1.5} className={`shrink-0 ${dark ? "text-warm-ivory/60" : "text-warm-grey"}`} />
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* ---- footer bar: nothing overlaps the photo here ---- */}
      <div className={`relative z-[1] flex flex-wrap items-center justify-between gap-3 border-t px-6 py-4 sm:px-7 ${footerBg} ${dark ? "border-warm-ivory/10" : "border-charcoal/[0.07]"}`}>
        <p className="font-serif text-[2rem] leading-none">{formatINR(p.price)}</p>

        {heldUntil ? (
          <span className={`rounded-full px-3.5 py-2 font-sans text-[11px] tracking-[0.08em] whitespace-nowrap uppercase ${dark ? "bg-warm-ivory/15 text-warm-ivory" : "bg-racing-green/10 text-racing-green"}`}>
            Active until {formatDate(heldUntil)}
          </span>
        ) : !interactive ? (
          <span className={`font-sans text-xs tracking-[0.12em] uppercase ${muted}`}>Unavailable</span>
        ) : selected ? (
          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={stop(onRemove)}
              className={`flex h-11 items-center gap-1.5 rounded-[10px] px-3 font-sans text-xs tracking-[0.1em] uppercase transition-colors ${dark ? "text-warm-ivory/80 hover:text-white" : "text-warm-grey hover:text-charcoal"}`}
            >
              <Trash2 size={14} strokeWidth={1.75} /> Remove
            </button>
            <a href="/cart" className={`flex h-11 items-center gap-2 rounded-[10px] px-4 font-sans text-[13px] font-medium transition-colors ${primary}`}>
              View cart <ArrowRight size={15} strokeWidth={1.75} />
            </a>
          </div>
        ) : (
          <button
            type="button"
            onClick={stop(onAdd)}
            className={`flex h-12 items-center gap-2.5 rounded-[10px] px-5 font-sans text-[13.5px] font-medium shadow-sm transition-all duration-200 hover:-translate-y-px hover:shadow-md ${primary}`}
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
