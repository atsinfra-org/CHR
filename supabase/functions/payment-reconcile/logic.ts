// Pure decision logic for payment-reconcile (runs under Node in supabase/tests).

export type GatewayPayment = { id?: string; status?: string; amount?: number; currency?: string; created_at?: number };

export type Decision =
  | { action: "capture"; payment: GatewayPayment }   // Razorpay says money was received: run the existing idempotent flow
  | { action: "pending"; notify: boolean }           // a payment attempt is in flight / unconfirmed
  | { action: "none" };                              // nothing has been attempted, or every attempt failed

export const PENDING_EMAIL_AFTER_MINUTES = 30;

/**
 * Looks only at what Razorpay itself reports for the order.
 *  - A captured payment is the only thing treated as success (same rule as razorpay-webhook and
 *    razorpay-verify-payment: "authorized" alone is NOT success).
 *  - Failed attempts are NOT turned into a failed payment here either: the customer may retry on the
 *    same order, and the webhook deliberately ignores payment.failed for the same reason.
 *  - An authorized/created attempt is "still being verified". A single "still verifying" email is
 *    offered once it has been that way for PENDING_EMAIL_AFTER_MINUTES; the database's dedupe key makes
 *    repeats on later runs no-ops.
 */
export function decide(items: GatewayPayment[] | undefined, nowSeconds: number): Decision {
  const list = Array.isArray(items) ? items : [];
  const captured = list.find((p) => p?.status === "captured" && typeof p.id === "string");
  if (captured) return { action: "capture", payment: captured };
  const inFlight = list.filter((p) => p?.status === "authorized" || p?.status === "created");
  if (inFlight.length === 0) return { action: "none" };
  const oldest = Math.min(...inFlight.map((p) => (typeof p.created_at === "number" ? p.created_at : nowSeconds)));
  return { action: "pending", notify: nowSeconds - oldest >= PENDING_EMAIL_AFTER_MINUTES * 60 };
}

export function paiseToRupees(paise: number): number {
  return Math.round(paise) / 100;
}
