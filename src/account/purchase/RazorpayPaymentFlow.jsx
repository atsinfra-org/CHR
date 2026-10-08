import { useState } from "react";
import { AlertCircle, CheckCircle2, Hourglass, RefreshCw, XCircle } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { callPaymentFunction, loadRazorpayCheckout } from "../razorpay";

/**
 * The actual Razorpay Checkout integration (Phase 4.4) — shared by both a
 * brand-new purchase and resuming an existing pending one, so there is
 * exactly one implementation of this flow.
 *
 * The browser is never the authority for anything here:
 *  - the order is created server-side (razorpay-create-order), which is
 *    also the only place the authoritative amount ever comes from;
 *  - the Checkout `handler` result is sent to razorpay-verify-payment,
 *    which independently re-verifies the signature and re-fetches the
 *    payment from Razorpay's own API before calling the one function that
 *    can ever activate a membership;
 *  - even if this whole flow never completes (closed tab, dead network),
 *    the async webhook resolves the same payment independently — refreshing
 *    the dashboard, or clicking "Check Status" below, shows the outcome
 *    once it has.
 *
 * This component never marks anything "successful" on its own — every
 * transition to the success state comes from a server response.
 */
export default function RazorpayPaymentFlow({
  paymentId,
  plan,
  profile,
  onActivated,
  successTitle = "Membership Active",
  successMessage,
  successHref = "/account",
  successLabel = "Go to Dashboard",
}) {
  const [phase, setPhase] = useState("ready");
  // ready | creating_order | awaiting_checkout | verifying | success |
  // pending | failed | cancelled | error
  const [errorMessage, setErrorMessage] = useState("");

  const startCheckout = async () => {
    setPhase("creating_order");
    setErrorMessage("");

    let order;
    try {
      order = await callPaymentFunction("razorpay-create-order", { payment_id: paymentId });
    } catch (err) {
      setPhase("error");
      setErrorMessage(friendlyError(err));
      return;
    }

    try {
      await loadRazorpayCheckout();
    } catch (err) {
      setPhase("error");
      setErrorMessage(err.message);
      return;
    }

    setPhase("awaiting_checkout");

    const rzp = new window.Razorpay({
      key: order.key_id,
      order_id: order.order_id, // server-created — the browser never supplies this
      amount: order.amount,
      currency: order.currency,
      name: "Colonel Horse Riding",
      description: plan?.plan_name ?? plan?.name,
      prefill: {
        name: profile?.full_name || undefined,
        email: profile?.email || undefined,
        contact: profile?.phone || undefined,
      },
      theme: { color: "#12372a" },
      modal: {
        ondismiss: () => {
          // Only downgrade to "cancelled" if nothing has moved past this
          // point yet (avoids clobbering a 'verifying'/'success' state if
          // Razorpay fires ondismiss after handler in some edge case).
          setPhase((p) => (p === "awaiting_checkout" ? "cancelled" : p));
        },
      },
      handler: async (response) => {
        setPhase("verifying");
        try {
          const result = await callPaymentFunction("razorpay-verify-payment", {
            payment_id: paymentId,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          });

          if (result.status === "success") {
            setPhase("success");
            onActivated?.();
          } else if (result.status === "failed") {
            setPhase("failed");
          } else {
            setPhase("pending");
          }
        } catch (err) {
          setPhase("error");
          setErrorMessage(friendlyError(err));
        }
      },
    });

    rzp.on("payment.failed", () => {
      // Razorpay's own client-side failure event (e.g. card declined
      // immediately) — UI feedback only. Nothing is written to the
      // database from this; the payment's real status is still only ever
      // set by the server (webhook or razorpay-verify-payment).
      setPhase((p) => (p === "awaiting_checkout" ? "failed" : p));
    });

    rzp.open();
  };

  const checkStatus = async () => {
    setPhase("verifying");
    const { data, error } = await supabase.from("payments").select("status").eq("id", paymentId).maybeSingle();
    if (error || !data) {
      setPhase("pending");
      return;
    }
    if (data.status === "success") {
      setPhase("success");
      onActivated?.();
    } else if (data.status === "failed") {
      setPhase("failed");
    } else {
      setPhase("pending");
    }
  };

  if (phase === "success") {
    return (
      <StatusCard icon={CheckCircle2} tone="text-racing-green" title={successTitle}>
        <p className="font-sans text-sm leading-relaxed text-warm-grey">
          {successMessage ??
            `Payment confirmed — your ${plan?.plan_name ?? plan?.name} membership is now active with ${plan?.class_credits} class credits.`}
        </p>
        <a
          href={successHref}
          className="mt-6 inline-flex items-center gap-2 bg-racing-green px-6 py-3 font-sans text-xs tracking-[0.16em] text-warm-ivory uppercase transition-colors hover:bg-deep-forest"
        >
          {successLabel}
        </a>
      </StatusCard>
    );
  }

  if (phase === "pending") {
    return (
      <StatusCard icon={Hourglass} tone="text-antique-gold" title="Confirming Payment">
        <p className="font-sans text-sm leading-relaxed text-warm-grey">
          Razorpay is still confirming this payment. This is usually quick — it will complete automatically once
          confirmed. You can safely close this page and check back later, or check now.
        </p>
        <RetryButton onClick={checkStatus} label="Check Status" />
      </StatusCard>
    );
  }

  if (phase === "failed") {
    return (
      <StatusCard icon={XCircle} tone="text-destructive" title="Payment Failed">
        <p className="font-sans text-sm leading-relaxed text-warm-grey">
          The payment didn&apos;t go through. No amount was captured. You can try again.
        </p>
        <RetryButton onClick={() => setPhase("ready")} label="Try Again" />
      </StatusCard>
    );
  }

  if (phase === "cancelled") {
    return (
      <StatusCard icon={XCircle} tone="text-warm-grey" title="Payment Cancelled">
        <p className="font-sans text-sm leading-relaxed text-warm-grey">You closed the payment window before completing it. No amount was charged.</p>
        <RetryButton onClick={() => setPhase("ready")} label="Try Again" />
      </StatusCard>
    );
  }

  if (phase === "error") {
    return (
      <div className="mt-6 flex items-start gap-2.5 border border-destructive/30 bg-destructive/5 px-4 py-3">
        <AlertCircle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-destructive" />
        <div className="flex-1">
          <p className="font-sans text-xs leading-relaxed text-destructive">{errorMessage}</p>
          <button
            type="button"
            onClick={() => setPhase("ready")}
            className="mt-2 flex items-center gap-1.5 font-sans text-[11px] tracking-[0.12em] text-destructive uppercase underline underline-offset-4"
          >
            <RefreshCw size={12} strokeWidth={1.75} />
            Try Again
          </button>
        </div>
      </div>
    );
  }

  const busy = phase === "creating_order" || phase === "awaiting_checkout" || phase === "verifying";
  const busyLabel = {
    creating_order: "Preparing payment…",
    awaiting_checkout: "Waiting for payment…",
    verifying: "Verifying payment…",
  }[phase];

  return (
    <div>
      <button
        type="button"
        onClick={startCheckout}
        disabled={busy}
        className="flex w-full items-center justify-center gap-2.5 bg-racing-green px-8 py-4 font-sans text-xs tracking-[0.22em] text-warm-ivory uppercase transition-colors duration-300 hover:bg-deep-forest disabled:opacity-60 sm:w-auto"
      >
        {busyLabel || `Pay — ${formatCurrency(plan?.amount ?? plan?.price, plan?.currency)}`}
      </button>
      <p className="mt-3 font-sans text-xs text-warm-grey">
        You&apos;ll be taken to Razorpay&apos;s secure payment window. Memberships activate automatically once
        payment is confirmed by our server.
      </p>
    </div>
  );
}

