import { useState } from "react";
import { AlertCircle } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import GoldDivider from "../components/ui/GoldDivider";

export default function AdminLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("idle"); // idle | submitting | error
  const [errorMessage, setErrorMessage] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus("submitting");
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      setStatus("error");
      setErrorMessage(error.message);
      return;
    }
    // A successful sign-in flips `session` via onAuthStateChange in AdminApp.
    setStatus("idle");
  };

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center px-6 py-16">
      <span className="font-sans text-xs tracking-[0.32em] text-antique-gold uppercase">Admin Access</span>
      <h1 className="mt-3 font-serif text-3xl text-charcoal">Sign In</h1>
      <GoldDivider className="my-6" width="w-12" />

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="admin-email" className="font-sans text-xs tracking-[0.14em] text-charcoal/70 uppercase">
            Email
          </label>
          <input
            id="admin-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-2 w-full border border-charcoal/15 bg-white px-4 py-3 font-sans text-sm text-charcoal outline-none transition-colors duration-300 focus:border-antique-gold"
          />
        </div>

        <div>
          <label htmlFor="admin-password" className="font-sans text-xs tracking-[0.14em] text-charcoal/70 uppercase">
            Password
          </label>
          <input
            id="admin-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-2 w-full border border-charcoal/15 bg-white px-4 py-3 font-sans text-sm text-charcoal outline-none transition-colors duration-300 focus:border-antique-gold"
          />
        </div>

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
          {status === "submitting" ? "Signing In…" : "Sign In"}
        </button>
      </form>

      <p className="mt-8 font-sans text-xs leading-relaxed text-warm-grey">
        Admin accounts are created directly in the Supabase dashboard (Authentication → Users) — there is no
        public sign-up here by design.
      </p>
    </div>
  );
}
