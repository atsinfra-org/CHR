// Recovers payments whose outcome the database does not know yet: checkout closed, phone lost signal,
// webhook late or never delivered, verification timed out.
//
// Called by the database every 10 minutes (pg_cron -> pg_net) with {sweep:true}. verify_jwt is OFF
// (deploy with --no-verify-jwt); authenticity is the x-email-secret header.
//
// It adds NO new payment logic. For each open payment it asks Razorpay what it holds for that order:
//   captured   -> calls the EXISTING process_payment_webhook(), exactly as razorpay-webhook and
//                 razorpay-verify-payment do. That function is idempotent (event ids + the payment's
//                 own status), so a webhook arriving later or twice cannot allocate credits twice.
//   in flight  -> leaves the payment open (the app already shows "awaiting payment"/"being confirmed")
//                 and, after 30 minutes, queues ONE "still verifying" email (deduped per payment).
//   otherwise  -> leaves it alone. Failed attempts are never turned into a failed payment here
//                 (the customer may retry on the same order), and a lookup error leaves it pending.
// It never creates a payment, an order or a Razorpay order, and never tells anyone to pay again.
//
// Secrets: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (already set for the other payment functions) and
// EMAIL_FUNCTION_SECRET (shared with the database).
import { createClient } from "jsr:@supabase/supabase-js@2";

import { timingSafeEqual } from "../email-send/logic.ts";
import { decide, paiseToRupees } from "./logic.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const secret = Deno.env.get("EMAIL_FUNCTION_SECRET");
  if (!secret || !timingSafeEqual(secret, req.headers.get("x-email-secret") ?? "")) return json({ error: "UNAUTHORIZED" }, 401);

  const keyId = Deno.env.get("RAZORPAY_KEY_ID");
  const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
  if (!keyId || !keySecret) return json({ checked: 0, reason: "not_configured" });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: open, error } = await db.rpc("payments_needing_reconciliation", { p_min_age_minutes: 10, p_limit: 50 });
  if (error) {
    console.error("payment-reconcile: listing failed", error.message);
    return json({ error: "LIST_FAILED" }, 500);
  }

  const auth = "Basic " + btoa(`${keyId}:${keySecret}`);
  const tally = { checked: 0, recovered: 0, still_pending: 0, pending_notified: 0, lookup_failed: 0, process_failed: 0 };

  for (const p of (open ?? []) as { payment_id: string; gateway_order_id: string }[]) {
    tally.checked++;
    let items;
    try {
      const res = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(p.gateway_order_id)}/payments`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      items = (await res.json())?.items;
    } catch (err) {
      // Uncertain stays uncertain: no state change, retried on the next run.
      tally.lookup_failed++;
      console.warn("payment-reconcile: lookup failed", { payment_id: p.payment_id, reason: err instanceof Error ? err.message : "unknown" });
      continue;
    }

    const decision = decide(items, Math.floor(Date.now() / 1000));
    if (decision.action === "capture") {
      const g = decision.payment;
      const { error: rpcError } = await db.rpc("process_payment_webhook", {
        p_event_id: `reconcile:${g.id}`,
        p_event_type: "payment.captured (reconcile)",
        p_gateway_order_id: p.gateway_order_id,
        p_gateway_payment_id: g.id,
        p_status: "success",
        p_amount: typeof g.amount === "number" ? paiseToRupees(g.amount) : null,
        p_currency: g.currency ?? null,
        p_metadata: { source: "reconcile" },
      });
      if (rpcError) {
        tally.process_failed++;
        console.error("payment-reconcile: process_payment_webhook failed", { payment_id: p.payment_id, reason: rpcError.message });
      } else {
        tally.recovered++;
      }
    } else if (decision.action === "pending") {
      tally.still_pending++;
      if (decision.notify) {
        const { data: created } = await db.rpc("enqueue_payment_pending_email", { p_payment_id: p.payment_id });
        if (created) tally.pending_notified++;
      }
    }
  }

  console.log("payment-reconcile: run", tally);
  return json(tally);
});
