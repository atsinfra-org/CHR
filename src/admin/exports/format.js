/**
 * Formatting shared by the Excel and PDF exports, so the two files always show the same labels, dates and money.
 * Dates are India (IST) calendar days, the club's own convention. Amounts are INR exactly as stored; there is no
 * paise conversion anywhere in the export.
 */

const STATUS_LABELS = {
  none: "No membership",
  pending_payment: "Pending payment",
  partially_refunded: "Partially refunded",
  no_show: "No show",
};

/** "partially_refunded" -> "Partially refunded". Empty stays empty (a blank cell, never a made-up value). */
export function statusLabel(value) {
  if (value == null || value === "") return "";
  const v = String(value);
  if (STATUS_LABELS[v]) return STATUS_LABELS[v];
  const words = v.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const IST = "Asia/Kolkata";
const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST });

/** "2026-10-21" -> "21 Oct 2026". */
export function formatDate(isoDate) {
  if (!isoDate) return "";
  const d = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : dateFmt.format(d);
}

/** A timestamptz -> "21 Oct 2026, 14:30" in IST. */
export function formatDateTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : dateTimeFmt.format(d).replace(/,?\s(?=\d{2}:\d{2}$)/, ", ");
}

/** "17:00:00" -> "5:00 PM". */
export function formatTime(hhmmss) {
  if (!hhmmss) return "";
  const [h, m] = String(hhmmss).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return "";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

const inr = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 15000 -> "₹15,000.00". Another currency is shown with its code, never relabelled as rupees. */
export function formatMoney(amount, currency = "INR") {
  if (amount == null || amount === "") return "";
  const n = Number(amount);
  if (Number.isNaN(n)) return "";
  return !currency || currency === "INR" ? `₹${inr.format(n)}` : `${currency} ${inr.format(n)}`;
}

/** The first 8 characters of an id, upper-case, the way the admin screens show references. */
export const shortId = (id) => (id ? String(id).slice(0, 8).toUpperCase() : "");

// ── Spreadsheet formula-injection protection ────────────────────────────────────────────────────────────────
// Excel, LibreOffice and Google Sheets treat a cell that begins with = + - @ (or a tab / carriage return) as a formula
// when the text is typed, pasted or re-saved as CSV. Member names, items and references are typed by people, so text
// that could start a formula is written with a leading apostrophe. The database value is never changed.
// Phone numbers and plain numbers (+91 98000 00001, -5) are left alone: they cannot contain a command.
const NUMBER_LIKE = /^[+-]?\d[\d\s().-]*$/;
const FORMULA_START = /^[\s\p{Cc}]*[=+\-@]/u;
const CONTROL_START = /^[\t\r\n]/;

export function sheetSafe(value) {
  if (typeof value !== "string" || value === "") return value;
  if (NUMBER_LIKE.test(value)) return value;
  return FORMULA_START.test(value) || CONTROL_START.test(value) ? `'${value}` : value;
}

// ── PDF text safety ─────────────────────────────────────────────────────────────────────────────────────────
// The embedded font covers Latin letters, Latin-1/Extended-A, common punctuation and the rupee sign. Anything else
// (for example Devanagari in a name) would draw as a blank box, so it is shown as "?" instead. Excel keeps every character.
const EXTRA_GLYPHS = new Set([0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x20b9, 0x20ac, 0x00b7, 0x2212, 0x2192]);
const hasGlyph = (c) => (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0x24f) || EXTRA_GLYPHS.has(c);

export function pdfSafe(value) {
  if (value == null) return "";
  let out = "";
  for (const ch of String(value).replace(/[\r\n\t]+/g, " ")) out += hasGlyph(ch.codePointAt(0)) ? ch : "?";
  return out;
}

// ── Filters ─────────────────────────────────────────────────────────────────────────────────────────────────
const FILTER_LABEL = { from: "From", to: "To", status: "Status", plan: "Plan", gateway: "Gateway" };

/** [["From", "01 Oct 2026"], ["Status", "Failed"]]; empty when no filter is applied. */
export function describeFilters(spec, filters = {}) {
  const out = [];
  for (const name of ["from", "to", "status", "plan", "gateway"]) {
    const v = filters[name];
    if (!v) continue;
    const label = name === "from" ? `${spec?.dateLabel ?? "Date"} from` : name === "to" ? `${spec?.dateLabel ?? "Date"} to` : FILTER_LABEL[name];
    out.push([label, name === "from" || name === "to" ? formatDate(v) : name === "status" ? statusLabel(v) : v]);
  }
  return out;
}

export const filtersText = (spec, filters) => {
  const list = describeFilters(spec, filters);
  return list.length ? list.map(([k, v]) => `${k}: ${v}`).join("  |  ") : "None (all records)";
};

// ── Excel value conversion ──────────────────────────────────────────────────────────────────────────────────
/** A date-only value as a real Excel date (midnight, no timezone drift). */
export const excelDate = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`) : null);

/** A timestamptz as the IST wall-clock time, stored as a real Excel date-time (Excel has no time zones). */
export function excelDateTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() + 330 * 60000);
}

/** "17:00:00" -> 0.708333 (a fraction of a day, shown as h:mm AM/PM). */
export function excelTime(hhmmss) {
  if (!hhmmss) return null;
  const [h, m, s] = String(hhmmss).split(":").map(Number);
  return Number.isNaN(h) ? null : (h * 3600 + (m || 0) * 60 + (s || 0)) / 86400;
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** chr-payments-2026-10-21.xlsx (the IST date). */
export function fileName(kind, ext, now = new Date()) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(now);
  return `chr-${kind === "combined" ? "combined-report" : kind}-${day}.${ext}`;
}
