import { Check } from "lucide-react";
import { usePublicPlans } from "../../lib/usePublicPlans";
import { orderNumber } from "../../lib/labels";
import { ActionButton } from "../ui";

const inr = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

/**
 * What a rider without a plan sees instead of three empty tiles: where they
 * are in the three steps, and the plans themselves (live from the database).
 * If an order has been started but not paid, the panel leads with finishing
 * that payment instead of offering the plans again.
 */
export default function WelcomePanel({ lapsed = false, pendingOrder = null }) {
  const plans = usePublicPlans();
  const waiting = Boolean(pendingOrder);
  const steps = [
    { title: "Choose a plan", text: "A single ride, or a month of classes." },
    { title: "Pay online", text: "By UPI, card or net banking. Your plan starts the moment the payment goes through." },
    { title: "Book your classes", text: "Pick a day and a time that suits you." },
  ];
  const current = waiting ? 1 : 0;

  return (
    <section className="rounded-[22px] border border-antique-gold/25 bg-white p-6 sm:p-9">
      <p className="font-serif text-lg italic text-[#8a6a33]">{lapsed ? "Welcome back" : "Welcome"}</p>
      <h2 className="mt-2 font-serif text-[2rem] leading-tight text-charcoal [text-wrap:balance] sm:text-[2.4rem]">
        {waiting ? "Finish paying to start riding" : lapsed ? "Your last plan has ended" : "Three steps to your first ride"}
      </h2>
      {waiting && (
        <p className="mt-3 max-w-xl font-sans text-base leading-relaxed text-warm-grey">
          Order {orderNumber(pendingOrder.id)} hasn&apos;t been paid yet. As soon as you pay, your plan starts and you can book your first class.
        </p>
      )}

      <ol className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-3">
        {steps.map((step, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={step.title} className={`border-t-2 pt-4 ${done || active ? "border-racing-green" : "border-charcoal/10"}`}>
              <p className="flex items-center gap-2 font-serif text-lg italic text-[#8a6a33]">
                {done ? <Check size={16} strokeWidth={2} className="text-racing-green" /> : `${i + 1}.`}
                {active && waiting && <span className="font-sans text-[11px] tracking-[0.12em] text-racing-green not-italic uppercase">In progress</span>}
              </p>
              <p className={`mt-1 font-serif text-xl ${done || active ? "text-charcoal" : "text-charcoal/60"}`}>{step.title}</p>
              <p className="mt-1.5 font-sans text-sm leading-relaxed text-warm-grey">{step.text}</p>
            </li>
          );
        })}
      </ol>

      {waiting ? (
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <ActionButton href="/orders" variant="primary">
            Complete payment
          </ActionButton>
          <ActionButton href="/store" variant="ghost">
            Choose a different plan
          </ActionButton>
        </div>
      ) : (
        <>
          <ul className="mt-9 divide-y divide-charcoal/[0.08] border-y border-charcoal/[0.08]">
            {plans.map((p) => (
              <li key={p.plan_code} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-4">
                <span className="font-serif text-xl text-charcoal">{p.name}</span>
                <span className="font-sans text-sm text-warm-grey">
                  {p.class_credits} class{p.class_credits === 1 ? "" : "es"} · valid {p.validity_days} days
                  <span className="ml-4 font-serif text-xl text-racing-green">{inr(p.price)}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-7">
            <ActionButton href="/store" variant="primary">
              Choose a plan
            </ActionButton>
          </div>
        </>
      )}
    </section>
  );
}
