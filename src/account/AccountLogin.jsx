import { useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import GoldDivider from "../components/ui/GoldDivider";
import { markActivity } from "../lib/idleSession";
import { rememberCredential } from "../lib/rememberCredential";

/**
 * Combined login/registration for members. Registration intentionally only
 * collects email/password/full name — exactly what handle_new_user() (the
 * DB trigger) already turns into a profiles row automatically. phone and
 * date_of_birth are asked for afterward, on the dashboard, once a real
 * session exists — see AccountDashboard's "complete your profile" prompt.
 * That sidesteps a real edge case: if this Supabase project has email
 * confirmation enabled, signUp() returns no session at all until the user
 * confirms, so there'd be no authenticated request available yet to attach
 * those extra fields to.
 */
export default function AccountLogin() {
  const [mode, setMode] = useState("login"); // login | register
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  // Browser/password-manager convenience only — not a persistent login.
  const [rememberMe, setRememberMe] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | submitting | error | check-email
  const [errorMessage, setErrorMessage] = useState("");

  const switchMode = (next) => {
    setMode(next);
    setStatus("idle");
    setErrorMessage("");
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setStatus("submitting");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setStatus("error");
      setErrorMessage(friendlyAuthError(error));
      return;
    }
    markActivity();
    if (rememberMe) await rememberCredential({ email: email.trim(), password, name: email.trim() });
    // AuthProvider's onAuthStateChange picks this up and flips the view.
    setStatus("idle");
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setStatus("submitting");

    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { full_name: fullName.trim() || null } },
    });

    if (error) {
      setStatus("error");
      setErrorMessage(friendlyAuthError(error));
      return;
    }

    // Supabase's signUp against an email that's already registered often
    // returns success with no error and an empty `identities` array, rather
    // than a real error — handle that explicitly instead of showing a false
    // "check your email".
    if (data.user && data.user.identities && data.user.identities.length === 0) {
      setStatus("error");
      setErrorMessage("This email is already registered — try signing in instead.");
      return;
    }

    if (!data.session) {
      // Email confirmation is required by this project's Auth settings —
      // handle_new_user() has already created the profiles row regardless
      // (it fires on the auth.users insert, not on confirmation), but there
      // is no session to act on yet.
      setStatus("check-email");
      return;
    }

    setStatus("idle");
  };

  if (status === "check-email") {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center px-6 py-16 text-center">
        <CheckCircle2 size={28} strokeWidth={1.5} className="mx-auto text-antique-gold" />
        <h1 className="mt-5 font-serif text-2xl text-charcoal">Check Your Email</h1>
        <p className="mt-3 font-sans text-sm leading-relaxed text-warm-grey">
          We&apos;ve sent a confirmation link to <span className="text-charcoal">{email}</span>. Confirm your
          address, then sign in below.
        </p>
        <button
          type="button"
          onClick={() => switchMode("login")}
          className="mt-8 font-sans text-xs tracking-[0.14em] text-racing-green uppercase underline underline-offset-4"
        >
          Back to Sign In
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center px-6 py-16">
      <span className="font-sans text-xs tracking-[0.32em] text-antique-gold uppercase">
        {mode === "login" ? "Member Access" : "Create Account"}
      </span>
      <h1 className="mt-3 font-serif text-3xl text-charcoal">{mode === "login" ? "Sign In" : "Register"}</h1>
      <GoldDivider className="my-6" width="w-12" />

      <form onSubmit={mode === "login" ? handleLogin : handleRegister} className="space-y-5">
        {mode === "register" && (
          <Field label="Full Name" id="account-name" type="text" autoComplete="name" value={fullName} onChange={setFullName} />
        )}

        <Field label="Email" id="account-email" name="email" type="email" autoComplete="username" required value={email} onChange={setEmail} />

        <Field
          label="Password"
          id="account-password"
          name="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
          minLength={6}
          value={password}
          onChange={setPassword}
        />

        {mode === "login" && (
          <label className="flex w-fit cursor-pointer items-center gap-2.5 font-sans text-xs text-warm-grey">
  <input type="checkbox" name="remember" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} className="h-4 w-4 accent-racing-green" />
  Remember me
</label>
        )}

        {status === "error" && (
          <div className="flex items-start gap-2.5 border border-destructive/30 bg-destructive/5 px-4 py-3">
            <AlertCircle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-destructive" />
            <p className="font-sans text-xs leading-relaxed text-destructive">{errorMessage}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={status === "submitting"}
          className="w-full bg-racing-green px-8 py-4 font-sans text-xs tracking-[0.22em] text-warm-ivory uppercase transition-colors duration-300 hover:bg-deep-forest disabled:opacity-60"
        >
          {status === "submitting" ? "Please Wait…" : mode === "login" ? "Sign In" : "Create Account"}
        </button>
      </form>

      <button
        type="button"
        onClick={() => switchMode(mode === "login" ? "register" : "login")}
        className="mt-8 font-sans text-xs text-warm-grey underline underline-offset-4 transition-colors hover:text-charcoal"
      >
        {mode === "login" ? "New here? Create an account" : "Already have an account? Sign in"}
      </button>
    </div>
  );
}

function Field({ label, id, onChange, ...inputProps }) {
  return (
    <div>
      <label htmlFor={id} className="font-sans text-xs tracking-[0.14em] text-charcoal/70 uppercase">
        {label}
      </label>
      <input
        id={id}
        name={id}
        onChange={(e) => onChange(e.target.value)}
        {...inputProps}
        className="mt-2 w-full border border-charcoal/15 bg-white px-4 py-3 font-sans text-sm text-charcoal outline-none transition-colors duration-300 focus:border-antique-gold"
      />
    </div>
  );
}

function friendlyAuthError(error) {
  const msg = error?.message ?? "";
  if (/invalid login credentials/i.test(msg)) return "Incorrect email or password.";
  if (/already registered/i.test(msg)) return "This email is already registered — try signing in instead.";
  if (/password should be at least/i.test(msg)) return msg;
  if (/rate limit/i.test(msg)) return "Too many attempts — please wait a moment and try again.";
  if (/failed to fetch/i.test(msg) || /network/i.test(msg)) return "Network error — please check your connection and try again.";
  return msg || "Something went wrong. Please try again.";
}
