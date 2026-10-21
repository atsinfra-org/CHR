import { adminApi } from "../adminApi";

/**
 * What each export contains and how its data is fetched. The data itself comes from the administrator-only
 * database functions in 0036_admin_reports.sql, one page at a time; nothing is queried directly from the browser and
 * no report is generated for anyone but an administrator (the database refuses everyone else).
 *
 * Column `type` decides formatting in both Excel and PDF:
 *   text | status | date | datetime | time | money | int | id
 * `pdf` is a relative width for the PDF table (columns are scaled to fit the page); `excel` is the column width.
 */
export const PAGE_SIZE = 500;
export const MAX_ROWS = 20000; // per report; a bigger report must be narrowed with filters

const personColumns = [
  { key: "full_name", header: "Name", type: "text", excel: 24, pdf: 3 },
  { key: "phone", header: "Phone", type: "text", excel: 17, pdf: 2.4 },
  { key: "email", header: "Email", type: "text", excel: 32, pdf: 4 },
];

export const REPORTS = {
  members: {
    title: "Member Registrations",
    sheet: "Members",
    columns: [
      { key: "member_id", header: "Member ID", type: "id", excel: 38, pdf: 3 },
      ...personColumns,
      { key: "registered_at", header: "Registered (IST)", type: "datetime", excel: 20, pdf: 2.6 },
      { key: "plan_name", header: "Membership type", type: "text", excel: 22, pdf: 2.6 },
      { key: "membership_status", header: "Membership status", type: "status", excel: 18, pdf: 2.2 },
      { key: "start_date", header: "Membership start", type: "date", excel: 16, pdf: 2.2 },
      { key: "end_date", header: "Membership expiry", type: "date", excel: 16, pdf: 2.2 },
    ],
    filters: ["from", "to", "status", "plan"],
    dateLabel: "Registration date",
    statuses: ["none", "pending_payment", "active", "expired", "cancelled", "suspended"],
  },
  memberships: {
    title: "Memberships",
    sheet: "Memberships",
    columns: [
      { key: "member_id", header: "Member ID", type: "id", excel: 38, pdf: 2.6 },
      ...personColumns,
      { key: "plan_name", header: "Plan", type: "text", excel: 20, pdf: 2.4 },
      { key: "plan_price", header: "Plan price", type: "money", excel: 14, pdf: 2.2 },
      { key: "total_credits", header: "Total classes", type: "int", excel: 13, pdf: 1.4 },
      { key: "credits_used", header: "Classes used", type: "int", excel: 13, pdf: 1.4 },
      { key: "credits_remaining", header: "Classes remaining", type: "int", excel: 16, pdf: 1.6 },
      { key: "purchased_at", header: "Purchased (IST)", type: "datetime", excel: 20, pdf: 2.6 },
      { key: "start_date", header: "Activation / start", type: "date", excel: 16, pdf: 2.2 },
      { key: "end_date", header: "Expiry", type: "date", excel: 14, pdf: 2.2 },
      { key: "membership_status", header: "Status", type: "status", excel: 16, pdf: 2 },
      { key: "payment_status", header: "Payment status", type: "status", excel: 16, pdf: 2 },
      { key: "payment_amount", header: "Payment amount", type: "money", excel: 16, pdf: 2.2 },
    ],
    filters: ["from", "to", "status", "plan"],
    dateLabel: "Purchase date",
    statuses: ["pending_payment", "active", "expired", "cancelled", "suspended"],
  },
  payments: {
    title: "Payment Follow-Up",
    sheet: "Payments",
    columns: [
      { key: "payment_id", header: "Payment ID", type: "id", excel: 38, pdf: 3 },
      ...personColumns,
      { key: "items", header: "Purchased", type: "text", excel: 34, pdf: 3.6 },
      { key: "amount", header: "Amount", type: "money", excel: 14, pdf: 2.2 },
      { key: "currency", header: "Currency", type: "text", excel: 10, pdf: 1.9 },
      { key: "gateway", header: "Gateway", type: "text", excel: 11, pdf: 1.6 },
      { key: "gateway_order_id", header: "Gateway order", type: "text", excel: 26, pdf: 2.8 },
      { key: "gateway_payment_id", header: "Gateway payment", type: "text", excel: 26, pdf: 2.8 },
      { key: "payment_status", header: "Payment status", type: "status", excel: 18, pdf: 2.2 },
      { key: "created_at", header: "Created (IST)", type: "datetime", excel: 20, pdf: 2.6 },
      { key: "paid_at", header: "Completed (IST)", type: "datetime", excel: 20, pdf: 2.6 },
      { key: "membership_state", header: "Membership activation", type: "status", excel: 20, pdf: 2.2 },
    ],
    filters: ["from", "to", "status", "gateway"],
    dateLabel: "Payment created date",
    statuses: ["created", "pending", "processing", "success", "failed", "expired", "refunded", "partially_refunded"],
  },
  bookings: {
    title: "Bookings",
    sheet: "Bookings",
    columns: [
      { key: "booking_id", header: "Booking ID", type: "id", excel: 38, pdf: 2.8 },
      ...personColumns,
      { key: "plan_name", header: "Membership type", type: "text", excel: 20, pdf: 2.4 },
      { key: "session_date", header: "Class date", type: "date", excel: 14, pdf: 2.2 },
      { key: "weekday", header: "Weekday", type: "text", excel: 12, pdf: 1.7 },
      { key: "start_time", header: "Start", type: "time", excel: 11, pdf: 1.6 },
      { key: "end_time", header: "End", type: "time", excel: 11, pdf: 1.6 },
      { key: "booking_status", header: "Booking status", type: "status", excel: 16, pdf: 2 },
      { key: "attendance_status", header: "Attendance", type: "status", excel: 14, pdf: 1.8 },
      { key: "reschedule_count", header: "Reschedules", type: "int", excel: 12, pdf: 1.4 },
      { key: "booking_source", header: "Booked via", type: "text", excel: 17, pdf: 2 },
      { key: "recurring_schedule_id", header: "Weekly schedule ref.", type: "id", excel: 38, pdf: 2.8 },
    ],
    filters: ["from", "to", "status", "plan"],
    dateLabel: "Class date",
    statuses: ["held", "confirmed", "cancelled", "completed", "no_show", "expired", "absent", "rescheduled"],
  },
};

