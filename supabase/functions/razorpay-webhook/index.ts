// Phase 4.4 — Razorpay webhook endpoint. This is the AUTHORITATIVE,
// asynchronous payment source of truth — activation is designed to work
// correctly through this path alone, independent of whether the frontend's
// synchronous razorpay-verify-payment call ever runs (browser closed,
// network died, tab crashed — all recoverable, because this webhook will
// still arrive and independently activate the membership).
//
// verify_jwt is OFF for this function (configured at deploy time) — Razorpay
// does not send a Supabase JWT. Authenticity here comes entirely from the
// X-Razorpay-Signature HMAC check below, not from Supabase auth.
//
// CRITICAL: the signature is computed over the RAW request body — read as
// text and verified BEFORE any JSON.parse. Parsing then re-serializing (or
// otherwise touching whitespace) would silently break verification.
import { createClient } from "jsr:@supabase/supabase-js@2";

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

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function paiseToRupees(amountPaise: number): number {
  return Math.round(amountPaise) / 100;
}

// The one event this project acts on. Auto-capture is requested at
// order-creation time (payment_capture: 1 in razorpay-create-order), so
// payment.captured is the "money actually received" signal —
// payment.authorized alone is deliberately NOT treated as success.
//
// payment.failed is deliberately NOT acted on either. It describes one
// ATTEMPT, and Razorpay lets the customer try again on the same order in
// the same Checkout window; closing the order on a failed attempt would
// leave a later successful one captured but never fulfilled. An order
// nobody pays simply stays unpaid until expire_stale_orders() cancels it.
const HANDLED_EVENTS = new Set(["payment.captured"]);

interface PaymentEntity {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  method?: string;
  error_code?: string;
  error_description?: string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const signature = req.headers.get("X-Razorpay-Signature");
  const webhookSecret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");

  if (!webhookSecret) {
    console.error("razorpay-webhook: RAZORPAY_WEBHOOK_SECRET not configured");
    return new Response("Server not configured", { status: 500 });
  }
  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  const rawBody = await req.text();

  const expectedSignature = await hmacSha256Hex(webhookSecret, rawBody);
  if (!timingSafeEqualHex(expectedSignature, signature)) {
    console.warn("razorpay-webhook: signature mismatch");
    return new Response("Invalid signature", { status: 400 });
  }

  let event: { event?: string; payload?: { payment?: { entity?: PaymentEntity } } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const eventType = event.event;
  const entity = event.payload?.payment?.entity;

  // Razorpay's per-delivery id — the documented idempotency mechanism.
  // Falls back to a deterministic hash only if that header is ever
  // absent, so duplicate-event protection never silently degrades to none.
  const eventIdHeader = req.headers.get("x-razorpay-event-id");
  const eventId = eventIdHeader || `body:${await hmacSha256Hex(webhookSecret, rawBody)}`;

  if (!eventType || !HANDLED_EVENTS.has(eventType) || !entity?.id || !entity?.order_id) {
    // Not an event/shape this project acts on — acknowledge so Razorpay
    // doesn't retry something that was never going to be processed.
    return new Response("Ignored", { status: 200 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  const isSuccess = eventType === "payment.captured";

  const { data: result, error } = await serviceClient.rpc("process_payment_webhook", {
    p_event_id: eventId,
    p_event_type: eventType,
    p_gateway_order_id: entity.order_id,
    p_gateway_payment_id: entity.id,
    p_status: isSuccess ? "success" : "failed",
    p_amount: isSuccess && typeof entity.amount === "number" ? paiseToRupees(entity.amount) : null,
    p_currency: isSuccess ? entity.currency ?? null : null,
    p_metadata: isSuccess
      ? { method: entity.method ?? null }
      : { error_code: entity.error_code ?? null, error_description: entity.error_description ?? null },
  });

  if (error) {
    const isUnknownOrder = error.message?.includes("UNKNOWN_GATEWAY_ORDER_ID");
    console.error("razorpay-webhook: process_payment_webhook failed", error.message, {
      event_id: eventId,
      event_type: eventType,
      gateway_order_id: entity.order_id,
    });
    // An order we don't recognise (stale test event, wrong project) won't
    // resolve itself on retry — acknowledge it. Anything else is
    // unexpected on our end, so ask Razorpay to retry later.
    return new Response(isUnknownOrder ? "Unknown order — acknowledged" : "Processing error", {
      status: isUnknownOrder ? 200 : 500,
    });
  }

  console.log("razorpay-webhook: processed", {
    event_id: eventId,
    event_type: eventType,
    payment_id: (result as { id?: string } | null)?.id,
    status: (result as { status?: string } | null)?.status,
  });

  return new Response("OK", { status: 200 });
});
