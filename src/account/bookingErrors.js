/**
 * Maps the structured error codes raised by book_class() /
 * reschedule_booking() / cancel_booking() to rider-facing copy. The database
 * decides; this only words the outcome, in terms of classes and places
 * (never "credits").
 */
export function friendlyBookingError(error) {
  const code = error?.message?.trim();
  const detail = error?.details;
  const known = {
    NO_ACTIVE_MEMBERSHIP: "You don't have an active plan.",
    MEMBERSHIP_EXPIRED: detail || "This class falls after your plan ends.",
    NO_CREDITS_REMAINING: "You have no classes left on your plan.",
    WEEKLY_LIMIT_REACHED: detail || "You've reached the class limit for that week. Pick a day in another week.",
    SESSION_NOT_FOUND: "This class no longer exists.",
    SESSION_NOT_AVAILABLE: detail || "This class is not open for booking.",
    SESSION_FULL: "That class has just filled up. Please pick another time.",
    SLOT_NO_LONGER_AVAILABLE: "That place has just been taken. Please pick another time.",
    DUPLICATE_BOOKING: "You've already booked this class.",
    INVALID_SESSION_DATE: detail || "This class can't be booked.",
    BOOKING_NOT_FOUND: "We couldn't find that booking.",
    BOOKING_NOT_RESCHEDULABLE: detail || "This class can no longer be moved.",
    ALREADY_RESCHEDULED: "This class has already been moved once and can't be moved again.",
    RESCHEDULE_LIMIT_REACHED: detail || "You've used all your reschedules.",
    RESCHEDULE_WINDOW_CLOSED: "This class has already started, so it can't be moved.",
    SAME_SLOT: "That's the time you already have. Choose a different one.",
    BOOKING_NOT_CANCELLABLE: detail || "This class can't be cancelled.",
    "Not authenticated": "Your session has expired — please sign in again.",
  }[code];
  return known || "Something went wrong. Please try again.";
}

/** Errors after which the times must be reloaded (someone else took the place). */
export function isStaleSlotError(error) {
  const code = error?.message?.trim();
  return code === "SLOT_NO_LONGER_AVAILABLE" || code === "SESSION_FULL";
}
