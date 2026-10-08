import { useEffect, useState } from "react";
import SectionLabel from "../ui/SectionLabel";
import GoldDivider from "../ui/GoldDivider";
import Button from "../ui/Button";
import { useRevealOnScroll, useStaggerReveal } from "../../animations/scrollAnimations";
import { useAuthModal } from "../../context/AuthModalContext";
import { AUTHENTICATED, useAuth } from "../../context/AuthProvider";
import { supabase } from "../../lib/supabaseClient";

/**
 * The riding programmes ARE the three memberships sold in the store
 * (One-Time Ride, Gold, Platinum). Prices and allowances are read from the
 * live membership_plans table (publicly readable for active plans) so this
 * section can never drift from the store; the constants below are only the
 * fallback shown if that read fails, and they mirror the current plans.
 */
const TAGLINE = {
  ONE_TIME_RIDE: "A single session to experience the joy of riding.",
  GOLD: "The perfect rhythm for regular riders.",
  PLATINUM: "For riders who want more time in the saddle.",
};

const FALLBACK = [
  { plan_code: "ONE_TIME_RIDE", name: "One-Time Ride", price: 2000, class_credits: 1, validity_days: 30, reschedules_allowed: 1 },
  { plan_code: "GOLD", name: "Gold Membership", price: 15000, class_credits: 8, validity_days: 30, reschedules_allowed: 2 },
  { plan_code: "PLATINUM", name: "Platinum Membership", price: 18000, class_credits: 12, validity_days: 30, reschedules_allowed: 2 },
];

const inr = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export default function RidingPrograms() {
  const { openAuth } = useAuthModal();
  const { status } = useAuth();
  const headerRef = useRevealOnScroll({ y: 24 });
  const gridRef = useStaggerReveal({ y: 36, stagger: 0.15 });
  const [plans, setPlans] = useState(FALLBACK);

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    supabase
      .from("membership_plans")
      .select("plan_code, name, price, class_credits, validity_days, reschedules_allowed")
      .not("plan_code", "is", null)
      .eq("is_active", true)
      .order("price")
      .then(({ data, error }) => {
        if (active && !error && data?.length) setPlans(data.map((p) => ({ ...p, price: Number(p.price) })));
      });
    return () => {
      active = false;
    };
  }, []);

  // Buying happens in the store; signed-out visitors are asked to log in first.
  const choose = () => (status === AUTHENTICATED ? window.location.assign("/store") : openAuth("register"));

  return (
    <section id="riding" className="relative bg-soft-cream py-24 md:py-36">
      <div className="mx-auto max-w-[1440px] px-6 md:px-10">
        <div ref={headerRef} className="max-w-xl">
          <SectionLabel>Riding Programs</SectionLabel>
          <h2 className="mt-6 font-serif text-4xl leading-tight text-charcoal sm:text-5xl md:text-6xl">
            Find Your Place in the Saddle.
          </h2>
        </div>

        <div ref={gridRef} className="mt-16 grid grid-cols-1 gap-px bg-charcoal/10 md:mt-20 md:grid-cols-3">
          {plans.map((plan, i) => (
            <div key={plan.plan_code} className="flex flex-col justify-between bg-soft-cream p-10 md:p-12">
              <div>
                <span className="font-sans text-xs tracking-[0.32em] text-antique-gold">PROGRAM {String(i + 1).padStart(2, "0")}</span>
                <h3 className="mt-4 font-serif text-3xl text-charcoal md:text-4xl">{plan.name}</h3>
                <p className="mt-2 font-sans text-sm tracking-wide text-warm-grey">{TAGLINE[plan.plan_code] ?? ""}</p>

                <GoldDivider className="my-8" width="w-12" />

                <div className="numerals-editorial font-serif text-5xl text-racing-green md:text-6xl">{inr(plan.price)}</div>

                <ul className="mt-6 space-y-2 font-sans text-sm uppercase tracking-[0.14em] text-charcoal/70">
                  <li>{plural(plan.class_credits, "Riding Class", "Riding Classes")}</li>
                  <li>Valid {plan.validity_days} Days</li>
                  <li>{plural(plan.reschedules_allowed, "Reschedule", "Reschedules")} Included</li>
                </ul>
              </div>

              <div className="mt-12">
                <Button onClick={choose} variant="link" className="text-charcoal hover:text-racing-green">
                  {status === AUTHENTICATED ? "Choose in Store" : "Get Started"}
                </Button>
              </div>
            </div>
          ))}
        </div>

        <p className="mt-10 max-w-2xl font-sans text-sm font-light leading-relaxed text-warm-grey">
          Every programme is valid for {plans[0]?.validity_days ?? 30} days from purchase. Riders are welcome to continue
          their journey across multiple months as they build skill and confidence in the saddle.
        </p>
      </div>
    </section>
  );
}
