import { useEffect, useId, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { AlertCircle, ArrowLeft, ArrowRight, CheckCircle2, Eye, EyeOff, Loader2, Lock, Mail, User } from "lucide-react";
import { useAuth } from "../../context/AuthProvider";
import { supabase, supabaseConfigured } from "../../lib/supabaseClient";
import { friendlyAuthError, normalizeEmail, validateAuthForm } from "../../lib/authValidation";
import { markActivity } from "../../lib/idleSession";
import { rememberCredential } from "../../lib/rememberCredential";
import { googleReturnError, useGoogleSignIn } from "../../lib/googleAuth";
import GoogleButton, { OrRule } from "../ui/GoogleButton";

/**
 * Where a customer lands after signing in or registering from anywhere
 * outside the member area: their dashboard. (The cart is saved on the device,
 * so anything they had chosen is still there in the store.)
 */
export const POST_AUTH_PATH = "/account";

const COPY = {
  login: {
    label: "Welcome back",
    heading: "Sign in",
    text: "Sign in to manage your membership and upcoming rides.",
    submit: "Sign in",
    busy: "Signing in…",
  },
  register: {
    label: "Become a member",
    heading: "Create your account",
    text: "Manage your membership, book classes and follow your progress.",
    submit: "Create account",
    busy: "Creating account…",
  },
  forgot: {
    label: "Account recovery",
    heading: "Reset your password",
    text: "Enter your email and we'll send you a link to choose a new password.",
    submit: "Send reset link",
    busy: "Sending…",
  },
  reset: {
    label: "Account recovery",
    heading: "Choose a new password",
    text: "Set a new password to continue to your account.",
    submit: "Set new password",
    busy: "Saving…",
  },
};

const STAFF_COPY = {
  label: "Staff sign-in",
  heading: "Welcome back",
  text: "Sign in with your staff account to open the console.",
  submit: "Sign in",
  busy: "Signing in…",
};

const FIELD =
  "h-[50px] w-full rounded-[12px] lg:h-[clamp(40px,5.4vh,50px)] border bg-white pl-11 font-sans text-[15px] text-charcoal outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-warm-grey/60 focus:border-antique-gold focus:ring-4 focus:ring-antique-gold/15";

function startingMode(variant, recovery) {
  if (recovery) return "reset";
  if (variant === "staff") return "login";
  try {
    return new URLSearchParams(window.location.search).get("mode") === "register" ? "register" : "login";
  } catch {
    return "login";
  }
}

/**
 * The one sign-in screen of the whole site. /account, /store, /cart,
 * /checkout and /admin all show this when nobody is signed in, and the
 * Login / Register buttons on the website lead here too (/account, with
 * ?mode=register for the second), so a visitor always meets the same page.
 *
 * Two variants share the layout and the code: "member" (sign in, create an
 * account, Google, forgot password) and "staff" (sign in only: there is
 * deliberately no sign-up for staff, and who may enter the console is decided
 * after sign-in from profile.role and enforced by the database, never here).
 *
 * Client validation (lib/authValidation.js) runs BEFORE any request, so a
 * validation failure can never leave the button in a loading state. It fits
 * one screen on desktop and laptop sizes, error message included: the lg:
 * spacing and sizes scale with the screen height (clamp(min, vh, max)).
 */
export default function AuthScreen({ variant = "member" }) {
  const staff = variant === "staff";
  const { recovery, endRecovery } = useAuth();
  const [mode, setMode] = useState(() => startingMode(variant, recovery)); // login | register | forgot | reset
  const [fields, setFields] = useState({ fullName: "", email: "", password: "", confirm: "" });
  const [fieldErrors, setFieldErrors] = useState({});
  // Google sends a rider back here; if that did not end in a session, say so.
  const [formError, setFormError] = useState(() => {
    const returned = googleReturnError();
    return returned ? { message: returned } : null;
  }); // { message, duplicate? }
  const [view, setView] = useState("form"); // form | check-email | reset-sent
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Remember me asks the browser/password manager to save the sign-in. It does
  // not extend the session and the password is never stored by this app.
  const [rememberMe, setRememberMe] = useState(false);
  const google = useGoogleSignIn();
  const titleId = useId();
  const errorId = useId();
  const reduceMotion = useReducedMotion();
  const firstRef = useRef(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, [mode, view]);

  const set = (key) => (e) => {
    const value = e.target.value;
    setFields((f) => ({ ...f, [key]: value }));
    setFieldErrors((errs) => (errs[key] ? { ...errs, [key]: undefined } : errs));
    setFormError(null);
  };

  const switchMode = (next) => {
    setMode(next);
    setView("form");
    setFormError(null);
    setFieldErrors({});
    setShowPassword(false);
    setFields((f) => ({ ...f, password: "", confirm: "" }));
  };

  // Inside the member area the session change re-renders the page already;
  // from anywhere else (store, admin sign-in aside) the dashboard opens first.
  const afterSignIn = () => {
    const path = window.location.pathname;
    if (staff || path.startsWith("/account") || path.startsWith("/orders")) return;
    window.location.assign(POST_AUTH_PATH);
  };

  // Signing in and signing up are the same trip to Google; the browser
  // leaves this page and comes back on the dashboard.
  const handleGoogle = async () => {
    if (submitting || google.busy) return;
    setFormError(null);
    setFieldErrors({});
    const { error } = await google.start();
    if (error) setFormError({ message: error });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);

    const errors = validateAuthForm(mode, fields);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});

    if (!supabaseConfigured) {
      setFormError({ message: "The database isn't connected yet. Add your Supabase credentials to .env.local." });
      return;
    }

    const email = normalizeEmail(fields.email);
    setSubmitting(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password: fields.password });
        if (error) return setFormError({ message: friendlyAuthError(error, "login") });
        markActivity();
        if (rememberMe) await rememberCredential({ email, password: fields.password, name: email });
        afterSignIn();
        return;
      }

      if (mode === "register") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password: fields.password,
          options: { data: { full_name: fields.fullName.trim() || null } },
        });
        if (error) {
          const message = friendlyAuthError(error, "register");
          return setFormError({ message, duplicate: /already exists/.test(message) });
        }
        // An already-registered email comes back as success with no identities.
        if (data.user?.identities && data.user.identities.length === 0) {
          return setFormError({ message: friendlyAuthError({ message: "User already registered" }, "register"), duplicate: true });
        }
        if (!data.session) {
          setView("check-email");
          return;
        }
        markActivity();
        afterSignIn();
        return;
      }

      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/` });
        if (error) return setFormError({ message: friendlyAuthError(error, "forgot") });
        setView("reset-sent");
        return;
      }

      // mode === "reset": signed in through the recovery link
      const { error } = await supabase.auth.updateUser({ password: fields.password });
      if (error) return setFormError({ message: friendlyAuthError(error, "reset") });
      markActivity();
      endRecovery();
      afterSignIn();
    } catch {
      setFormError({ message: friendlyAuthError({ message: "network" }, mode) });
    } finally {
      setSubmitting(false);
    }
  };

  const copy = staff ? STAFF_COPY : COPY[mode];
  const offerGoogle = !staff && (mode === "login" || mode === "register") && google.available;
  const needsConfirm = mode === "register" || mode === "reset";
  const busy = submitting || google.busy;
  const rise = reduceMotion ? {} : { initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } };

  return (
    <div className="grid min-h-screen bg-warm-ivory lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
      {/* Photograph — a band on phones, the left half on desktop. */}
      <aside className="relative isolate flex min-h-[200px] flex-col overflow-hidden bg-deep-forest px-6 py-6 text-warm-ivory sm:px-10 lg:min-h-screen lg:px-14 lg:py-[clamp(1.25rem,5vh,3rem)]">
        <img src="/assests/membership/gold.jpg" alt="" className="absolute inset-0 -z-10 h-full w-full object-cover object-[50%_28%]" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-deep-forest/75 via-deep-forest/10 to-deep-forest/85" aria-hidden="true" />

        <a href="/" className="flex w-fit items-center gap-3.5 rounded-[10px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-champagne-gold">
          <img src="/assests/ecl-gold.png" alt="" className="h-11 w-auto shrink-0 lg:h-14" />
          <span>
            <span className="block font-serif text-lg leading-tight tracking-[0.04em] lg:text-xl">Colonel Horse Riding</span>
            {staff && <span className="mt-0.5 block font-sans text-[10px] tracking-[0.26em] text-champagne-gold uppercase">Admin console</span>}
          </span>
        </a>

        <motion.div {...rise} className="mt-auto pt-6">
          <p className="max-w-[15ch] font-serif text-[2rem] leading-[1.04] [text-wrap:balance] sm:text-[2.6rem] lg:text-[clamp(2.3rem,7vh,3.6rem)]">{staff ? "The whole club, on one page." : "Your riding starts here."}</p>
          <p className="mt-4 hidden max-w-sm font-sans text-[15px] leading-relaxed text-warm-ivory/80 lg:block">
            {staff ? "Members, classes, bookings, orders and payments, as they stand today." : "Choose a plan, pay online, and book your first class the same day."}
          </p>
        </motion.div>
      </aside>

      <main className="paper-grain relative flex items-center justify-center px-6 py-10 sm:px-10 lg:py-[clamp(0.75rem,3.5vh,4rem)]">
        <motion.div {...rise} className="w-full max-w-[440px]">
          {view !== "form" ? (
            <SentNotice kind={view} email={normalizeEmail(fields.email)} titleId={titleId} onBack={() => switchMode("login")} />
          ) : (
            <>
              <p className="font-serif text-lg italic text-[#8a6a33]">{copy.label}</p>
              <h1 id={titleId} className="mt-1.5 font-serif text-[2.4rem] leading-[1.06] text-charcoal [text-wrap:balance] sm:text-[2.8rem] lg:text-[clamp(1.9rem,5.2vh,2.8rem)]">
                {copy.heading}
              </h1>
              {/* Registering with Google offered is the tallest the form gets: a
                  short screen gives up this sentence so nothing has to scroll. */}
              <p className="mt-3 font-sans text-[15px] leading-relaxed text-warm-grey lg:mt-[clamp(0.3rem,1.1vh,0.75rem)] lg:[@media(max-height:760px)]:hidden">{copy.text}</p>

              <form onSubmit={handleSubmit} noValidate aria-labelledby={titleId} className="mt-8 space-y-4 lg:mt-[clamp(0.7rem,3vh,2rem)] lg:space-y-[clamp(0.45rem,1.7vh,1rem)]">
                {mode === "register" && (
                  <Field id="auth-name" label="Full name" icon={User} type="text" autoComplete="name" value={fields.fullName} onChange={set("fullName")} error={fieldErrors.fullName} inputRef={firstRef} />
                )}
                {mode !== "reset" && (
                  <Field
                    id="auth-email"
                    label="Email"
                    icon={Mail}
                    type="email"
                    inputMode="email"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="you@example.com"
                    value={fields.email}
                    onChange={set("email")}
                    error={fieldErrors.email}
                    inputRef={mode === "register" ? undefined : firstRef}
                  />
                )}

                {mode !== "forgot" && (
                  <div className={needsConfirm ? "grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-3" : ""}>
                    <PasswordField
                      id="auth-password"
                      label={mode === "reset" ? "New password" : "Password"}
                      autoComplete={mode === "login" ? "current-password" : "new-password"}
                      value={fields.password}
                      onChange={set("password")}
                      error={fieldErrors.password}
                      show={showPassword}
                      onToggle={() => setShowPassword((s) => !s)}
                      inputRef={mode === "reset" ? firstRef : undefined}
                      aside={
                        mode === "login" && !staff ? (
                          <button type="button" onClick={() => switchMode("forgot")} className="font-sans text-[12px] text-warm-grey underline-offset-4 transition-colors hover:text-racing-green hover:underline">
                            Forgot?
                          </button>
                        ) : null
                      }
                    />
                    {needsConfirm && (
                      <PasswordField
                        id="auth-confirm"
                        label="Confirm"
                        autoComplete="new-password"
                        value={fields.confirm}
                        onChange={set("confirm")}
                        error={fieldErrors.confirm}
                        show={showPassword}
                        onToggle={() => setShowPassword((s) => !s)}
                      />
                    )}
                  </div>
                )}

                {mode === "login" && (
                  <label className="flex w-fit cursor-pointer items-center gap-2.5 font-sans text-[13px] text-warm-grey">
                    <input type="checkbox" name="remember" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} className="h-4 w-4 accent-racing-green" />
                    Remember me on this device
                  </label>
                )}

                {formError && (
                  <div id={errorId} role="alert" className="flex items-start gap-2.5 rounded-[12px] border border-destructive/30 bg-destructive/5 px-4 py-3 lg:py-[clamp(0.4rem,1.1vh,0.75rem)]">
                    <AlertCircle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-destructive" />
                    <p className="font-sans text-[13px] leading-relaxed text-destructive">
                      {formError.message}
                      {formError.duplicate && (
                        <>
                          {" "}
                          <button type="button" onClick={() => switchMode("login")} className="font-medium underline underline-offset-2">
                            Sign in
                          </button>
                        </>
                      )}
                    </p>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  aria-busy={submitting}
                  className="group flex h-[54px] w-full items-center justify-center gap-2.5 rounded-[12px] bg-racing-green lg:h-[clamp(44px,5.8vh,54px)] font-sans text-[13px] font-semibold tracking-[0.14em] text-warm-ivory uppercase shadow-[0_14px_30px_-16px_rgba(18,55,42,0.7)] transition-colors duration-200 hover:bg-deep-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-antique-gold disabled:cursor-wait disabled:opacity-70"
                >
                  {submitting && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
                  {submitting ? copy.busy : copy.submit}
                  {!submitting && <ArrowRight size={16} strokeWidth={1.75} className="transition-transform duration-200 group-hover:translate-x-0.5" />}
                </button>
              </form>

              {offerGoogle && (
                <div className="mt-4 lg:mt-[clamp(0.45rem,1.7vh,1rem)]">
                  <OrRule />
                  <GoogleButton busy={google.busy} disabled={submitting} onClick={handleGoogle} className="mt-4 h-[50px] rounded-[12px] lg:mt-[clamp(0.45rem,1.7vh,1rem)] lg:h-[clamp(42px,5.6vh,50px)]">
                    {mode === "login" ? "Sign in with Google" : "Sign up with Google"}
                  </GoogleButton>
                </div>
              )}

              <div className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 font-sans text-[13px] text-warm-grey lg:mt-[clamp(0.55rem,2.6vh,1.5rem)]">
                {staff ? (
                  <>
                    <p>For staff only. Riders sign in on the main site.</p>
                    <a href="/" className="inline-flex items-center gap-1.5 font-medium text-racing-green underline-offset-4 hover:underline">
                      <ArrowLeft size={14} strokeWidth={1.75} /> Back to the website
                    </a>
                  </>
                ) : (
                  <>
                    <p>
                      {mode === "login" && (
                        <>
                          New to the club?{" "}
                          <button type="button" onClick={() => switchMode("register")} className="font-medium text-racing-green underline underline-offset-4 hover:text-deep-forest">
                            Create an account
                          </button>
                        </>
                      )}
                      {mode === "register" && (
                        <>
                          Already a member?{" "}
                          <button type="button" onClick={() => switchMode("login")} className="font-medium text-racing-green underline underline-offset-4 hover:text-deep-forest">
                            Sign in
                          </button>
                        </>
                      )}
                      {(mode === "forgot" || mode === "reset") && (
                        <button type="button" onClick={() => switchMode("login")} className="font-medium text-racing-green underline underline-offset-4 hover:text-deep-forest">
                          Back to sign in
                        </button>
                      )}
                    </p>
                    <a href="/" className="inline-flex items-center gap-1.5 font-medium text-racing-green underline-offset-4 hover:underline">
                      <ArrowLeft size={14} strokeWidth={1.75} /> Back to the website
                    </a>
                  </>
                )}
              </div>
            </>
          )}
        </motion.div>
      </main>
    </div>
  );
}

function SentNotice({ kind, email, titleId, onBack }) {
  return (
    <div className="text-center">
      <CheckCircle2 size={30} strokeWidth={1.4} className="mx-auto text-antique-gold" aria-hidden="true" />
      <h1 id={titleId} className="mt-5 font-serif text-[2rem] leading-tight text-charcoal">
        Check your email
      </h1>
      <p className="mt-3 font-sans text-[15px] leading-relaxed text-warm-grey">
        {kind === "check-email"
          ? `We sent a confirmation link to ${email}. Confirm your address, then sign in.`
          : `If an account exists for ${email}, a password reset link is on its way.`}
      </p>
      <button type="button" onClick={onBack} className="mt-7 font-sans text-[12px] font-semibold tracking-[0.16em] text-racing-green uppercase underline underline-offset-4">
        Back to sign in
      </button>
    </div>
  );
}

function Label({ htmlFor, children, aside }) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3 lg:mb-[clamp(0.25rem,0.8vh,0.5rem)]">
      <label htmlFor={htmlFor} className="font-sans text-[13px] font-medium text-charcoal">
        {children}
      </label>
      {aside}
    </div>
  );
}

function FieldError({ id, message }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 font-sans text-[12px] leading-snug text-destructive">
      {message}
    </p>
  );
}

function Field({ id, label, icon: Icon, onChange, error, inputRef, ...props }) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Icon size={17} strokeWidth={1.6} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-antique-gold" aria-hidden="true" />
        <input
          ref={inputRef}
          id={id}
          name={id}
          onChange={onChange}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          {...props}
          className={`${FIELD} pr-4 ${error ? "border-destructive/50" : "border-antique-gold/30"}`}
        />
      </div>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

function PasswordField({ id, label, error, show, onToggle, inputRef, aside, onChange, ...props }) {
  return (
    <div>
      <Label htmlFor={id} aside={aside}>
        {label}
      </Label>
      <div className="relative">
        <Lock size={17} strokeWidth={1.6} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-antique-gold" aria-hidden="true" />
        <input
          ref={inputRef}
          id={id}
          name={id}
          type={show ? "text" : "password"}
          onChange={onChange}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          {...props}
          className={`${FIELD} pr-12 ${error ? "border-destructive/50" : "border-antique-gold/30"}`}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={show ? "Hide password" : "Show password"}
          aria-pressed={show}
          className="absolute top-1/2 right-2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-[8px] text-warm-grey transition-colors hover:bg-soft-cream hover:text-charcoal focus-visible:outline-2 focus-visible:outline-antique-gold"
        >
          {show ? <EyeOff size={17} strokeWidth={1.6} /> : <Eye size={17} strokeWidth={1.6} />}
        </button>
      </div>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}
