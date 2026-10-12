import { ArrowRight, Check, Receipt } from "lucide-react";
import { usePublicPlans } from "../../lib/usePublicPlans";
import { orderNumber } from "../../lib/labels";
import { PLAN_PHOTOS } from "../../store/productPhotos";

const inr = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

/**
 * What a rider without a plan sees instead of empty tiles. Two halves:
 * a dark panel that says where they are in the three steps and gives the one
 * thing to do next, and beside it the plans themselves (live from the
 * database, with the store's own photographs). If an order has been started
 * but not paid, the panel leads with finishing that payment and the order
 * takes the place of the plans.
 *
 * It fits one screen on desktop and laptop sizes: the lg: spacing and sizes
 * scale with the screen height (clamp(min, vh, max)).
 */
export default function WelcomePanel({ lapsed = false, pendingOrder = null }) {
  const plans = usePublicPlans();
  const waiting = Boolean(pendingOrder);
  const steps = [
    { title: "Choose a plan", text: "A single ride, or a month of classes." },
    { title: "Pay online", text: "By UPI, card or net banking. Your plan starts straight away." },
    { title: "Book your classes", text: "Pick a day and a time that suits you." },
  ];
  const current = waiting ? 1 : 0;
  const heading = waiting ? "Finish paying to start riding" : lapsed ? "Your last plan has ended" : "Three steps to your first ride";

  return (
    <section className="grid grid-cols-1 gap-6 lg:grid-cols-5 lg:items-stretch">
      <div className="relative isolate flex flex-col overflow-hidden rounded-[22px] border border-[#1d4a37] bg-deep-forest p-6 text-warm-ivory shadow-[0_24px_48px_-28px_rgba(8,28,21,0.6)] sm:p-8 lg:col-span-2 lg:p-[clamp(1.1rem,3.4vh,2rem)]">
        <img src="/assests/sidebar.webp" alt="" className="absolute inset-0 -z-10 h-full w-full object-cover object-bottom opacity-70" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-[#0c261c] via-[#0c261c]/90 to-[#0c261c]/55" aria-hidden="true" />

        <p className="font-serif text-lg italic text-champagne-gold">{lapsed ? "Welcome back" : "Welcome"}</p>
        <h2 className="mt-1 font-serif text-[2rem] leading-[1.08] [text-wrap:balance] lg:text-[clamp(1.6rem,4.4vh,2.2rem)]">{heading}</h2>

        <ol className="mt-6 space-y-4 lg:mt-[clamp(0.9rem,3vh,1.5rem)] lg:space-y-[clamp(0.55rem,2vh,1rem)]">
          {steps.map((step, i) => {
            const done = i < current;
            const active = i === current;
            return (
              <li key={step.title} className="flex gap-3.5" aria-current={active ? "step" : undefined}>
                <span
                  className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-sans text-xs font-semibold ${
                    done ? "bg-champagne-gold text-deep-forest" : active ? "bg-warm-ivory text-racing-green ring-4 ring-warm-ivory/15" : "border border-warm-ivory/30 text-warm-ivory/60"
                  }`}
                >
                  {done ? <Check size={13} strokeWidth={2.5} /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className={`flex flex-wrap items-center gap-x-2.5 font-serif text-lg leading-tight ${done || active ? "text-warm-ivory" : "text-warm-ivory/70"}`}>
                    {step.title}
                    {active && waiting && <span className="rounded-full bg-champagne-gold/20 px-2 py-0.5 font-sans text-[10px] tracking-[0.12em] text-champagne-gold uppercase">In progress</span>}
                  </span>
                  <span className="mt-0.5 block font-sans text-[13px] leading-relaxed text-warm-ivory/60">{step.text}</span>
                </span>
              </li>
            );
          })}
        </ol>

        <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-3 pt-6 lg:pt-[clamp(0.6rem,calc(7vh-29px),1.5rem)]">
          <a
            href={waiting ? "/orders" : "/store"}
            className="group inline-flex h-11 items-center gap-2 rounded-[10px] bg-warm-ivory px-4 font-sans text-xs font-semibold tracking-[0.12em] text-racing-green uppercase transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-champagne-gold"
          >
            {waiting ? "Complete payment" : "Choose a plan"}
            <ArrowRight size={15} strokeWidth={1.75} className="transition-transform duration-200 group-hover:translate-x-0.5" />
          </a>
          {waiting && (
            <a href="/store" className="font-sans text-[13px] text-warm-ivory/75 underline underline-offset-4 hover:text-warm-ivory">
              Change plan
            </a>
          )}
        </div>
      </div>

      <div className="flex flex-col lg:col-span-3">{waiting ? <UnpaidOrder order={pendingOrder} /> : <Plans plans={plans} />}</div>
    </section>
  );
}

/** The plans as sold in the store. Each row opens the store. */
function Plans({ plans }) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="font-serif text-2xl text-charcoal">Choose your plan</h3>
        <a href="/store" className="shrink-0 font-sans text-sm text-racing-green underline underline-offset-4">
          Open the store
        </a>
      </div>
      <ul className="mt-4 flex flex-1 flex-col gap-3 lg:mt-[clamp(0.6rem,2vh,1rem)] lg:gap-[clamp(0.5rem,1.6vh,0.75rem)]">
        {plans.map((p) => {
          const photo = PLAN_PHOTOS[p.plan_code];
          return (
            <li key={p.plan_code} className="flex-1">
              <a
                href="/store"
                className="group flex h-full items-center gap-4 rounded-[18px] border border-antique-gold/25 bg-white p-3 pr-5 shadow-[0_1px_2px_rgba(27,27,24,0.04),0_12px_32px_-18px_rgba(8,28,21,0.13)] transition-all duration-200 hover:-translate-y-0.5 hover:border-antique-gold hover:shadow-[0_18px_36px_-20px_rgba(8,28,21,0.3)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-antique-gold"
              >
                <span className="h-[72px] w-[72px] shrink-0 overflow-hidden rounded-[12px] bg-soft-cream lg:h-[clamp(52px,10.5vh,88px)] lg:w-[clamp(52px,10.5vh,88px)]">
                  {photo && <img src={photo.image} alt="" loading="lazy" className="h-full w-full object-cover" style={{ objectPosition: photo.focus }} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-serif text-xl leading-tight text-charcoal transition-colors group-hover:text-racing-green">{p.name}</span>
                  <span className="mt-1 block font-sans text-[13px] leading-snug text-warm-grey">
                    {p.class_credits} class{p.class_credits === 1 ? "" : "es"} · valid {p.validity_days} days
                    {p.reschedules_allowed != null ? ` · ${p.reschedules_allowed} reschedule${p.reschedules_allowed === 1 ? "" : "s"}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-serif text-2xl leading-tight text-racing-green">{inr(p.price)}</span>
                  {p.class_credits > 1 && <span className="mt-0.5 block font-sans text-[11px] text-warm-grey">{inr(Math.round(p.price / p.class_credits))} a class</span>}
                </span>
                <ArrowRight size={16} strokeWidth={1.75} className="hidden shrink-0 text-racing-green/40 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-racing-green sm:block" />
              </a>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** The order that is waiting to be paid, in place of the plans. */
function UnpaidOrder({ order }) {
  const items = order.order_items ?? [];
  return (
    <div className="flex h-full flex-col rounded-[22px] border border-antique-gold/30 bg-white p-6 shadow-[0_1px_2px_rgba(27,27,24,0.04),0_12px_32px_-18px_rgba(8,28,21,0.13)] sm:p-8 lg:p-[clamp(1.1rem,3.4vh,2rem)]">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-soft-cream text-racing-green">
          <Receipt size={17} strokeWidth={1.6} />
        </span>
        <div>
          <p className="font-serif text-lg italic text-[#8a6a33]">Your order</p>
          <h3 className="font-serif text-2xl leading-tight text-charcoal">{orderNumber(order.id)}</h3>
        </div>
      </div>

      <ul className="mt-6 divide-y divide-charcoal/[0.08] border-y lg:mt-[clamp(0.8rem,2.6vh,1.5rem)] border-charcoal/[0.08] font-sans text-sm text-charcoal">
        {items.map((i) => (
          <li key={i.name} className="flex items-center justify-between gap-4 py-3">
            <span>{i.name}</span>
            <span className="text-xs tracking-[0.1em] text-warm-grey uppercase">{i.category === "membership" ? "Membership" : "Tack"}</span>
          </li>
        ))}
      </ul>

      <dl className="mt-5 flex items-baseline justify-between gap-4">
        <dt className="font-sans text-sm text-warm-grey">To pay</dt>
        <dd className="font-serif text-[1.7rem] leading-none text-charcoal">{inr(Number(order.total_amount))}</dd>
      </dl>
      <p className="mt-auto pt-5 font-sans text-[13px] leading-relaxed text-warm-grey">
        This order hasn&apos;t been paid yet. Your plan starts as soon as you pay. Unpaid orders are cancelled automatically after a while.
      </p>
    </div>
  );
}
