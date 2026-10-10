// Server-side Razorpay Order creation.
//
// Called by RazorpayPaymentFlow.jsx (checkout, and "Pay now" on My Orders)
// with ONLY an internal payment id — never an amount. The authoritative
// amount/currency always come from the `payments` row (itself only ever
// written by create_order()), looked up here through the CALLER'S OWN JWT
// so RLS ("Members read own payments") is what actually scopes this to
// their own row — this function never uses the service-role key at all.
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
      // payments and memberships are linked by two foreign keys, so the
      // relationship has to be named or PostgREST refuses the embed (PGRST201).
      .select(
        "id, membership_id, order_id, gateway, gateway_order_id, amount, currency, status, " +
          "memberships!payments_membership_id_fkey(status), orders(status, has_membership)",
      )
      .eq("id", paymentId)
      .maybeSingle();

    if (paymentError) {
      console.error("razorpay-create-order: payment lookup failed", paymentError.message);
      return json({ error: "PAYMENT_LOOKUP_FAILED" }, 500);
    }
    if (!payment) return json({ error: "PAYMENT_NOT_FOUND" }, 404);
    if (payment.gateway !== "razorpay") return json({ error: "WRONG_GATEWAY" }, 400);
    if (payment.status !== "created") return json({ error: "PAYMENT_NOT_PENDING" }, 409);

    // Phase 5: a payment belongs either to a store order (the normal path)
    // or, for legacy rows, directly to a pending membership.
    type Rel = { status?: string; has_membership?: boolean };
    const one = (rel: unknown): Rel | undefined =>
      Array.isArray(rel) ? (rel[0] as Rel | undefined) : ((rel as Rel | null | undefined) ?? undefined);
    if (payment.order_id) {
      const storeOrder = one(payment.orders);
      if (storeOrder?.status !== "pending") return json({ error: "ORDER_NOT_ELIGIBLE" }, 409);

      // An unpaid order can be paid later from My Orders. If it holds a
      // membership and the customer has since got an active one, paying it
      // would charge them for a second plan — the same rule create_order()
      // applies when an order is first placed.
      if (storeOrder.has_membership) {
        const todayIst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        const { count, error: activeError } = await supabase
          .from("memberships")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userData.user.id)
          .eq("status", "active")
          .gte("end_date", todayIst)
          .gt("credits_remaining", 0);
        if (activeError) {
          console.error("razorpay-create-order: membership check failed", activeError.message);
          return json({ error: "PAYMENT_LOOKUP_FAILED" }, 500);
        }
        if ((count ?? 0) > 0) return json({ error: "ACTIVE_MEMBERSHIP_EXISTS" }, 409);
      }
    } else if (one(payment.memberships)?.status !== "pending_payment") {
      return json({ error: "MEMBERSHIP_NOT_ELIGIBLE" }, 409);
    }

    if (!Deno.env.get("RAZORPAY_KEY_ID") || !Deno.env.get("RAZORPAY_KEY_SECRET")) {
      console.error("razorpay-create-order: Razorpay keys are not configured");
      return json({ error: "SERVER_NOT_CONFIGURED" }, 500);
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
        notes: {
          internal_payment_id: payment.id,
          internal_membership_id: payment.membership_id,
          internal_order_id: payment.order_id,
        },
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
