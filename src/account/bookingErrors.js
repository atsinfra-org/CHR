/**
 * Maps the structured error codes raised by book_class() /
 * reschedule_booking() / cancel_booking() to member-facing copy. The
 * database decides; this only words the outcome.
 */
export function friendlyBookingError(error) {
  const code = error?.message?.trim();
  const detail = error?.details;
  const known = {
    NO_ACTIVE_MEMBERSHIP: "You don't have an active membership.",
    MEMBERSHIP_EXPIRED: detail || "This class falls after your membership ends.",
    NO_CREDITS_REMAINING: "You have no class credits remaining.",
    WEEKLY_LIMIT_REACHED: detail || "You've reached this week's class limit.",
    SESSION_NOT_FOUND: "This class no longer exists.",
    SESSION_NOT_AVAILABLE: detail || "This class is not open for booking.",
    SESSION_FULL: "This class is now full.",
    SLOT_NO_LONGER_AVAILABLE: "Someone just booked that horse. Please pick another horse or session.",
    HORSE_NOT_AVAILABLE: "That horse isn't available for this class.",
    DUPLICATE_BOOKING: "You've already booked this class.",
    INVALID_SESSION_DATE: detail || "This class can't be booked.",
    BOOKING_NOT_FOUND: "We couldn't find that booking.",
    BOOKING_NOT_RESCHEDULABLE: detail || "This booking can no longer be rescheduled.",
    ALREADY_RESCHEDULED: "A rescheduled class can't be rescheduled again.",
    RESCHEDULE_LIMIT_REACHED: detail || "You've used all your reschedules.",
    RESCHEDULE_WINDOW_CLOSED: "This class has already started, so it can't be rescheduled.",
    SAME_SLOT: "That's the slot you already have. Choose a different one.",
    BOOKING_NOT_CANCELLABLE: detail || "This booking can't be cancelled.",
    "Not authenticated": "Your session has expired — please sign in again.",
  }[code];
  return known || "Something went wrong. Please try again.";
}

/** Errors after which the slot list must be reloaded (someone else won the race). */
export function isStaleSlotError(error) {
  const code = error?.message?.trim();
  return code === "SLOT_NO_LONGER_AVAILABLE" || code === "SESSION_FULL" || code === "HORSE_NOT_AVAILABLE";
}