export const REPORT_KEYS = Object.keys(REPORTS);
export const COMBINED_KEYS = ["members", "memberships", "payments", "bookings"];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_OR_GATEWAY = /^[A-Za-z0-9_-]{1,40}$/;

export class ExportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Keeps only the filters a report understands, trims them, and refuses nonsense before anything is requested. */
export function normaliseFilters(key, raw = {}) {
  const spec = REPORTS[key];
  if (!spec) throw new ExportError("INVALID_REPORT", "That report doesn't exist.");
  const out = {};
  for (const name of spec.filters) {
    const v = raw[name] == null ? "" : String(raw[name]).trim();
    if (!v) continue;
    if ((name === "from" || name === "to") && !ISO_DATE.test(v)) throw new ExportError("INVALID_DATE", "Dates must look like 2026-10-21.");
    if (name === "status" && !spec.statuses.includes(v)) throw new ExportError("INVALID_STATUS", "That status isn't valid for this report.");
    if ((name === "plan" || name === "gateway") && !PLAN_OR_GATEWAY.test(v)) throw new ExportError("INVALID_FILTER", "That filter value isn't valid.");
    out[name] = v;
  }
  if (out.from && out.to && out.from > out.to) throw new ExportError("INVALID_DATE_RANGE", "The start date is after the end date.");
  return out;
}

/** The filters of a combined report: the date range and plan apply where they make sense; statuses do not. */
export function combinedFilters(raw = {}) {
  const f = {};
  for (const name of ["from", "to", "plan"]) {
    const v = raw[name] == null ? "" : String(raw[name]).trim();
    if (v) f[name] = v;
  }
  return f;
}

const rpcName = { members: "reportMembers", memberships: "reportMemberships", payments: "reportPayments", bookings: "reportBookings" };

/**
 * Fetches EVERY row of a report that matches the filters, one page at a time (the database caps a page at 500).
 * Stops with TOO_LARGE before downloading anything big. Rows come back without the paging helper column.
 */
export async function fetchReportRows(key, filters, { api = adminApi, onProgress, signal, pageSize = PAGE_SIZE, maxRows = MAX_ROWS } = {}) {
  const f = normaliseFilters(key, filters);
  const rows = [];
  let total = null;
  for (let offset = 0; ; offset += pageSize) {
    if (signal?.aborted) throw new ExportError("ABORTED", "The export was cancelled.");
    const { data, error } = await api[rpcName[key]](f, offset, pageSize);
    if (error) throw new ExportError("DATABASE", error);
    const page = data ?? [];
    if (total === null) {
      total = page.length ? Number(page[0].total_count) : 0;
      if (total > maxRows) {
        throw new ExportError("TOO_LARGE", `This report has ${total.toLocaleString("en-IN")} rows. Narrow it with filters to ${maxRows.toLocaleString("en-IN")} or fewer.`);
      }
    }
    for (const row of page) {
      const rest = { ...row };
      delete rest.total_count;
      rows.push(rest);
    }
    onProgress?.({ key, loaded: rows.length, total });
    if (page.length < pageSize || rows.length >= total) break;
  }
  return { rows, total: total ?? 0 };
}

/** Builds the data set for one report or all four. Payments always carry the revenue summary. */
export async function collectReports(kind, rawFilters, opts = {}) {
  const api = opts.api ?? adminApi;
  const keys = kind === "combined" ? COMBINED_KEYS : [kind];
  const filtersFor = (k) => (kind === "combined" ? normaliseFilters(k, combinedFilters(rawFilters)) : normaliseFilters(k, rawFilters));
  const sections = [];
  for (const key of keys) {
    const filters = filtersFor(key);
    const { rows } = await fetchReportRows(key, filters, opts);
    let summary = null;
    if (key === "payments") {
      const res = await api.reportSummary("payments", filters);
      if (res.error) throw new ExportError("DATABASE", res.error);
      summary = res.data;
    }
    sections.push({ key, spec: REPORTS[key], filters, rows, summary });
  }
  return sections;
}
