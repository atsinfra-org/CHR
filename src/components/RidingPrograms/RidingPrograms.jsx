import { ArrowRight } from "lucide-react";
import SectionLabel from "../ui/SectionLabel";
import { useRevealOnScroll, useStaggerReveal } from "../../animations/scrollAnimations";
import { useAuthModal } from "../../context/AuthModalContext";
import { AUTHENTICATED, useAuth } from "../../context/AuthProvider";
import { usePublicPlans } from "../../lib/usePublicPlans";

/**
 * The riding programmes ARE the three memberships sold in the store
 * (One-Time Ride, Gold, Platinum). Prices and allowances are read from the
 * live membership_plans table via usePublicPlans(), so this section can never
 * drift from the store.
 *
 * Each programme is one interactive panel (click, tap, Enter or Space):
 * signed-in visitors go to the store, everyone else gets the register popup.
 * Photos are the same ones the store's membership cards use.
 */
const DETAILS = {
  ONE_TIME_RIDE: {
    tagline: "A single session to experience the joy of riding.",
    image: "/assests/membership/one-time.jpg",
    focus: "60% 30%",
  },
  GOLD: {
    tagline: "The perfect rhythm for regular riders.",
    image: "/assests/membership/gold.jpg",
    focus: "50% 28%",
  },
  PLATINUM: {
    tagline: "For riders who want more time in the saddle.",
    image: "/assests/membership/platinum.jpg",
    focus: "60% 30%",
  },
};

const inr = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function RidingPrograms() {
  const { openAuth } = useAuthModal();
  const { status } = useAuth();
  const headerRef = useRevealOnScroll({ y: 24 });
  const gridRef = useStaggerReveal({ y: 36, stagger: 0.15 });
  const plans = usePublicPlans();
  const signedIn = status === AUTHENTICATED;
  const cta = signedIn ? "Choose in store" : "Get started";

  // Buying happens in the store; signed-out visitors are asked to register first.
  const choose = () => (signedIn ? window.location.assign("/store") : openAuth("register"));

  return (
    <section id="riding" className="paper-grain relative bg-soft-cream py-24 md:py-36">
      <div className="mx-auto max-w-[1440px] px-6 md:px-10">
        <div ref={headerRef} className="max-w-xl">
          <SectionLabel>Riding programmes</SectionLabel>
          <h2 className="mt-4 font-serif text-4xl leading-tight text-charcoal sm:text-5xl md:text-6xl">
            Find your place in the saddle.
          </h2>
        </div>

        <div ref={gridRef} className="mt-16 grid grid-cols-1 gap-px bg-charcoal/10 md:mt-20 md:grid-cols-3">
          {plans.map((plan, i) => {
            const d = DETAILS[plan.plan_code] ?? {};
            return (
              <article
                key={plan.plan_code}
                role="button"
                tabIndex={0}
                aria-label={`${plan.name}, ${inr(plan.price)}. ${cta}.`}
                onClick={choose}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    choose();
                  }
                }}
                className="group relative flex cursor-pointer flex-col bg-soft-cream transition-colors duration-500 ease-out hover:bg-warm-ivory focus-visible:z-10 focus-visible:bg-warm-ivory focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-antique-gold active:bg-[#f2ecdf]"
              >
                {/* gold rule that draws across the top on hover / focus */}
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 z-10 h-[3px] origin-left scale-x-0 bg-antique-gold transition-transform duration-500 ease-out group-hover:scale-x-100 group-focus-visible:scale-x-100"
                />

                {d.image && (
                  <div className="relative aspect-[16/10] overflow-hidden bg-deep-forest">
                    <img
                      src={d.image}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover saturate-[0.7] transition-[transform,filter] duration-[900ms] ease-out group-hover:scale-[1.05] group-hover:saturate-100 group-focus-visible:scale-[1.05] group-focus-visible:saturate-100"
                      style={{ objectPosition: d.focus }}
                    />
                    <div
                      aria-hidden="true"
                      className="absolute inset-0 bg-gradient-to-t from-deep-forest/35 to-transparent transition-opacity duration-500 group-hover:opacity-0"
                    />
                  </div>
                )}

                <div className="flex flex-1 flex-col p-8 md:p-10">
                  <span className="font-serif text-lg italic text-[#8a6a33]">Programme {i + 1}</span>
                  <h3 className="mt-3 font-serif text-3xl text-charcoal transition-colors duration-300 group-hover:text-racing-green md:text-[2.15rem]">
                    {plan.name}
                  </h3>
                  <p className="mt-2 font-sans text-sm tracking-wide text-warm-grey">{d.tagline ?? ""}</p>

                  <span
                    aria-hidden="true"
                    className="my-7 block h-px w-12 bg-antique-gold transition-[width] duration-500 ease-out group-hover:w-24"
                  />

                  <div className="numerals-editorial font-serif text-5xl text-racing-green md:text-[3.4rem]">{inr(plan.price)}</div>

                  <ul className="mt-6 space-y-2 font-sans text-[15px] text-charcoal/75">
                    {[
                      plural(plan.class_credits, "riding class", "riding classes"),
                      `Valid for ${plan.validity_days} days`,
                      `${plural(plan.reschedules_allowed, "reschedule", "reschedules")} included`,
                    ].map((line) => (
                      <li key={line} className="flex items-center gap-3">
                        <span aria-hidden="true" className="h-px w-3 bg-antique-gold/70 transition-[width] duration-300 group-hover:w-5" />
                        {line}
                      </li>
                    ))}
                  </ul>

                  {/* the whole panel is the control; this row just shows where it leads */}
                  <div className="mt-auto flex items-center justify-between pt-10">
                    <span className="relative font-sans text-xs tracking-[0.22em] text-charcoal uppercase">
                      {cta}
                      <span className="absolute -bottom-1.5 left-0 h-px w-full origin-left scale-x-50 bg-charcoal/40 transition-transform duration-300 group-hover:scale-x-100 group-hover:bg-racing-green" />
                    </span>
                    <span
                      aria-hidden="true"
                      className="flex h-11 w-11 items-center justify-center rounded-full border border-charcoal/20 text-charcoal transition-all duration-300 ease-out group-hover:border-racing-green group-hover:bg-racing-green group-hover:text-warm-ivory group-active:scale-95"
                    >
                      <ArrowRight size={16} strokeWidth={1.5} className="transition-transform duration-300 group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        <p className="mt-10 max-w-2xl font-sans text-sm font-light leading-relaxed text-warm-grey">
          Every programme is valid for {plans[0]?.validity_days ?? 30} days from purchase. Riders are welcome to continue
          their journey across multiple months as they build skill and confidence in the saddle.
        </p>
      </div>
    </section>
  );
}
