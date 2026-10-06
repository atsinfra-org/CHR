import { supabase } from "../lib/supabaseClient";

const CHECKOUT_SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
let checkoutScriptPromise = null;

/** Loads Razorpay's Checkout script once, lazily — only when a member
 * actually reaches the payment step, not on every page of the app. */
export function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve();
  if (checkoutScriptPromise) return checkoutScriptPromise;

  checkoutScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      checkoutScriptPromise = null;
      reject(new Error("Couldn't load the payment window. Check your connection and try again."));
    };
    document.body.appendChild(script);
  });

  return checkoutScriptPromise;
}

/**
 * Calls one of the razorpay-* Edge Functions with the current session's
 * access token — every payment-mutating operation happens server-side
 * (order creation, signature verification); this is purely the transport.
 * Throws a structured error `{ code, status }` on any non-2xx response so
 * callers can branch on the same short error codes the RPCs already use.
 */
export async function callPaymentFunction(name, body) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    const err = new Error("Your session has expired — please sign in again.");
    err.code = "Not authenticated";
    throw err;
  }

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    });
  } catch {
    const err = new Error("Network error — please check your connection and try again.");
    err.code = "NETWORK_ERROR";
    throw err;
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    // fall through with json = null
  }

  if (!res.ok) {
    const err = new Error(json?.error || "Something went wrong. Please try again.");
    err.code = json?.error;
    err.status = res.status;
    throw err;
  }

  return json;
}
