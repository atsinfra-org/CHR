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

/* ------------------------------------------------------------------ */
/* Friendlier day / time wording for the customer area. All "IST" maths
   here is display-only; the server decides every booking rule. */

const IST_OFFSET_MIN = 330; // Asia/Kolkata is UTC+5:30 all year (no DST)

function utcDate(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Thu 16 Oct" */
export function formatDayShort(isoDate) {
  const d = isoDate && utcDate(isoDate);
  if (!d) return null;
  const p = (opts) => d.toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
  return `${p({ weekday: "short" })} ${p({ day: "numeric" })} ${p({ month: "short" })}`;
}

/** "Thursday 16 October" */
export function formatDayLong(isoDate) {
  const d = isoDate && utcDate(isoDate);
  if (!d) return null;
  const p = (opts) => d.toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
  return `${p({ weekday: "long" })} ${p({ day: "numeric" })} ${p({ month: "long" })}`;
}

function clock(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return { text: m ? `${hour12}:${String(m).padStart(2, "0")}` : `${hour12}`, period: h >= 12 ? "pm" : "am" };
}

/** "7 am" / "4:30 pm" */
export function formatClock(hhmm) {
  const c = hhmm && clock(hhmm);
  return c ? `${c.text} ${c.period}` : null;
}

/** "7 – 8 am", "11 am – 12 pm", "4:30 – 5:30 pm" */
export function formatTimeRange(start, end) {
  const a = start && clock(start);
  const b = end && clock(end);
  if (!a || !b) return null;
  return a.period === b.period ? `${a.text} – ${b.text} ${b.period}` : `${a.text} ${a.period} – ${b.text} ${b.period}`;
}

/** Whole days from one "YYYY-MM-DD" to another (b − a). */
export function daysBetween(aIso, bIso) {
  const a = aIso && utcDate(aIso);
  const b = bIso && utcDate(bIso);
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000);
}

/** "Today", "Tomorrow", "Thursday" (within a week), otherwise "Thu 16 Oct". */
export function relativeDay(isoDate, today = todayISODate()) {
  const diff = daysBetween(today, isoDate);
  if (diff === null) return null;
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff > 1 && diff < 7) return utcDate(isoDate).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  return formatDayShort(isoDate);
}

/** The instant (ms since epoch) a session starts, from its IST date and "HH:MM[:SS]" time. */
export function sessionInstant(isoDate, hhmm) {
  const [y, mo, d] = String(isoDate).split("-").map(Number);
  const [h, mi] = String(hhmm).split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MIN * 60000;
}

/** "in 40 minutes", "in 14 hours", "in 3 days" — or null once it has started. */
export function startsIn(isoDate, hhmm, now = Date.now()) {
  const mins = Math.round((sessionInstant(isoDate, hhmm) - now) / 60000);
  if (!(mins > 0)) return null;
  if (mins < 60) return `in ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}
