import { useCallback, useEffect, useState } from "react";
import { AlertCircle, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import GoldDivider from "../components/ui/GoldDivider";
import AccountStateGuard from "./AccountStateGuard";
import { useMembershipStatus } from "./useMembershipStatus";
import { formatDate } from "./dashboardUtils";
import RazorpayPaymentFlow from "./purchase/RazorpayPaymentFlow";

/**
 * Phase 4.3 — membership selection & purchase preparation.
 * Phase 4.4 — the actual Razorpay payment step, via RazorpayPaymentFlow.
 *
 * This page still performs ZERO age/eligibility/price computation —
 * public.eligible_membership_plan() and initiate_membership_purchase() are
 * the only sources for those values. It also never marks a payment
 * successful or a membership active itself: RazorpayPaymentFlow only ever
 * reports what the server (razorpay-verify-payment / the webhook) decided.
 */
export default function MembershipPurchase() {
  return (
    <AccountStateGuard active="membership">
      {({ user, profile }) => <Purchase user={user} profile={profile} />}
    </AccountStateGuard>
  );
}

function Purchase({ user, profile }) {
  const membership = useMembershipStatus(user?.id);

  if (membership.status === "loading" || membership.status === "idle") {
    return (
      <PageShell>
        <p className="font-sans text-sm text-warm-grey">Checking your membership…</p>
      </PageShell>
    );
  }

  if (membership.status === "error") {
    return (
      <PageShell>
        <ErrorBox message={membership.error} onRetry={membership.retry} />
      </PageShell>
    );
  }

  if (membership.kind === "active") {
    const m = membership.record;
    return (
      <PageShell>
        <div className="flex items-center gap-2 text-racing-green">
          <ShieldCheck size={18} strokeWidth={1.75} />
          <span className="font-sans text-xs tracking-[0.14em] uppercase">Already Active</span>
        </div>
        <h1 className="mt-3 font-serif text-2xl text-charcoal">You already have an active membership</h1>
        <p className="mt-3 font-sans text-sm leading-relaxed text-warm-grey">
          Your {membership.plan?.name ?? "membership"} is valid until {formatDate(m.end_date) ?? "—"}. A new
          membership can be purchased once this one ends.
        </p>
        <a
          href="/account"
          className="mt-8 inline-flex items-center gap-2 bg-racing-green px-6 py-3 font-sans text-xs tracking-[0.16em] text-warm-ivory uppercase transition-colors hover:bg-deep-forest"
        >
          Back to Dashboard
        </a>
      </PageShell>
    );
  }

  if (membership.kind === "pending") {
    return (
      <PageShell>
        <PendingPurchasePayment membershipId={membership.record.id} plan={membership.plan} profile={profile} onActivated={membership.retry} />
      </PageShell>
    );
  }

  // kind === "none" or "lapsed" — eligible to purchase
  return (
    <PageShell>
      <EligibilityAndPurchase profile={profile} onActivated={membership.retry} />
    </PageShell>
  );
}

/** Resumes an already-initiated (Phase 4.3) purchase — fetches the
 * associated payment row (RLS-scoped to the caller's own row) so
 * RazorpayPaymentFlow has a payment_id to work with. */
function PendingPurchasePayment({ membershipId, plan, profile, onActivated }) {
  const [payment, setPayment] = useState({ status: "loading", error: null, data: null });

  const load = useCallback(async () => {
    setPayment({ status: "loading", error: null, data: null });
    const { data, error } = await supabase
      .from("payments")
      .select("id, status")
      .eq("membership_id", membershipId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      setPayment({ status: "error", error: error.message, data: null });
      return;
    }
    setPayment({ status: "ready", error: null, data });
  }, [membershipId]);

  useEffect(() => {
    load();
  }, [load]);

  if (payment.status === "loading" || payment.status === "idle") {
    return <p className="font-sans text-sm text-warm-grey">Loading your purchase…</p>;
  }
  if (payment.status === "error") {
    return <ErrorBox message={payment.error} onRetry={load} />;
  }
  if (!payment.data) {
    return (
      <div>
        <h1 className="font-serif text-2xl text-charcoal">Purchase record not found</h1>
        <p className="mt-3 font-sans text-sm leading-relaxed text-warm-grey">
          We couldn&apos;t find the payment for this pending membership. Please contact Colonel Horse Riding.
        </p>
      </div>
    );
  }

  return (
    <div>
      <span className="font-sans text-xs tracking-[0.32em] text-antique-gold uppercase">Complete Your Purchase</span>
      <h1 className="mt-3 font-serif text-3xl text-charcoal">{plan?.name}</h1>
      <GoldDivider className="my-6" width="w-12" />

      <PlanSummary plan={{ ...plan, amount: plan?.price }} />

      <div className="mt-6">
        <RazorpayPaymentFlow paymentId={payment.data.id} plan={{ ...plan, amount: plan?.price }} profile={profile} onActivated={onActivated} />
      </div>
    </div>
  );
}

function EligibilityAndPurchase({ profile, onActivated }) {
  const [eligibility, setEligibility] = useState({ status: "idle", error: null, data: null });
  const [purchase, setPurchase] = useState({ status: "idle", error: null, result: null });

  const loadEligibility = useCallback(async () => {
    setEligibility({ status: "loading", error: null, data: null });
    const { data, error } = await supabase.rpc("eligible_membership_plan");
    if (error) {
      setEligibility({ status: "error", error: error.message, data: null });
      return;
    }
    setEligibility({ status: "ready", error: null, data: data?.[0] ?? null });
  }, []);

  useEffect(() => {
    loadEligibility();
  }, [loadEligibility]);

  const handleInitiate = async () => {
    if (!eligibility.data?.plan_id) return;
    setPurchase({ status: "submitting", error: null, result: null });
    const { data, error } = await supabase.rpc("initiate_membership_purchase", { p_plan_id: eligibility.data.plan_id });
    if (error) {
      setPurchase({ status: "error", error, result: null });
      return;
    }
    setPurchase({ status: "ready-to-pay", error: null, result: data?.[0] ?? null });
  };

  if (purchase.status === "ready-to-pay" && purchase.result) {
    const r = purchase.result;
    return (
      <div>
        <span className="font-sans text-xs tracking-[0.32em] text-antique-gold uppercase">Membership</span>
        <h1 className="mt-3 font-serif text-3xl text-charcoal">{r.plan_name}</h1>
        <GoldDivider className="my-6" width="w-12" />
        <PlanSummary plan={r} />
        <div className="mt-6">
          <RazorpayPaymentFlow paymentId={r.payment_id} plan={r} profile={profile} onActivated={onActivated} />
        </div>
      </div>
    );
  }

  if (eligibility.status === "loading" || eligibility.status === "idle") {
    return <p className="font-sans text-sm text-warm-grey">Checking your membership eligibility…</p>;
  }

  if (eligibility.status === "error") {
    return <ErrorBox message={eligibility.error} onRetry={loadEligibility} />;
  }

  const elig = eligibility.data;

  if (!elig || elig.dob_missing) {
    return <ProfileIncompleteNotice reason="missing" />;
  }

  if (elig.dob_invalid) {
    return <ProfileIncompleteNotice reason="invalid" />;
  }

  if (!elig.plan_id) {
    return (
      <div>
        <span className="font-sans text-xs tracking-[0.32em] text-antique-gold uppercase">Membership</span>
        <h1 className="mt-3 font-serif text-2xl text-charcoal">No plan available for your age</h1>
        <p className="mt-3 font-sans text-sm leading-relaxed text-warm-grey">
          We don&apos;t currently have a membership plan configured for your age ({elig.age}). Please contact
          Colonel Horse Riding directly.
        </p>
      </div>
    );
  }

  return (
    <div>
      <span className="font-sans text-xs tracking-[0.32em] text-antique-gold uppercase">Membership</span>
      <h1 className="mt-3 font-serif text-3xl text-charcoal">{elig.plan_name}</h1>
      {elig.plan_description && <p className="mt-2 font-sans text-sm text-warm-grey">{elig.plan_description}</p>}
      <GoldDivider className="my-6" width="w-12" />

      <PlanSummary plan={elig} showAge />

      <div className="mt-6 border border-charcoal/10 bg-white p-6 sm:p-8">
        <p className="font-sans text-xs tracking-[0.14em] text-warm-grey uppercase">Member Details Used</p>
        <dl className="mt-3 space-y-2">
          <Row label="Name" value={profile.full_name} />
          <Row label="Date of Birth" value={formatDate(profile.date_of_birth)} />
        </dl>
      </div>

      {purchase.status === "error" && <PurchaseError error={purchase.error} onRetry={handleInitiate} />}

      <button
        type="button"
        onClick={handleInitiate}
        disabled={purchase.status === "submitting"}
        className="mt-8 flex w-full items-center justify-center gap-2.5 bg-racing-green px-8 py-4 font-sans text-xs tracking-[0.22em] text-warm-ivory uppercase transition-colors duration-300 hover:bg-deep-forest disabled:opacity-60 sm:w-auto"
      >
        {purchase.status === "submitting" ? "Preparing…" : `Continue to Payment — ${formatCurrency(elig.amount, elig.currency)}`}
      </button>
      <p className="mt-3 font-sans text-xs text-warm-grey">
        You&apos;ll pay securely via Razorpay on the next step. No amount is charged until you complete payment.
      </p>
    </div>
  );
}

function PlanSummary({ plan, showAge }) {
  return (
    <div className={`grid grid-cols-2 gap-6 border border-charcoal/10 bg-white p-6 sm:p-8 ${showAge ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
      <Stat label="Price" value={formatCurrency(plan.amount, plan.currency)} />
      <Stat label="Class Credits" value={plan.class_credits} />
      <Stat label="Validity" value={`${plan.validity_days} days`} />
      {showAge && <Stat label="Your Age" value={plan.age} />}
    </div>
  );
}

function ProfileIncompleteNotice({ reason }) {
  return (
    <div>
      <span className="font-sans text-xs tracking-[0.32em] text-antique-gold uppercase">Membership</span>
      <h1 className="mt-3 font-serif text-2xl text-charcoal">Complete your profile to continue</h1>
      <p className="mt-3 max-w-lg font-sans text-sm leading-relaxed text-warm-grey">
        {reason === "invalid"
          ? "The date of birth on your profile doesn't look valid. Please correct it before purchasing a membership — pricing and eligibility depend on it."
          : "Add your date of birth to your profile before purchasing a membership — it determines which plan and price apply to you."}
      </p>
      <a
        href="/account#profile"
        className="mt-8 inline-flex items-center gap-2 bg-racing-green px-6 py-3 font-sans text-xs tracking-[0.16em] text-warm-ivory uppercase transition-colors hover:bg-deep-forest"
      >
        Go to Profile
      </a>
    </div>
  );
}

function PurchaseError({ error, onRetry }) {
  const code = error?.message;
  const detail = error?.details;

  const friendly = {
    DATE_OF_BIRTH_REQUIRED: "Add your date of birth to your profile before purchasing.",
    INVALID_DATE_OF_BIRTH: "The date of birth on your profile isn't valid.",
    PLAN_NOT_FOUND: "This plan is no longer available. Please refresh the page.",
    PLAN_AGE_INELIGIBLE: "This plan is not available for your age.",
    ACTIVE_MEMBERSHIP_EXISTS: "You already have an active membership.",
    "Not authenticated": "Your session has expired — please sign in again.",
  }[code];

  return (
    <div className="mt-6 flex items-start gap-2.5 border border-destructive/30 bg-destructive/5 px-4 py-3">
      <AlertCircle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-destructive" />
      <div className="flex-1">
        <p className="font-sans text-xs leading-relaxed text-destructive">
          {friendly || detail || "Something went wrong. Please try again."}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 flex items-center gap-1.5 font-sans text-[11px] tracking-[0.12em] text-destructive uppercase underline underline-offset-4"
        >
          <RefreshCw size={12} strokeWidth={1.75} />
          Try Again
        </button>
      </div>
    </div>
  );
}

function ErrorBox({ message, onRetry }) {
  return (
    <div className="flex items-start gap-2.5 border border-destructive/30 bg-destructive/5 px-4 py-3">
      <AlertCircle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-destructive" />
      <div className="flex-1">
        <p className="font-sans text-xs leading-relaxed text-destructive">Couldn&apos;t load this. {message ? `(${message})` : ""}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 flex items-center gap-1.5 font-sans text-[11px] tracking-[0.12em] text-destructive uppercase underline underline-offset-4"
        >
          <RefreshCw size={12} strokeWidth={1.75} />
          Retry
        </button>
      </div>
    </div>
  );
}

function PageShell({ children }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10 md:px-10 md:py-14">
      <div className="mb-8 flex items-center gap-2 text-warm-grey">
        <Sparkles size={14} strokeWidth={1.75} className="text-antique-gold" />
        <a href="/account" className="font-sans text-xs tracking-[0.14em] uppercase hover:text-charcoal">
          Dashboard
        </a>
        <span aria-hidden="true">/</span>
        <span className="font-sans text-xs tracking-[0.14em] uppercase text-charcoal">Membership</span>
      </div>
      {children}
    </main>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <p className="font-sans text-[11px] tracking-[0.14em] text-warm-grey uppercase">{label}</p>
      <p className="mt-1.5 font-serif text-xl text-charcoal">{value ?? "—"}</p>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="font-sans text-xs tracking-[0.14em] text-warm-grey uppercase">{label}</dt>
      <dd className="font-sans text-sm text-charcoal">{value || "—"}</dd>
    </div>
  );
}

function formatCurrency(amount, currency) {
  if (amount == null) return "—";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency ?? ""} ${amount}`.trim();
  }
}
