/**
 * Small, pure, display-only helpers shared by the member dashboard cards.
 *
 * IMPORTANT: this file must never contain the membership weekly-block
 * calculation (block start/end dates, classes-used count, weekly limit).
 * That business rule lives ONLY in the database now — see
 * public.member_current_block_usage() and public.book_class()
 * (supabase/proposals/0007_member_block_usage.sql), both of which read the
 * same system_settings-backed constants. The dashboard fetches the already-
 * computed values via that RPC (see useMemberDashboard.js) and only
 * formats/presents them here — it does not re-derive them.
 */

export function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Today's date on the Indian business calendar (Asia/Kolkata) as
 * "YYYY-MM-DD", regardless of the viewer's own browser timezone. The
 * backend decides every date rule in IST now (book_class(),
 * member_booking_eligibility(), activate_membership(), … — see
 * supabase/proposals/0011 & 0012); the few remaining client-side date
 * comparisons (membership active-vs-lapsed categorisation, the "from
 * today onward" upcoming-bookings filter) must use the same reference so
 * they can't disagree with the server around the IST midnight boundary.
 * This is a display/UX reference only — never an authorization decision.
 */
export function todayISODate() {
  // en-CA formats as ISO 8601 (YYYY-MM-DD).
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** "10 Sep 2026" */
export function formatDate(isoDate) {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/** "06:00 AM" from a "HH:MM:SS" time-only string. */
export function formatTime(hhmmss) {
  if (!hhmmss) return null;
  const [h, m] = hhmmss.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(hour12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${period}`;
}

export function formatDateShort(isoDate) {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}

export function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(new Date(iso).toISOString().slice(0, 10));
}