function StatusCard({ icon: Icon, tone, title, children }) {
  return (
    <div className="border border-charcoal/10 bg-white p-6 sm:p-8">
      <div className={`flex items-center gap-2 ${tone}`}>
        <Icon size={18} strokeWidth={1.75} />
        <span className="font-sans text-xs tracking-[0.14em] uppercase">{title}</span>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function RetryButton({ onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-5 flex items-center gap-2 border border-charcoal/15 px-5 py-2.5 font-sans text-xs tracking-[0.14em] text-charcoal uppercase transition-colors hover:border-antique-gold"
    >
      <RefreshCw size={14} strokeWidth={1.75} />
      {label}
    </button>
  );
}

function friendlyError(err) {
  const known = {
    PAYMENT_NOT_FOUND: "This purchase couldn't be found. Please refresh the page.",
    WRONG_GATEWAY: "This purchase isn't set up for card/UPI payment.",
    PAYMENT_NOT_PENDING: "This purchase has already been processed.",
    MEMBERSHIP_NOT_ELIGIBLE: "This membership is no longer eligible for payment.",
    ORDER_NOT_ELIGIBLE: "This order can no longer be paid. Please start a new one.",
    ORDER_CREATION_FAILED: "Couldn't start the payment. Please try again in a moment.",
    ORDER_ID_MISMATCH: "Something looked off with this payment session. Please refresh and try again.",
    INVALID_SIGNATURE: "We couldn't verify this payment. Please try again or contact support.",
    "Not authenticated": "Your session has expired — please sign in again.",
  }[err.code];
  return known || err.message || "Something went wrong. Please try again.";
}

function formatCurrency(amount, currency) {
  if (amount == null) return "";
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
