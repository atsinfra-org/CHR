// Phase 4.4 — synchronous post-Checkout verification.
//
// Called by MembershipPurchase.jsx right after Razorpay Checkout's
// `handler` callback fires, so the member gets an immediate result instead
// of waiting for the async webhook. This is a CONVENIENCE, not the
// authority: it independently re-verifies everything server-side before
// ever calling process_payment_webhook() (the only function that actually
// activates a membership), and the real webhook (razorpay-webhook) will
// independently reach the same conclusion regardless of whether this
// endpoint ever runs — process_payment_webhook()'s idempotency guarantees
// only one of the two ever has an effect.
//
// Never trusts the browser's razorpay_order_id — it's checked against the
// order id this project's own server stored when the order was created.
// Never trusts "Checkout closed successfully" — the payment's actual
// status is re-fetched from Razorpay's API and must be 'captured'.
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";
const encoder = new TextEncoder();

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time compare of two equal-length hex strings. A length
 * mismatch returns false immediately — that leaks nothing secret, since
 * signature length is fixed and public. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function paiseToRupees(amountPaise: number): number {
  return Math.round(amountPaise) / 100;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Not authenticated" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // RLS-scoped (caller's own JWT) — used only to look up/confirm
    // ownership of the payment. Never used to call process_payment_
    // webhook() itself; that call happens on the service-role client
    // further down, since that function is intentionally inaccessible to
    // `authenticated` (Phase 4.3's fix, preserved here).
    const asUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: userData, error: userError } = await asUser.auth.getUser();
    if (userError || !userData?.user) return json({ error: "Not authenticated" }, 401);

    let body: {
      payment_id?: string;
      razorpay_order_id?: string;
      razorpay_payment_id?: string;
      razorpay_signature?: string;
    };
    try {
      body = await req.json();
    } catch {
      return json({ error: "INVALID_REQUEST" }, 400);
    }

    const { payment_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
    if (!payment_id || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return json({ error: "INVALID_REQUEST" }, 400);
    }

    const { data: payment, error: paymentError } = await asUser
      .from("payments")
      .select("id, gateway, gateway_order_id, amount, currency, status")
      .eq("id", payment_id)
      .maybeSingle();

    if (paymentError) {
      console.error("razorpay-verify-payment: lookup failed", paymentError.message);
      return json({ error: "PAYMENT_LOOKUP_FAILED" }, 500);
    }
    if (!payment) return json({ error: "PAYMENT_NOT_FOUND" }, 404);
    if (payment.gateway !== "razorpay") return json({ error: "WRONG_GATEWAY" }, 400);

    if (payment.status === "success") return json({ status: "success", already_processed: true });
    if (payment.status === "failed") return json({ status: "failed" });

    if (!payment.gateway_order_id || payment.gateway_order_id !== razorpay_order_id) {
      console.warn("razorpay-verify-payment: order id mismatch", { payment_id: payment.id });
      return json({ error: "ORDER_ID_MISMATCH" }, 400);
    }

    const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
    if (!keySecret) {
      console.error("razorpay-verify-payment: RAZORPAY_KEY_SECRET not configured");
      return json({ error: "SERVER_NOT_CONFIGURED" }, 500);
    }

    const expectedSignature = await hmacSha256Hex(keySecret, `${payment.gateway_order_id}|${razorpay_payment_id}`);
    if (!timingSafeEqualHex(expectedSignature, razorpay_signature)) {
      console.warn("razorpay-verify-payment: signature mismatch", { payment_id: payment.id });
      return json({ error: "INVALID_SIGNATURE" }, 400);
    }

    // Signature authenticity alone doesn't prove capture — re-fetch the
    // payment from Razorpay's own API (Phase 4.4 §16).
    const rzpRes = await fetch(`${RAZORPAY_API_BASE}/payments/${razorpay_payment_id}`, {
      headers: { Authorization: "Basic " + btoa(`${Deno.env.get("RAZORPAY_KEY_ID")}:${keySecret}`) },
    });
    const rzpPayment = await rzpRes.json();
    if (!rzpRes.ok) {
      console.error("razorpay-verify-payment: Razorpay payment fetch failed", rzpPayment);
      return json({ error: "VERIFICATION_FAILED" }, 502);
    }

    if (rzpPayment.order_id !== payment.gateway_order_id) {
      console.error("razorpay-verify-payment: order id mismatch from Razorpay API", { payment_id: payment.id });
      return json({ error: "ORDER_ID_MISMATCH" }, 400);
    }

    if (rzpPayment.status !== "captured") {
      // Authorized-but-not-yet-captured, or anything else non-final — do
      // not activate. The webhook (or a later status check) resolves it.
      return json({ status: rzpPayment.status === "failed" ? "failed" : "pending" });
    }

    const amountRupees = paiseToRupees(rzpPayment.amount);

    const serviceClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const { data: result, error: rpcError } = await serviceClient.rpc("process_payment_webhook", {
      p_event_id: `sync:${razorpay_payment_id}`,
      p_event_type: "payment.captured (sync)",
      p_gateway_order_id: payment.gateway_order_id,
      p_gateway_payment_id: razorpay_payment_id,
      p_status: "success",
      p_amount: amountRupees,
      p_currency: rzpPayment.currency,
      p_metadata: { source: "sync-verify", method: rzpPayment.method ?? null },
    });

    if (rpcError) {
      console.error("razorpay-verify-payment: process_payment_webhook failed", rpcError.message, {
        payment_id: payment.id,
      });
      return json({ error: "VERIFICATION_FAILED" }, 500);
    }

    const finalStatus = (result as { status?: string } | null)?.status;
    return json({
      status: finalStatus === "success" ? "success" : "pending",
      membership_id: (result as { membership_id?: string } | null)?.membership_id ?? null,
    });
  } catch (err) {
    console.error("razorpay-verify-payment: unhandled error", err instanceof Error ? err.message : err);
    return json({ error: "INTERNAL_ERROR" }, 500);
  }
});
