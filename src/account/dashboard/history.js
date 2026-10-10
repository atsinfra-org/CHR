/**
 * Plain-language wording for a rider's past classes. Riders think in
 * "classes", not "credits", so the ledger arithmetic is translated here:
 * attending is not a penalty, and an absence either returned the class or
 * it didn't.
 */

/** Net effect of one booking on the plan, summed from its own ledger rows. */
export function creditImpact(booking) {
  const rows = Array.isArray(booking.credit_ledger) ? booking.credit_ledger : booking.credit_ledger ? [booking.credit_ledger] : [];
  return rows.reduce((sum, r) => sum + (r.amount ?? 0), 0);
}

/** Was the class given back (absence restore / cancellation credit)? */
function classReturned(booking) {
  const rows = Array.isArray(booking.credit_ledger) ? booking.credit_ledger : booking.credit_ledger ? [booking.credit_ledger] : [];
  return rows.some((r) => (r.transaction_type === "absence_restore" || r.transaction_type === "cancellation") && r.amount > 0);
}

/** { label, note, tone } for a past booking. tone: good | neutral | bad */
export function describeOutcome(booking) {
  switch (booking.status) {
    case "completed":
      return { label: "Attended", note: "Used 1 class", tone: "good" };
    case "absent":
      return classReturned(booking)
        ? { label: "Absent", note: "Class returned to your plan", tone: "neutral" }
        : { label: "Absent", note: "Class not returned", tone: "bad" };
    case "no_show":
      return { label: "Missed", note: "Used 1 class", tone: "bad" };
    case "rescheduled":
      return { label: "Moved", note: "Rescheduled to another time", tone: "neutral" };
    case "cancelled":
      return classReturned(booking)
        ? { label: "Cancelled", note: "Class returned to your plan", tone: "neutral" }
        : { label: "Cancelled", note: "Class not returned", tone: "bad" };
    default:
      return { label: booking.status, note: "", tone: "neutral" };
  }
}

/** Why a booked class can or can't be moved. */
export function rescheduleState(booking, plan) {
  if ((booking.reschedule_count ?? 0) >= 1) return { canMove: false, reason: "Already moved once" };
  const remaining = Math.max((plan?.reschedules_allowed ?? 0) - (plan?.reschedules_used ?? 0), 0);
  if (remaining <= 0) return { canMove: false, reason: "No reschedules left" };
  return { canMove: true, remaining, reason: null };
}
