// Phase 4.4 — server-side Razorpay Order creation.
//
// Called by MembershipPurchase.jsx with ONLY an internal payment id — never
// an amount. The authoritative amount/currency always come from the
// `payments` row (itself only ever populated by initiate_membership_
// purchase(), Phase 4.3), looked up here through the CALLER'S OWN JWT so
// RLS ("Members read own payments") is what actually scopes this to their
// own row — this function never uses the service-role key at all.
//
// Idempotent: if a Razorpay order is already attached to this payment, it
// is returned as-is rather than creating a second one (double-click,
// refresh, retry, two tabs).
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

function razorpayAuthHeader(): string {
  const keyId = Deno.env.get("RAZORPAY_KEY_ID");
  const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
  if (!keyId || !keySecret) throw new Error("Razorpay credentials are not configured");
  return "Basic " + btoa(`${keyId}:${keySecret}`);
}

function rupeesToPaise(amount: number): number {
  return Math.round(Number(amount) * 100);
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

    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) return json({ error: "Not authenticated" }, 401);

    let body: { payment_id?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "INVALID_REQUEST" }, 400);
    }
    const paymentId = body.payment_id;
    if (!paymentId || typeof paymentId !== "string") {
      return json({ error: "payment_id is required" }, 400);
    }

    const { data: payment, error: paymentError } = await supabase
      .from("payments")
      .select("id, membership_id, gateway, gateway_order_id, amount, currency, status, memberships!inner(status)")
      .eq("id", paymentId)
      .maybeSingle();

    if (paymentError) {
      console.error("razorpay-create-order: payment lookup failed", paymentError.message);
      return json({ error: "PAYMENT_LOOKUP_FAILED" }, 500);
    }
    if (!payment) return json({ error: "PAYMENT_NOT_FOUND" }, 404);
    if (payment.gateway !== "razorpay") return json({ error: "WRONG_GATEWAY" }, 400);
    if (payment.status !== "created") return json({ error: "PAYMENT_NOT_PENDING" }, 409);

    const membershipRel = payment.memberships as unknown;
    const membershipStatus = Array.isArray(membershipRel)
      ? (membershipRel[0] as { status?: string } | undefined)?.status
      : (membershipRel as { status?: string } | undefined)?.status;
    if (membershipStatus !== "pending_payment") {
      return json({ error: "MEMBERSHIP_NOT_ELIGIBLE" }, 409);
    }

    const amountPaise = rupeesToPaise(payment.amount as unknown as number);

    if (payment.gateway_order_id) {
      return json({
        key_id: Deno.env.get("RAZORPAY_KEY_ID"),
        order_id: payment.gateway_order_id,
        amount: amountPaise,
        currency: payment.currency,
      });
    }

    const orderRes = await fetch(`${RAZORPAY_API_BASE}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: razorpayAuthHeader() },
      body: JSON.stringify({
        amount: amountPaise,
        currency: payment.currency,
        receipt: payment.id,
        // No sensitive personal data — internal correlation ids only.
        notes: { internal_payment_id: payment.id, internal_membership_id: payment.membership_id },
        payment_capture: 1,
      }),
    });
    const order = await orderRes.json();
    if (!orderRes.ok) {
      console.error("razorpay-create-order: Razorpay order creation failed", order);
      return json({ error: "ORDER_CREATION_FAILED" }, 502);
    }

    const { data: attached, error: attachError } = await supabase.rpc("attach_gateway_order", {
      p_payment_id: payment.id,
      p_gateway_order_id: order.id,
      p_gateway_order_amount: payment.amount,
      p_gateway_order_currency: payment.currency,
    });

    if (attachError) {
      console.error("razorpay-create-order: attach failed", attachError.message, {
        payment_id: payment.id,
        order_id: order.id,
      });
      return json({ error: "ORDER_ATTACH_FAILED" }, 500);
    }

    const finalOrderId = (attached as { gateway_order_id?: string } | null)?.gateway_order_id ?? order.id;

    return json({
      key_id: Deno.env.get("RAZORPAY_KEY_ID"),
      order_id: finalOrderId,
      amount: amountPaise,
      currency: payment.currency,
    });
  } catch (err) {
    console.error("razorpay-create-order: unhandled error", err instanceof Error ? err.message : err);
    return json({ error: "INTERNAL_ERROR" }, 500);
  }
});
