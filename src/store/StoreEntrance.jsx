import { ArrowLeft, ArrowRight } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { useAuthModal } from "../context/AuthModalContext";
import { usePublicPlans } from "../lib/usePublicPlans";
import { formatINR } from "./cartMath";

/**
 * What a signed-out visitor sees at /store, /cart or /checkout: the way in.
 * Buying needs an account, so this page says what is inside (the plans, read
 * live so the prices are the real ones) and offers the two ways through the
 * door. The buttons open the shared Login / Register popup, which StoreApp
 * mounts alongside this page.
 *
 * It is meant to be taken in at a glance, so on desktop and laptop screens it
 * fits one screen without scrolling: the lg: spacing and sizes below scale
 * with the screen height (clamp(min, vh, max)) rather than being fixed.
 */
export default function StoreEntrance() {
  const { openAuth } = useAuthModal();
  const plans = usePublicPlans();
  const reduceMotion = useReducedMotion();
  const rise = reduceMotion ? {} : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } };

  return (
    <div className="grid min-h-screen bg-warm-ivory lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
      {/* Photograph — a band on phones, the left half on desktop. */}
      <aside className="relative isolate flex min-h-[240px] flex-col overflow-hidden bg-deep-forest px-6 py-7 text-warm-ivory sm:px-10 lg:min-h-screen lg:px-14 lg:py-[clamp(1.25rem,5vh,3rem)]">
        <img src="/assests/membership/gold.jpg" alt="" className="absolute inset-0 -z-10 h-full w-full object-cover object-[50%_28%]" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-deep-forest/75 via-deep-forest/10 to-deep-forest/85" aria-hidden="true" />

        <a href="/" className="flex w-fit items-center gap-3.5 rounded-[10px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-champagne-gold">
          <img src="/assests/ecl-gold.png" alt="Colonel Horse Riding crest" className="h-11 w-auto shrink-0 lg:h-14" />
          <span className="font-serif text-lg leading-tight tracking-[0.04em] lg:text-xl">Colonel Horse Riding</span>
        </a>

        <motion.div {...rise} className="mt-auto pt-8">
          <p className="font-serif text-lg italic text-champagne-gold">The club store</p>
          <p className="mt-2 max-w-[15ch] font-serif text-[2.1rem] leading-[1.04] [text-wrap:balance] sm:text-[2.6rem] lg:text-[clamp(2.3rem,7vh,3.6rem)]">Your riding starts here.</p>
          <p className="mt-4 hidden max-w-sm font-sans text-[15px] leading-relaxed text-warm-ivory/80 lg:block">
            Choose a plan, pay online, and book your first class the same day.
          </p>
        </motion.div>
      </aside>

      {/* The way in */}
      <main className="paper-grain relative flex items-center justify-center px-6 py-10 sm:px-10 lg:py-[clamp(0.75rem,3.5vh,4rem)]">
        <motion.div {...rise} className="w-full max-w-[460px]">
          <p className="font-serif text-lg italic text-[#8a6a33]">Members and guests</p>
          <h1 className="mt-1.5 font-serif text-[2.4rem] leading-[1.06] text-charcoal [text-wrap:balance] sm:text-[2.9rem] lg:text-[clamp(1.9rem,5.4vh,2.9rem)]">Sign in to enter the store</h1>
          <p className="mt-3 font-sans text-[15px] leading-relaxed text-warm-grey lg:mt-[clamp(0.35rem,1.2vh,0.75rem)]">Log in, or create an account in a minute, to buy a membership or riding tack.</p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row lg:mt-[clamp(0.9rem,3.2vh,2rem)]">
            <button
              type="button"
              onClick={() => openAuth("login")}
              className="group flex h-[54px] shrink-0 items-center justify-center gap-2.5 rounded-[12px] bg-racing-green px-5 sm:flex-1 lg:h-[clamp(44px,5.8vh,54px)] font-sans text-[13px] font-semibold tracking-[0.14em] text-warm-ivory uppercase shadow-[0_14px_30px_-16px_rgba(18,55,42,0.7)] transition-colors duration-200 hover:bg-deep-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-antique-gold"
            >
              Log in
              <ArrowRight size={16} strokeWidth={1.75} className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={() => openAuth("register")}
              className="flex h-[54px] shrink-0 items-center justify-center rounded-[12px] border border-racing-green/35 bg-white/60 px-5 sm:flex-1 lg:h-[clamp(44px,5.8vh,54px)] font-sans text-[13px] font-semibold tracking-[0.14em] text-racing-green uppercase transition-colors duration-200 hover:border-racing-green hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-antique-gold"
            >
              Create account
            </button>
          </div>

          <section className="mt-10 lg:mt-[clamp(1rem,4.2vh,2.5rem)]" aria-labelledby="store-inside">
            <h2 id="store-inside" className="font-serif text-lg italic text-[#8a6a33]">
              What&apos;s inside
            </h2>
            <ul className="mt-3 divide-y divide-charcoal/[0.08] border-y border-charcoal/[0.08]">
              {plans.map((p) => (
                <li key={p.plan_code} className="flex items-baseline justify-between gap-4 py-3.5 lg:py-[clamp(0.3rem,1.45vh,0.875rem)]">
                  <span>
                    <span className="block font-serif text-xl leading-tight text-charcoal lg:text-[clamp(1.05rem,2.7vh,1.25rem)]">{p.name}</span>
                    <span className="mt-0.5 block font-sans text-[13px] text-warm-grey">
                      {p.class_credits} class{p.class_credits === 1 ? "" : "es"} · valid {p.validity_days} days
                    </span>
                  </span>
                  <span className="shrink-0 font-serif text-xl text-racing-green lg:text-[clamp(1.05rem,2.7vh,1.25rem)]">{formatINR(p.price)}</span>
                </li>
              ))}
              <li className="flex items-baseline justify-between gap-4 py-3.5 lg:py-[clamp(0.3rem,1.45vh,0.875rem)]">
                <span>
                  <span className="block font-serif text-xl leading-tight text-charcoal lg:text-[clamp(1.05rem,2.7vh,1.25rem)]">Riding tack</span>
                  <span className="mt-0.5 block font-sans text-[13px] text-warm-grey">Helmets, boots and more, collected in store</span>
                </span>
              </li>
            </ul>
          </section>

          <a href="/" className="mt-8 inline-flex items-center gap-1.5 font-sans text-[13px] font-medium text-racing-green lg:mt-[clamp(0.8rem,3.2vh,2rem)] underline-offset-4 hover:underline">
            <ArrowLeft size={14} strokeWidth={1.75} /> Back to the website
          </a>
        </motion.div>
      </main>
    </div>
  );
}
