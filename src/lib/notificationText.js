const SEP = " · ";

/**
 * The text of a notification as it should be shown.
 *
 * A booking is a place in a class, and nothing in the app names a horse.
 * Booking notifications written before migration 0022 ended with one
 * ("<slot> · <name>" for riders, "<rider> · <slot> · <name>" for staff), so
 * those are cut back to the part that still applies. Once 0022 has cleaned
 * the stored rows this changes nothing.
 */
export function notificationBody(n) {
  if (!n?.body) return null;
  const parts = n.body.split(SEP);
  if (n.type === "booking_confirmed" || n.type === "class_reminder") return parts[0];
  if (n.type === "booking_created") return parts.slice(0, 2).join(SEP);
  return n.body;
}
