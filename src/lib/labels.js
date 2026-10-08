/** Human-readable labels for internal enums. The raw value stays available for detail views. */

const LEDGER_LABEL = {
  membership_purchase: "Membership Purchase",
  booking: "Class Booking",
  cancellation: "Cancellation Credit",
  admin_adjustment: "Admin Adjustment",
  refund: "Refund",
  expiry: "Credits Expired",
  absence_restore: "Absence Credit Restored",
  reschedule: "Reschedule",
};

export function ledgerTypeLabel(type) {
  return LEDGER_LABEL[type] ?? titleCase(type);
}

const ORDER_LABEL = {
  pending: "Awaiting Payment Confirmation",
  paid: "Paid",
  ready_for_collection: "Ready for Collection",
  collected: "Collected",
  cancelled: "Cancelled",
  failed: "Payment Failed",
};

export function orderStatusLabel(status) {
  return ORDER_LABEL[status] ?? titleCase(status);
}

/** Short, human-friendly order reference derived from the id (display only). */
export function orderNumber(id) {
  return id ? `CSF-${String(id).replace(/-/g, "").slice(0, 8).toUpperCase()}` : "—";
}

/**
 * What to tell the customer about payment. `payment` is the order's payments
 * row (or null). Never claims success unless the payment row says so.
 */
export function paymentSummary(order, payment) {
  const p = Array.isArray(payment) ? payment[0] : payment;
  if (p?.status === "success") {
    const method = p.gateway === "manual" ? "Manual (paid at the club)" : titleCase(p.gateway);
    return { label: "Paid", method };
  }
  if (order.status === "cancelled" || p?.status === "expired") return { label: "Not paid", method: "—" };
  if (order.status === "failed" || p?.status === "failed") return { label: "Failed", method: "—" };
  return { label: "Awaiting confirmation", method: "—" };
}

/** What the customer should do/expect for each fulfilment state. */
export function collectionNote(order) {
  if (!order.has_in_store) return null;
  if (order.status === "ready_for_collection") return "Ready for Collection — pick up in store.";
  if (order.status === "collected") return "Collected.";
  if (order.status === "paid") return "Store Collection — we'll tell you when it's ready.";
  if (order.status === "pending") return "Store Collection — available after payment is confirmed.";
  return null;
}

export function titleCase(s) {
  if (!s) return "—";
  return String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
