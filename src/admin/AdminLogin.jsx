import { useId, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { AlertCircle, ArrowLeft, ArrowRight, Eye, EyeOff, Lock, Mail } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { markActivity } from "../lib/idleSession";
import { rememberCredential } from "../lib/rememberCredential";
import { friendlyAuthError } from "../lib/authValidation";

const FIELD =
  "h-[52px] w-full rounded-[12px] lg:h-[clamp(42px,5.6vh,52px)] border border-antique-gold/30 bg-white pl-11 font-sans text-[15px] text-charcoal outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-warm-grey/60 focus:border-antique-gold focus:ring-4 focus:ring-antique-gold/15";

/**
 * Sign-in for the admin console. Full height, two halves: a brand panel that
 * uses the same photograph as the console sidebar (so signing in feels like
 * walking into the same place), and the form.
 *
 * It fits one screen on desktop and laptop sizes, error message included:
 * the lg: spacing and sizes scale with the screen height (clamp(min, vh,
 * max)) instead of being fixed.
 *
 * Staff accounts only — there is deliberately no sign-up here. Who may enter
 * is decided after sign-in from profile.role (see AdminApp) and enforced by
 * the database, never by this page.
 */
export default function AdminLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // Browser/password-manager convenience only — not a persistent login.
  const [rememberMe, setRememberMe] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | submitting | error
  const [errorMessage, setErrorMessage] = useState("");
  const errorId = useId();
  const reduceMotion = useReducedMotion();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus("submitting");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setStatus("error");
      setErrorMessage(friendlyAuthError(error, "login"));
      return;
    }
    markActivity();
    if (rememberMe) await rememberCredential({ email: email.trim(), password, name: email.trim() });
    // A successful sign-in flips `session` via onAuthStateChange in AdminApp.
    setStatus("idle");
  };

  const rise = reduceMotion ? {} : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } };
  const busy = status === "submitting";

  return (
    <div className="grid min-h-screen bg-warm-ivory lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      {/* Brand panel — a short band on phones, the full left half on desktop. */}
      <aside className="relative isolate flex flex-col overflow-hidden bg-deep-forest px-6 py-7 text-warm-ivory sm:px-10 lg:min-h-screen lg:px-14 lg:py-[clamp(1.25rem,5vh,3rem)]">
        <img src="/assests/sidebar.webp" alt="" className="absolute inset-0 -z-10 h-full w-full object-cover object-[50%_82%] lg:object-bottom" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-deep-forest/85 via-deep-forest/55 to-deep-forest/45 lg:from-deep-forest/80 lg:via-transparent lg:to-transparent" aria-hidden="true" />
        <div className="absolute inset-x-0 bottom-0 -z-10 hidden h-40 bg-gradient-to-t from-deep-forest/85 to-transparent lg:block" aria-hidden="true" />

        <div className="flex items-center gap-3.5">
          <img src="/assests/ecl-gold.png" alt="Colonel Horse Riding crest" className="h-11 w-auto shrink-0 lg:h-14" />
          <div>
            <p className="font-serif text-lg leading-tight tracking-[0.04em] lg:text-xl">Colonel Horse Riding</p>
            <p className="mt-0.5 font-sans text-[10px] tracking-[0.26em] text-champagne-gold uppercase">Admin console</p>
          </div>
        </div>

        <motion.div {...rise} className="mt-8 lg:mt-[14vh]">
          <h2 className="max-w-[13ch] font-serif text-[2rem] leading-[1.04] [text-wrap:balance] sm:text-[2.4rem] lg:text-[clamp(2.3rem,7vh,3.6rem)]">The whole club, on one page.</h2>
          <p className="mt-4 hidden max-w-sm font-sans text-[15px] leading-relaxed text-warm-ivory/75 lg:block">
            Members, classes, bookings, orders and payments, as they stand today.
          </p>
        </motion.div>

        <p className="mt-auto hidden pt-6 font-serif text-lg italic text-warm-ivory/85 lg:block">&ldquo;More than a farm, a way of life.&rdquo;</p>
      </aside>

      {/* Form */}
      <main className="paper-grain relative flex items-center justify-center px-6 py-10 sm:px-10 lg:py-[clamp(0.75rem,3.5vh,4rem)]">
        <motion.div {...rise} className="w-full max-w-[420px]">
          <p className="font-serif text-lg italic text-[#8a6a33]">Staff sign-in</p>
          <h1 className="mt-1.5 font-serif text-[2.6rem] leading-[1.05] text-charcoal sm:text-[3rem] lg:text-[clamp(2rem,5.6vh,3rem)]">Welcome back</h1>
          <p className="mt-3 font-sans text-[15px] leading-relaxed text-warm-grey lg:mt-[clamp(0.35rem,1.2vh,0.75rem)]">Sign in with your staff account to open the console.</p>

          <form onSubmit={handleSubmit} className="mt-9 space-y-5 lg:mt-[clamp(0.9rem,3.6vh,2.25rem)] lg:space-y-[clamp(0.6rem,2vh,1.25rem)]">
            <div>
              <label htmlFor="admin-email" className="font-sans text-[13px] font-medium text-charcoal">
                Email
              </label>
              <div className="relative mt-2">
                <Mail size={17} strokeWidth={1.6} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-antique-gold" aria-hidden="true" />
                <input
                  id="admin-email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  autoFocus
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  aria-invalid={status === "error" || undefined}
                  aria-describedby={status === "error" ? errorId : undefined}
                  className={`${FIELD} pr-4`}
                />
              </div>
            </div>

            <div>
              <label htmlFor="admin-password" className="font-sans text-[13px] font-medium text-charcoal">
                Password
              </label>
              <div className="relative mt-2">
                <Lock size={17} strokeWidth={1.6} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-antique-gold" aria-hidden="true" />
                <input
                  id="admin-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={status === "error" || undefined}
                  aria-describedby={status === "error" ? errorId : undefined}
                  className={`${FIELD} pr-12`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  className="absolute top-1/2 right-2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-[8px] text-warm-grey transition-colors hover:bg-soft-cream hover:text-charcoal focus-visible:outline-2 focus-visible:outline-antique-gold"
                >
                  {showPassword ? <EyeOff size={17} strokeWidth={1.6} /> : <Eye size={17} strokeWidth={1.6} />}
                </button>
              </div>
            </div>

            <label className="flex w-fit cursor-pointer items-center gap-2.5 font-sans text-[13px] text-warm-grey">
              <input type="checkbox" name="remember" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} className="h-4 w-4 accent-racing-green" />
              Remember me on this device
            </label>

            {status === "error" && (
              <div id={errorId} role="alert" className="flex items-start gap-2.5 rounded-[12px] border border-destructive/30 bg-destructive/5 px-4 py-3 lg:py-[clamp(0.45rem,1.2vh,0.75rem)]">
                <AlertCircle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-destructive" />
                <p className="font-sans text-[13px] leading-relaxed text-destructive">{errorMessage}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="group flex h-[54px] w-full items-center justify-center gap-2.5 rounded-[12px] bg-racing-green lg:h-[clamp(44px,5.8vh,54px)] font-sans text-[13px] font-semibold tracking-[0.14em] text-warm-ivory uppercase shadow-[0_14px_30px_-16px_rgba(18,55,42,0.7)] transition-colors duration-200 hover:bg-deep-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-antique-gold disabled:opacity-60"
            >
              {busy ? "Signing in…" : "Sign in"}
              {!busy && <ArrowRight size={16} strokeWidth={1.75} className="transition-transform duration-200 group-hover:translate-x-0.5" />}
            </button>
          </form>

          <div className="mt-10 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-charcoal/10 pt-6 lg:mt-[clamp(0.9rem,4vh,2.5rem)] lg:pt-[clamp(0.7rem,2.4vh,1.5rem)]">
            <p className="font-sans text-[13px] text-warm-grey">For staff only. Riders sign in on the main site.</p>
            <a href="/" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-medium text-racing-green underline-offset-4 hover:underline">
              <ArrowLeft size={14} strokeWidth={1.75} /> Back to the website
            </a>
          </div>
        </motion.div>
      </main>
    </div>
  );
}
