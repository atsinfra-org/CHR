import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Eye, EyeOff, Info, Loader2, X } from "lucide-react";
import { useAuthModal } from "../../context/AuthModalContext";
import { supabase, supabaseConfigured } from "../../lib/supabaseClient";
import { friendlyAuthError, normalizeEmail, validateAuthForm } from "../../lib/authValidation";
import { markActivity } from "../../lib/idleSession";
import { rememberCredential } from "../../lib/rememberCredential";

/** Where a customer lands after signing in or registering. */
export const POST_AUTH_PATH = "/store";

const COPY = {
  login: {
    label: "Welcome back",
    heading: "Continue Your Riding Journey",
    text: "Sign in to manage your membership and upcoming rides.",
    submit: "Sign in",
    busy: "Signing in…",
  },
  register: {
    label: "Become a member",
    heading: "Begin Your Riding Journey",
    text: "Create your account to manage your membership, book riding sessions, and follow your progress.",
    submit: "Create account",
    busy: "Creating account…",
  },
  forgot: {
    label: "Account recovery",
    heading: "Reset Your Password",
    text: "Enter your email and we'll send you a link to choose a new password.",
    submit: "Send reset link",
    busy: "Sending…",
  },
  reset: {
    label: "Account recovery",
    heading: "Choose a New Password",
    text: "Set a new password to continue to your account.",
    submit: "Set new password",
    busy: "Saving…",
  },
};

const MUTED = "#6b746e";
const LINE = "#dcd8cc";
const ERROR_INK = "#8a3a2e";

/**
 * Login / Register entrance. Presentation only: the Supabase calls
 * (signInWithPassword, signUp, resetPasswordForEmail, updateUser), the
 * PASSWORD_RECOVERY handling, the post-auth redirect and the identities
 * check for duplicate emails are the same as before. Client validation
 * (src/lib/authValidation.js) runs BEFORE any request, so a validation
 * failure can never leave the button in a loading state.
 */
