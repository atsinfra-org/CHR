/** Display-only helpers for the admin surface. No business logic here —
 * every operational number the admin sees is computed server-side
 * (admin_dashboard_metrics / the RLS-scoped tables), this file only
 * formats. */

/** "10 Sep 2026" from a "YYYY-MM-DD" date string. */
export function fmtDate(isoDate) {
  if (!isoDate) return "—";
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/** "10 Sep 2026, 14:30" from a timestamptz string, in the viewer's locale. */
export function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "06:00 AM" from a "HH:MM:SS" time-only string. */
export function fmtTime(hhmmss) {
  if (!hhmmss) return "—";
  const [h, m] = hhmmss.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return "—";
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(hour12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${period}`;
}

/** "₹16,000" — amount is already a rupee value (numeric column). */
export function fmtMoney(amount, currency = "INR") {
  if (amount == null) return "—";
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

/** Today's date on the Asia/Kolkata business calendar as "YYYY-MM-DD".
 * Display/default-value use only — never an authorization decision (the
 * RPCs re-derive IST dates server-side). */
export function istToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** True when `iso` (a timestamptz string) falls within the last `days` days.
 * "Now" is encapsulated here rather than read during a component's render —
 * the same reason relativeTime() and istToday() exist, and what keeps pages
 * free of the react(purity) warning that a bare Date.now() in render earns. */
export function withinLastDays(iso, days) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t >= Date.now() - days * 24 * 60 * 60 * 1000;
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function titleCase(s) {
  if (!s) return "—";
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