export default function AuthModal() {
  const { isOpen, mode: requestedMode, closeAuth, openAuth } = useAuthModal();
  const [mode, setMode] = useState("login"); // login | register | forgot | reset
  const [fields, setFields] = useState({ fullName: "", email: "", password: "", confirm: "" });
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null); // { message, duplicate? }
  const [view, setView] = useState("form"); // form | check-email | reset-sent
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Remember me asks the browser/password manager to save the sign-in. It does not
  // extend the session and the password is never stored by this app.
  const [rememberMe, setRememberMe] = useState(false);
  const firstRef = useRef(null);
  const panelRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    if (isOpen) {
      setMode(requestedMode);
      setView("form");
      setFormError(null);
      setFieldErrors({});
      setSubmitting(false);
      setShowPassword(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // A password-recovery email link signs the user in with a recovery
  // session; surface the "choose a new password" form for it.
  useEffect(() => {
    if (!supabaseConfigured) return undefined;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") openAuth("reset");
    });
    return () => subscription.unsubscribe();
  }, [openAuth]);

  useEffect(() => {
    if (!isOpen) return undefined;
    document.body.style.overflow = "hidden";
    const id = requestAnimationFrame(() => firstRef.current?.focus());
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        closeAuth();
        return;
      }
      if (e.key === "Tab") {
        const focusable = panelRef.current?.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, mode, view, closeAuth]);

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

  const goToStore = () => window.location.assign(POST_AUTH_PATH);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);

    // 1. Validate first. Failing here never starts the loading state.
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

    // 2. Talk to Supabase; always leave the loading state, whatever happens.
    const email = normalizeEmail(fields.email);
    setSubmitting(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password: fields.password });
        if (error) return setFormError({ message: friendlyAuthError(error, "login") });
        markActivity();
        if (rememberMe) await rememberCredential({ email, password: fields.password, name: email });
        goToStore();
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
        goToStore();
        return;
      }

      if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/` });
        if (error) return setFormError({ message: friendlyAuthError(error, "forgot") });
        setView("reset-sent");
        return;
      }

      // mode === "reset": signed in via the recovery link
      const { error } = await supabase.auth.updateUser({ password: fields.password });
      if (error) return setFormError({ message: friendlyAuthError(error, "reset") });
      markActivity();
      goToStore();
    } catch {
      setFormError({ message: friendlyAuthError({ message: "network" }, mode) });
    } finally {
      setSubmitting(false);
    }
  };

  const copy = COPY[mode];
  const isTabbed = mode === "login" || mode === "register";
  const needsConfirm = mode === "register" || mode === "reset";

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          data-lenis-prevent
          className="fixed inset-0 z-[80] overflow-y-auto overscroll-contain"
        >
          <div className="fixed inset-0 bg-[rgba(4,25,18,0.72)] backdrop-blur-[6px]" aria-hidden="true" />

          {/* The wrapper covers the backdrop, so it handles outside clicks itself. */}
          <div
            className="relative flex min-h-full items-stretch justify-center sm:items-center sm:p-10"
            onMouseDown={(e) => e.target === e.currentTarget && closeAuth()}
          >
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.32, ease: [0.22, 0.61, 0.36, 1] }}
              className="relative flex w-full flex-col bg-warm-ivory shadow-[0_40px_100px_-30px_rgba(4,25,18,0.6)] sm:max-w-[680px] sm:rounded-[2px] lg:h-[min(700px,calc(100vh-80px))] lg:max-w-[1100px] lg:flex-row"
            >
              <button
                type="button"
                aria-label="Close"
                onClick={closeAuth}
                className="absolute top-2 right-2 z-20 flex h-11 w-11 items-center justify-center rounded-full bg-warm-ivory/90 text-racing-green/70 transition-colors duration-200 hover:bg-racing-green/10 hover:text-racing-green focus-visible:outline focus-visible:outline-2 focus-visible:outline-antique-gold lg:bg-transparent"
              >
                <X size={21} strokeWidth={1.5} />
              </button>

              <VisualPanel />

              <div className="flex-1 lg:overflow-y-auto">
                <div className="mx-auto w-full max-w-[460px] px-6 pt-8 pb-10 sm:px-10 lg:px-0 lg:py-10">
                  {view !== "form" ? (
                    <SentNotice kind={view} email={normalizeEmail(fields.email)} titleId={titleId} onBack={() => switchMode("login")} />
                  ) : (
                    <>
                      <header>
                        <p className="font-sans text-[10px] tracking-[0.34em] text-antique-gold uppercase">Welcome to</p>
                        <p className="mt-2 font-serif text-[1.05rem] leading-snug tracking-[0.2em] text-racing-green uppercase">
                          Colonel Horse Riding Club
                        </p>
                        <span className="mt-4 block h-px w-14 bg-antique-gold" aria-hidden="true" />
                      </header>

                      {isTabbed && (
                        <div className="relative mt-7 flex gap-8 border-b" style={{ borderColor: LINE }} role="tablist" aria-label="Sign in or create an account">
                          {[
                            ["login", "Sign in"],
                            ["register", "Create account"],
                          ].map(([m, label]) => (
                            <button
                              key={m}
                              type="button"
                              role="tab"
                              aria-selected={mode === m}
                              onClick={() => mode !== m && switchMode(m)}
                              className={`relative pb-3 font-sans text-[11px] tracking-[0.2em] uppercase transition-colors duration-200 ${
                                mode === m ? "font-semibold text-racing-green" : "text-[#6b746e] hover:text-racing-green"
                              }`}
                            >
                              {label}
                              {mode === m && (
                                <motion.span
                                  layoutId="auth-tab-underline"
                                  className="absolute right-0 -bottom-px left-0 h-[2px] bg-antique-gold"
                                  transition={{ duration: 0.25, ease: "easeOut" }}
                                />
                              )}
                            </button>
                          ))}
                        </div>
                      )}

                      <div className="mt-7">
                        <p className="font-sans text-[10px] tracking-[0.3em] uppercase" style={{ color: MUTED }}>
                          {copy.label}
                        </p>
                        <h2 id={titleId} className="mt-2 font-serif text-[1.85rem] leading-[1.1] text-charcoal">
                          {copy.heading}
                        </h2>
                        <p className="mt-2.5 font-sans text-[13.5px] leading-relaxed" style={{ color: MUTED }}>
                          {copy.text}
                        </p>
                      </div>

                      <form onSubmit={handleSubmit} noValidate className="mt-7 space-y-4">
                        {mode === "register" && (
                          <Field
                            id="auth-name"
                            label="Full name"
                            type="text"
                            autoComplete="name"
                            value={fields.fullName}
                            onChange={set("fullName")}
                            error={fieldErrors.fullName}
                            inputRef={firstRef}
                          />
                        )}
                        {mode !== "reset" && (
                          <Field
                            id="auth-email"
                            name="email"
                            label="Email address"
                            type="email"
                            inputMode="email"
                            autoComplete="username"
                            autoCapitalize="none"
                            spellCheck={false}
                            value={fields.email}
                            onChange={set("email")}
                            error={fieldErrors.email}
                            inputRef={mode === "register" ? undefined : firstRef}
                          />
                        )}

                        {mode !== "forgot" && (
                          <div className={needsConfirm ? "grid grid-cols-1 gap-4 sm:grid-cols-2" : ""}>
                            <PasswordField
                              id="auth-password"
                              name="password"
                              label={mode === "reset" ? "New password" : "Password"}
                              autoComplete={mode === "login" ? "current-password" : "new-password"}
                              value={fields.password}
                              onChange={set("password")}
                              error={fieldErrors.password}
                              show={showPassword}
                              onToggle={() => setShowPassword((s) => !s)}
                              inputRef={mode === "reset" ? firstRef : undefined}
                              aside={
                                mode === "login" ? (
                                  <button
                                    type="button"
                                    onClick={() => switchMode("forgot")}
                                    className="font-sans text-[11px] tracking-[0.08em] text-[#6b746e] underline-offset-4 transition-colors hover:text-racing-green hover:underline"
                                  >
                                    Forgot?
                                  </button>
                                ) : null
                              }
                            />
                            {needsConfirm && (
                              <PasswordField
                                id="auth-confirm"
                                label="Confirm password"
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
                          <label className="flex w-fit cursor-pointer items-center gap-2.5 font-sans text-[13px] text-[#6b746e]">
  <input type="checkbox" name="remember" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} className="h-4 w-4 accent-racing-green" />
  Remember me
</label>
                        )}

                        {formError && (
                          <div
                            role="alert"
                            className="flex items-start gap-2.5 rounded-[2px] border px-3.5 py-3"
                            style={{ borderColor: "#e6cfc9", background: "#fbf4f2", color: ERROR_INK }}
                          >
                            <Info size={16} strokeWidth={1.6} className="mt-0.5 shrink-0" />
                            <p className="font-sans text-[13px] leading-relaxed">
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
                          disabled={submitting}
                          aria-busy={submitting}
                          className="flex h-[54px] w-full items-center justify-center gap-2.5 rounded-[2px] bg-racing-green font-sans text-[12px] font-semibold tracking-[0.16em] text-warm-ivory uppercase transition-all duration-200 hover:-translate-y-px hover:bg-[#1c4a39] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-antique-gold disabled:translate-y-0 disabled:cursor-wait disabled:opacity-80"
                        >
                          {submitting && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
                          {submitting ? copy.busy : copy.submit}
                        </button>
                      </form>

                      <p className="mt-6 text-center font-sans text-[13px]" style={{ color: MUTED }}>
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
                        {mode === "forgot" && (
                          <button type="button" onClick={() => switchMode("login")} className="font-medium text-racing-green underline underline-offset-4 hover:text-deep-forest">
                            Back to sign in
                          </button>
                        )}
                      </p>
                    </>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The existing hero photograph with a restrained deep-green treatment. */
function VisualPanel() {
  return (
    <aside className="relative h-32 shrink-0 overflow-hidden bg-deep-forest md:h-44 lg:h-auto lg:w-[40%]" aria-hidden="true">
      <img
        src="/assests/Golden%20Dressage%20in%20Sunlit%20Arena.png"
        alt=""
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover object-[50%_27%] lg:object-[40%_58%]"
      />
      <div className="absolute inset-0 bg-deep-forest/10" />
      <div className="absolute inset-0 bg-gradient-to-t from-[rgba(4,25,18,0.88)] via-[rgba(4,25,18,0.12)] to-[rgba(4,25,18,0.42)]" />
      <div className="absolute inset-0 shadow-[inset_0_0_120px_rgba(4,25,18,0.55)]" />

      <img src="/assests/ecl-gold.png" alt="" className="absolute top-5 left-5 hidden h-10 w-auto opacity-90 lg:block" />

      <div className="absolute inset-x-0 bottom-0 hidden p-8 lg:block xl:p-10">
        <p className="font-sans text-[10px] tracking-[0.34em] text-antique-gold uppercase [font-variant-numeric:lining-nums]">Est. 2026</p>
        <span className="my-4 block h-px w-12 bg-antique-gold/80" />
        <p className="font-serif text-[2.1rem] leading-[1.05] tracking-[0.04em] text-warm-ivory">
          The Art
          <br />
          of Riding
        </p>
        <p className="mt-4 font-sans text-[11px] tracking-[0.22em] text-warm-ivory/70 uppercase">Colonel Horse Riding Club</p>
      </div>
      <p className="absolute bottom-3 left-5 font-sans text-[9.5px] tracking-[0.3em] text-warm-ivory/85 uppercase [font-variant-numeric:lining-nums] lg:hidden">
        Est. 2026 · The Art of Riding
      </p>
    </aside>
  );
}

function SentNotice({ kind, email, titleId, onBack }) {
  return (
    <div className="py-6 text-center">
      <CheckCircle2 size={30} strokeWidth={1.4} className="mx-auto text-antique-gold" aria-hidden="true" />
      <h2 id={titleId} className="mt-5 font-serif text-[1.7rem] leading-tight text-charcoal">
        Check your email
      </h2>
      <p className="mt-3 font-sans text-[13.5px] leading-relaxed" style={{ color: MUTED }}>
        {kind === "check-email"
          ? `We sent a confirmation link to ${email}. Confirm your address, then sign in to enter the store.`
          : `If an account exists for ${email}, a password reset link is on its way.`}
      </p>
      <button type="button" onClick={onBack} className="mt-7 font-sans text-[11px] tracking-[0.18em] text-racing-green uppercase underline underline-offset-4">
        Back to sign in
      </button>
    </div>
  );
}

const inputClass =
  "block h-[46px] w-full rounded-[2px] border bg-[#fbf9f3] px-3.5 font-sans text-[14px] text-charcoal outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-[#6b746e]/60 focus:border-antique-gold focus:shadow-[0_0_0_3px_rgba(198,161,91,0.16)]";

function Label({ htmlFor, children, aside }) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3">
      <label htmlFor={htmlFor} className="font-sans text-[11px] tracking-[0.18em] uppercase" style={{ color: MUTED }}>
        {children}
      </label>
      {aside}
    </div>
  );
}

function FieldError({ id, message }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 font-sans text-[12px] leading-snug" style={{ color: ERROR_INK }}>
      {message}
    </p>
  );
}

function Field({ id, label, onChange, error, inputRef, ...props }) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <input
        ref={inputRef}
        id={id}
        name={id}
        onChange={onChange}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...props}
        className={inputClass}
        style={{ borderColor: error ? "#cfa79f" : LINE }}
      />
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
        <input
          ref={inputRef}
          id={id}
          name={id}
          type={show ? "text" : "password"}
          onChange={onChange}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          {...props}
          className={`${inputClass} pr-11`}
          style={{ borderColor: error ? "#cfa79f" : LINE }}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={show ? "Hide password" : "Show password"}
          aria-pressed={show}
          className="absolute top-1/2 right-1 flex h-9 w-9 -translate-y-1/2 items-center justify-center text-[#6b746e] transition-colors hover:text-racing-green focus-visible:outline focus-visible:outline-2 focus-visible:outline-antique-gold"
        >
          {show ? <EyeOff size={17} strokeWidth={1.5} /> : <Eye size={17} strokeWidth={1.5} />}
        </button>
      </div>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}
