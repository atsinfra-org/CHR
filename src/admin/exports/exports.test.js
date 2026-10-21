import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { formatDate, formatDateTime, formatMoney, formatTime, pdfSafe, sheetSafe, statusLabel, fileName, shortId, excelDateTime } from "./format";
import { COMBINED_KEYS, REPORTS, collectReports, combinedFilters, fetchReportRows, normaliseFilters, ExportError } from "./reports";
import { buildWorkbook, cellFor, paymentSummaryLines, workbookBlob } from "./excel";
import { buildPdf, columnWidths, pdfCell } from "./pdf";
import { runExport, exportErrorMessage } from "./runExport";

const here = path.dirname(fileURLToPath(import.meta.url));
const fonts = {
  regular: fs.readFileSync(path.join(here, "fonts/NotoSans-Regular.subset.ttf")).toString("base64"),
  bold: fs.readFileSync(path.join(here, "fonts/NotoSans-Bold.subset.ttf")).toString("base64"),
};

const uuid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const people = (i) => ({ full_name: `Rider ${i}`, phone: i % 2 ? `+9198000${String(i).padStart(5, "0")}` : null, email: `rider${i}@example.org` });

const memberRow = (i, o = {}) => ({ member_id: uuid(i), ...people(i), registered_at: "2026-10-10T18:45:00Z", plan_name: "Gold Membership", membership_status: "active", start_date: "2026-10-11", end_date: "2026-11-09", ...o });
const membershipRow = (i, o = {}) => ({ membership_id: uuid(i), member_id: uuid(i), ...people(i), plan_name: "Platinum Membership", plan_price: 18000, currency: "INR", total_credits: 15, credits_used: 4, credits_remaining: 11, purchased_at: "2026-10-18T05:00:00Z", start_date: "2026-10-18", end_date: "2026-11-16", membership_status: "active", payment_status: "success", payment_amount: 18500, ...o });
const paymentRow = (i, o = {}) => ({ payment_id: uuid(i), member_id: uuid(i), ...people(i), items: "Platinum Membership; Gloves x2", amount: 18500, currency: "INR", gateway: "razorpay", gateway_order_id: `order_${i}`, gateway_payment_id: `pay_${i}`, payment_status: "success", created_at: "2026-10-18T05:00:00Z", paid_at: "2026-10-18T05:01:00Z", membership_state: "active", ...o });
const bookingRow = (i, o = {}) => ({ booking_id: uuid(i), member_id: uuid(i), ...people(i), plan_name: "Platinum Membership", session_date: "2026-10-21", weekday: "Wednesday", start_time: "17:00:00", end_time: "18:00:00", booking_status: "confirmed", attendance_status: null, reschedule_count: 1, recurring_schedule_id: null, booking_source: "Single booking", ...o });

/** A fake of the admin API: pages over fixed arrays like the database functions do, and records every call. */
function fakeApi(data, { summary, fail } = {}) {
  const calls = [];
  const page = (key) => async (f, offset, limit) => {
    calls.push({ key, f, offset, limit });
    if (fail === key) return { data: null, error: "Something went wrong. Please try again." };
    const all = data[key] ?? [];
    return { data: all.slice(offset, offset + limit).map((r) => ({ ...r, total_count: all.length })), error: null };
  };
  return {
    calls, logs: [],
    reportMembers: page("members"), reportMemberships: page("memberships"), reportPayments: page("payments"), reportBookings: page("bookings"),
    reportSummary: async (report, f) => { calls.push({ key: `summary:${report}`, f }); return { data: summary ?? { total: (data[report] ?? []).length }, error: null }; },
    logExport(...args) { this.logs.push(args); return Promise.resolve({ data: null, error: null }); },
  };
}

const PAY_SUMMARY = {
  total: 7, by_status: { success: { count: 2, amount: 21500 }, failed: { count: 1, amount: 3000 }, pending: { count: 1, amount: 3000 }, refunded: { count: 1, amount: 5000 }, partially_refunded: { count: 1, amount: 2000 }, created: { count: 1, amount: 111 } },
  successful_revenue: { count: 2, amount: 21500 }, refunded_original_amount: { count: 1, amount: 5000 }, partially_refunded_original_amount: { count: 1, amount: 2000 },
};

describe("formatting", () => {
  it("labels statuses consistently and leaves empty values empty", () => {
    expect(statusLabel("partially_refunded")).toBe("Partially refunded");
    expect(statusLabel("pending_payment")).toBe("Pending payment");
    expect(statusLabel("no_show")).toBe("No show");
    expect(statusLabel("none")).toBe("No membership");
    expect(statusLabel("success")).toBe("Success");
    expect(statusLabel(null)).toBe("");
    expect(statusLabel("")).toBe("");
  });
  it("shows rupees with Indian grouping and never converts units", () => {
    expect(formatMoney(15000)).toBe("₹15,000.00");
    expect(formatMoney(150000)).toBe("₹1,50,000.00");
    expect(formatMoney("18500.50", "INR")).toBe("₹18,500.50");
    expect(formatMoney(5, "USD")).toBe("USD 5.00");
    expect(formatMoney(null)).toBe("");
    expect(formatMoney(30)).toBe("₹30.00"); // 30 rupees stays 30, not 0.30 or 3000
  });
  it("uses India time for dates and times", () => {
    expect(formatDate("2026-10-21")).toBe("21 Oct 2026");
    expect(formatDateTime("2026-10-20T18:45:00Z")).toBe("21 Oct 2026, 00:15");
    expect(formatDateTime("2026-10-21T05:00:00Z")).toBe("21 Oct 2026, 10:30");
    expect(formatTime("17:00:00")).toBe("5:00 PM");
    expect(formatTime("00:30:00")).toBe("12:30 AM");
    expect(formatDate(null)).toBe("");
    expect(formatDateTime("garbage")).toBe("");
    expect(shortId("abcdef12-3456")).toBe("ABCDEF12");
  });
  it("makes the file name from the IST date", () => {
    expect(fileName("payments", "xlsx", new Date("2026-10-20T20:00:00Z"))).toBe("chr-payments-2026-10-21.xlsx");
    expect(fileName("combined", "pdf", new Date("2026-10-21T05:00:00Z"))).toBe("chr-combined-report-2026-10-21.pdf");
  });
});

describe("spreadsheet formula-injection protection", () => {
  it("neutralises text that could start a formula, with a leading apostrophe", () => {
    for (const bad of ['=HYPERLINK("http://evil","x")', "=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1:A9)", "  =1+1", "\t=1+1", "\r=1+1", "=cmd|' /C calc'!A0", "+SUM(1,2)", "-@x"]) {
      expect(sheetSafe(bad), bad).toBe(`'${bad}`);
    }
  });
  it("leaves ordinary text, phone numbers and numbers untouched", () => {
    for (const ok of ["Asha Rao", "O'Brien & Sons", "+91 98000 00001", "+919800000001", "98000-00001", "(022) 555 0101", "-5", "12.50", "a=b", "x+y", "email@example.org", ""]) {
      expect(sheetSafe(ok), ok).toBe(ok);
    }
    expect(sheetSafe(null)).toBeNull();
    expect(sheetSafe(42)).toBe(42);
  });
  it("applies to the exported text of every user-typed column but not to the stored row", () => {
    const row = memberRow(1, { full_name: "=1+1", email: "@evil", plan_name: "+x" });
    const before = JSON.stringify(row);
    expect(cellFor(REPORTS.members.columns[1], row).value).toBe("'=1+1");
    expect(cellFor(REPORTS.members.columns[3], row).value).toBe("'@evil");
    expect(cellFor(REPORTS.members.columns[5], row).value).toBe("'+x");
    expect(JSON.stringify(row)).toBe(before);
  });
  it("PDF text is made safe for the embedded font", () => {
    expect(pdfSafe("Asha ₹500 – ok")).toBe("Asha ₹500 – ok");
    expect(pdfSafe("अनु Rao")).toBe("??? Rao");
    expect(pdfSafe("a\nb\tc")).toBe("a b c");
    expect(pdfSafe(null)).toBe("");
  });
});

describe("filters and paging", () => {
  it("keeps only the filters a report understands and refuses nonsense", () => {
    expect(normaliseFilters("payments", { from: "2026-10-01", status: "failed", plan: "GOLD", junk: "x" })).toEqual({ from: "2026-10-01", status: "failed" });
    expect(normaliseFilters("bookings", { status: "confirmed", plan: "GOLD", gateway: "razorpay" })).toEqual({ status: "confirmed", plan: "GOLD" });
    expect(() => normaliseFilters("payments", { status: "paid" })).toThrow(/status/i);
    expect(() => normaliseFilters("bookings", { status: "success" })).toThrow(/status/i);
    expect(() => normaliseFilters("payments", { from: "21/10/2026" })).toThrow(/Dates/);
    expect(() => normaliseFilters("payments", { from: "2026-10-02", to: "2026-10-01" })).toThrow(/start date is after/);
    expect(() => normaliseFilters("members", { plan: "GOLD; drop table x" })).toThrow(/filter/);
    expect(() => normaliseFilters("nope", {})).toThrow(ExportError);
    expect(normaliseFilters("members", { from: "  ", status: "" })).toEqual({});
  });
  it("the real statuses are exactly the database's", () => {
    expect(REPORTS.payments.statuses).toEqual(["created", "pending", "processing", "success", "failed", "expired", "refunded", "partially_refunded"]);
    expect(REPORTS.bookings.statuses).toEqual(["held", "confirmed", "cancelled", "completed", "no_show", "expired", "absent", "rescheduled"]);
    expect(REPORTS.memberships.statuses).toEqual(["pending_payment", "active", "expired", "cancelled", "suspended"]);
  });
  it("combined reports take the date range and plan only", () => {
    expect(combinedFilters({ from: "2026-10-01", to: "2026-10-31", plan: "GOLD", status: "failed", gateway: "razorpay" })).toEqual({ from: "2026-10-01", to: "2026-10-31", plan: "GOLD" });
  });
  it("loads every page, in order, with no duplicates, and strips the paging column", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => paymentRow(i + 1));
    const api = fakeApi({ payments: rows });
    const progress = [];
    const out = await fetchReportRows("payments", { status: "success" }, { api, pageSize: 3, onProgress: (p) => progress.push(p.loaded) });
    expect(out.total).toBe(8);
    expect(out.rows.map((r) => r.payment_id)).toEqual(rows.map((r) => r.payment_id));
    expect(new Set(out.rows.map((r) => r.payment_id)).size).toBe(8);
    expect(out.rows.every((r) => !("total_count" in r))).toBe(true);
    expect(api.calls.map((c) => [c.offset, c.limit])).toEqual([[0, 3], [3, 3], [6, 3]]);
    expect(api.calls[0].f).toEqual({ status: "success" });
    expect(progress).toEqual([3, 6, 8]);
  });
  it("handles an empty dataset and a single short page", async () => {
    expect((await fetchReportRows("members", {}, { api: fakeApi({ members: [] }) })).rows).toEqual([]);
    const one = await fetchReportRows("members", {}, { api: fakeApi({ members: [memberRow(1)] }), pageSize: 500 });
    expect(one.rows).toHaveLength(1);
  });
  it("stops before loading a huge report, cancels, and words database errors", async () => {
    const big = fakeApi({ payments: Array.from({ length: 12 }, (_, i) => paymentRow(i + 1)) });
    await expect(fetchReportRows("payments", {}, { api: big, maxRows: 10 })).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(big.calls).toHaveLength(1); // only the first page was fetched
    await expect(fetchReportRows("payments", {}, { api: fakeApi({}), signal: { aborted: true } })).rejects.toMatchObject({ code: "ABORTED" });
    await expect(fetchReportRows("payments", {}, { api: fakeApi({}, { fail: "payments" }) })).rejects.toMatchObject({ code: "DATABASE" });
    expect(exportErrorMessage(new Error("socket hang up /secret/path"))).toBe("The file could not be created. Please try again.");
    expect(exportErrorMessage(new ExportError("TOO_LARGE", "Narrow it."))).toBe("Narrow it.");
  });
  it("a combined report is four reports in a fixed order, and payments carry the revenue summary", async () => {
    const api = fakeApi({ members: [memberRow(1)], memberships: [membershipRow(1)], payments: [paymentRow(1)], bookings: [bookingRow(1)] }, { summary: PAY_SUMMARY });
    const sections = await collectReports("combined", { from: "2026-10-01", status: "failed" }, { api });
    expect(sections.map((s) => s.key)).toEqual(COMBINED_KEYS);
    expect(sections.map((s) => s.spec.sheet)).toEqual(["Members", "Memberships", "Payments", "Bookings"]);
    expect(sections[2].summary.successful_revenue.amount).toBe(21500);
    expect(api.calls.filter((c) => !c.key.startsWith("summary")).every((c) => !c.f.status)).toBe(true);
  });
});

describe("Excel", () => {
  const data = {
    members: [memberRow(1), memberRow(2, { full_name: '=HYPERLINK("http://evil","click")', phone: "+919800000002", membership_status: null, plan_name: null, start_date: null, end_date: null })],
    memberships: [membershipRow(1), membershipRow(2, { plan_name: "Gold Membership", plan_price: 15000, total_credits: 8, credits_used: 0, credits_remaining: 8, payment_status: null, payment_amount: null })],
    payments: [paymentRow(1), paymentRow(2, { payment_status: "failed", amount: 3000, paid_at: null, membership_state: null, items: "Gold Membership" }), paymentRow(3, { payment_status: "partially_refunded", amount: 2000 })],
    bookings: [bookingRow(1), bookingRow(2, { booking_source: "Weekly schedule", recurring_schedule_id: uuid(9), attendance_status: "present", booking_status: "completed" })],
  };
  const build = async (d = data, summary = PAY_SUMMARY) => {
    const sections = await collectReports("combined", {}, { api: fakeApi(d, { summary }) });
    const wb = await buildWorkbook({ sections, generatedAt: new Date("2026-10-21T05:00:00Z") });
    const blob = await workbookBlob(wb);
    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(await blob.arrayBuffer());
    return { loaded, blob, sections };
  };
  const headerRowOf = (ws) => { let found = 0; ws.eachRow((row, n) => { if (!found && row.getCell(1).value && /ID$/.test(String(row.getCell(1).value))) found = n; }); return found; };

  it("creates a real .xlsx with the four named worksheets", async () => {
    const { loaded, blob } = await build();
    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(blob.size).toBeGreaterThan(2000);
    expect(loaded.worksheets.map((w) => w.name)).toEqual(["Members", "Memberships", "Payments", "Bookings"]);
  });
  it("has a title, a generation timestamp, the filters, frozen filterable headers and readable widths", async () => {
    const { loaded } = await build();
    for (const ws of loaded.worksheets) {
      const h = headerRowOf(ws);
      expect(h).toBeGreaterThan(3);
      expect(String(ws.getRow(1).getCell(1).value)).toContain("Colonel Horse Riding Club");
      expect(String(ws.getRow(2).getCell(1).value)).toContain("Generated 21 Oct 2026, 10:30 IST");
      expect(String(ws.getRow(3).getCell(1).value)).toBe("Filters: None (all records)");
      expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: h });
      expect(ws.autoFilter).toBeTruthy();
      expect(ws.getColumn(1).width).toBeGreaterThanOrEqual(10);
    }
  });
  it("uses exactly the report's column headers", async () => {
    const { loaded } = await build();
    for (const key of COMBINED_KEYS) {
      const ws = loaded.getWorksheet(REPORTS[key].sheet);
      const h = headerRowOf(ws);
      expect(ws.getRow(h).values.slice(1)).toEqual(REPORTS[key].columns.map((c) => c.header));
    }
  });
  it("membership prices, entitlements and credit balances are exactly the database values", async () => {
    const { loaded } = await build();
    const ws = loaded.getWorksheet("Memberships");
    const h = headerRowOf(ws);
    const col = (name) => REPORTS.memberships.columns.findIndex((c) => c.header === name) + 1;
    const r1 = ws.getRow(h + 1), r2 = ws.getRow(h + 2);
    expect(r1.getCell(col("Plan price")).value).toBe(18000);
    expect(r1.getCell(col("Total classes")).value).toBe(15);
    expect(r1.getCell(col("Classes used")).value).toBe(4);
    expect(r1.getCell(col("Classes remaining")).value).toBe(11);
    expect(r2.getCell(col("Plan price")).value).toBe(15000);
    expect(r2.getCell(col("Classes remaining")).value).toBe(8);
    expect(r1.getCell(col("Plan price")).numFmt).toContain("₹");
    expect(r1.getCell(col("Payment status")).value).toBe("Success");
    expect(r2.getCell(col("Payment status")).value).toBeNull(); // no linked payment: blank, not invented
    expect(r1.getCell(col("Payment amount")).value).toBe(18500);
  });
  it("shows real payment statuses, amounts in INR, dates as dates, and blanks for missing values", async () => {
    const { loaded } = await build();
    const ws = loaded.getWorksheet("Payments");
    const h = headerRowOf(ws);
    const col = (name) => REPORTS.payments.columns.findIndex((c) => c.header === name) + 1;
    expect(ws.getRow(h + 1).getCell(col("Payment status")).value).toBe("Success");
    expect(ws.getRow(h + 2).getCell(col("Payment status")).value).toBe("Failed");
    expect(ws.getRow(h + 3).getCell(col("Payment status")).value).toBe("Partially refunded");
    expect(ws.getRow(h + 2).getCell(col("Amount")).value).toBe(3000);
    expect(ws.getRow(h + 2).getCell(col("Completed (IST)")).value).toBeNull();
    expect(ws.getRow(h + 2).getCell(col("Membership activation")).value).toBeNull();
    const created = ws.getRow(h + 1).getCell(col("Created (IST)"));
    expect(created.value).toBeInstanceOf(Date);
    expect(created.numFmt).toBe("dd-mmm-yyyy hh:mm");
    expect(created.value.toISOString()).toBe("2026-10-18T10:30:00.000Z"); // 05:00 UTC shown as 10:30 IST
  });
  it("lists revenue (Success only) and refunds separately above the payments table", async () => {
    const { loaded } = await build();
    const ws = loaded.getWorksheet("Payments");
    const text = [4, 5, 6, 7, 8].map((n) => String(ws.getRow(n).getCell(1).value));
    expect(text[0]).toBe("Successful revenue (status Success only): ₹21,500.00 (2 payments)");
    expect(text[1]).toContain("Refunded (original payment amount, not revenue): ₹5,000.00");
    expect(text[2]).toContain("Partially refunded (original payment amount, not revenue): ₹2,000.00");
    expect(text[3]).toContain("Failed 1");
    expect(text[4]).toContain("nothing is netted off");
    expect(paymentSummaryLines(null)).toEqual([]);
  });
  it("protects against formula injection in the file, and keeps phones intact", async () => {
    const { loaded } = await build();
    const ws = loaded.getWorksheet("Members");
    const h = headerRowOf(ws);
    const evil = ws.getRow(h + 2).getCell(2);
    expect(evil.value).toBe('\'=HYPERLINK("http://evil","click")');
    expect(evil.type).not.toBe(ExcelJS.ValueType.Formula);
    expect(evil.formula).toBeUndefined();
    expect(ws.getRow(h + 2).getCell(3).value).toBe("+919800000002");
    // no cell anywhere in the workbook is a formula
    for (const sheet of loaded.worksheets) sheet.eachRow((row) => row.eachCell((cell) => expect(cell.type).not.toBe(ExcelJS.ValueType.Formula)));
  });
  it("one row per record: no duplicates, and the bookings report separates schedule bookings", async () => {
    const { loaded } = await build();
    for (const key of COMBINED_KEYS) {
      const ws = loaded.getWorksheet(REPORTS[key].sheet);
      const h = headerRowOf(ws);
      const ids = [];
      ws.eachRow((row, n) => { if (n > h) ids.push(row.getCell(1).value); });
      expect(ids).toHaveLength(data[key].length);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const ws = loaded.getWorksheet("Bookings");
    const h = headerRowOf(ws);
    const col = (name) => REPORTS.bookings.columns.findIndex((c) => c.header === name) + 1;
    expect(ws.getRow(h + 1).getCell(col("Booked via")).value).toBe("Single booking");
    expect(ws.getRow(h + 1).getCell(col("Weekly schedule ref.")).value).toBeNull();
    expect(ws.getRow(h + 2).getCell(col("Booked via")).value).toBe("Weekly schedule");
    expect(ws.getRow(h + 2).getCell(col("Weekly schedule ref.")).value).toBe(uuid(9));
    expect(ws.getRow(h + 1).getCell(col("Start")).numFmt).toBe("h:mm AM/PM");
    expect(REPORTS.bookings.columns.some((c) => /horse/i.test(c.header + c.key))).toBe(false);
  });
  it("an empty dataset still produces a valid sheet with a clear note", async () => {
    const { loaded } = await build({ members: [], memberships: [], payments: [], bookings: [] }, { total: 0, by_status: {}, successful_revenue: { count: 0, amount: 0 }, refunded_original_amount: { count: 0, amount: 0 }, partially_refunded_original_amount: { count: 0, amount: 0 } });
    for (const ws of loaded.worksheets) {
      const h = headerRowOf(ws);
      expect(String(ws.getRow(h + 1).getCell(1).value)).toBe("No records match these filters.");
      expect(String(ws.getRow(2).getCell(1).value)).toContain("0 records");
    }
  });
  it("a single report exports as one sheet and names the applied filters", async () => {
    const api = fakeApi({ payments: [paymentRow(2, { payment_status: "failed" })] }, { summary: PAY_SUMMARY });
    const sections = await collectReports("payments", { status: "failed", from: "2026-10-01" }, { api });
    const wb = await buildWorkbook({ sections, generatedAt: new Date("2026-10-21T05:00:00Z") });
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Payments"]);
    expect(String(wb.getWorksheet("Payments").getRow(3).getCell(1).value)).toBe("Filters: Payment created date from: 01 Oct 2026  |  Status: Failed");
    expect(api.calls.find((c) => c.key === "payments").f).toEqual({ from: "2026-10-01", status: "failed" });
  });
  it("converts IST wall-clock times for Excel without drifting dates", () => {
    expect(excelDateTime("2026-10-20T18:45:00Z").toISOString()).toBe("2026-10-21T00:15:00.000Z");
    expect(cellFor(REPORTS.bookings.columns.find((c) => c.key === "session_date"), { session_date: "2026-10-21" }).value.toISOString()).toBe("2026-10-21T00:00:00.000Z");
  });
});

// ─── PDF ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function readPdf(doc) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = new Uint8Array(doc.output("arraybuffer"));
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p += 1) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({ width: vp.width, height: vp.height, items: content.items.filter((i) => i.str.trim() !== ""), text: content.items.map((i) => i.str).join(" ") });
  }
  return { numPages: pdf.numPages, pages, bytes };
}

describe("PDF", () => {
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i + 1));
  const bigData = {
    members: many(150, (i) => memberRow(i, { full_name: `Member Token${String(i).padStart(4, "0")}` })),
    memberships: many(60, (i) => membershipRow(i, { full_name: `Holder Token${String(i).padStart(4, "0")}` })),
    payments: many(120, (i) => paymentRow(i, { full_name: `Payer Token${String(i).padStart(4, "0")}`, amount: i === 1 ? 18500 : 3000 + i })),
    bookings: many(90, (i) => bookingRow(i, { full_name: `Booker Token${String(i).padStart(4, "0")}` })),
  };
  const make = async (kind, d = bigData, filters = {}) => {
    const sections = await collectReports(kind, filters, { api: fakeApi(d, { summary: PAY_SUMMARY }) });
    const doc = await buildPdf({ sections, generatedAt: new Date("2026-10-21T05:00:00Z"), fonts });
    return { doc, sections, pdf: await readPdf(doc) };
  };

  it("produces a valid PDF with real, searchable text (not an image)", async () => {
    const { pdf } = await make("payments");
    expect(Buffer.from(pdf.bytes.slice(0, 5)).toString()).toBe("%PDF-");
    expect(pdf.numPages).toBeGreaterThan(1);
    expect(pdf.pages[0].text).toContain("Payment Follow-Up");
    expect(pdf.pages[0].text).toContain("Payer Token0001");
  });
  it("is landscape A4 and shows branding, title, generation time and filters on the first page", async () => {
    const { pdf } = await make("payments", bigData, { status: "success", from: "2026-10-01" });
    const p1 = pdf.pages[0];
    expect(Math.round(p1.width)).toBe(842);
    expect(Math.round(p1.height)).toBe(595);
    expect(p1.text).toContain("Colonel Horse Riding Club");
    expect(p1.text).toContain("Generated 21 Oct 2026, 10:30 IST");
    expect(p1.text).toContain("Filters: Payment created date from: 01 Oct 2026 | Status: Success");
  });
  it("numbers every page 'Page x of y' and repeats the table header on every page of a table", async () => {
    const { pdf } = await make("payments");
    pdf.pages.forEach((p, i) => {
      expect(p.text).toContain(`Page ${i + 1} of ${pdf.numPages}`);
      expect(p.text).toContain("Payment status"); // the column header, repeated
      expect(p.text).toContain("Gateway order");
    });
  });
  it("includes every record exactly once across pages (nothing dropped, nothing duplicated)", async () => {
    const { pdf } = await make("payments");
    const all = pdf.pages.map((p) => p.text).join(" ");
    for (let i = 1; i <= 120; i += 1) {
      const token = `Token${String(i).padStart(4, "0")}`;
      expect(all.split(token).length - 1, token).toBe(1);
    }
  });
  it("keeps every text item inside the page, even for the widest table (no clipped columns)", async () => {
    const { pdf } = await make("memberships");
    for (const page of pdf.pages) {
      for (const item of page.items) {
        const x = item.transform[4];
        expect(x, item.str).toBeGreaterThanOrEqual(0);
        expect(x + item.width, item.str).toBeLessThanOrEqual(page.width - 5);
      }
    }
    expect(pdf.pages[0].text).toContain("Classes remaining");
    expect(pdf.pages[0].text).toContain("Payment amount");
  });
  it("renders the rupee sign and amounts, and the extracted text maps the glyph back to ₹", async () => {
    const { pdf } = await make("payments");
    const all = pdf.pages.map((p) => p.text).join(" ");
    expect(all).toContain("₹18,500.00");
    expect(all).toContain("Successful revenue (status Success only): ₹21,500.00 (2 payments)");
    expect(all).not.toMatch(/�/);
  });
  it("embeds the font that contains the rupee sign (a glyph exists, not just a text mapping)", async () => {
    const { pdf } = await make("payments");
    const raw = Buffer.from(pdf.bytes).toString("latin1");
    expect(raw).toMatch(/\/FontFile2/);
    expect(raw).toMatch(/\/ToUnicode/);
    expect(raw).toMatch(/NotoSans/);
  });
  it("the font subset itself covers the rupee sign", () => {
    // TrueType 'cmap' format-4 lookup for U+20B9 in the bundled subset
    const buf = fs.readFileSync(path.join(here, "fonts/NotoSans-Regular.subset.ttf"));
    const numTables = buf.readUInt16BE(4);
    let cmap = 0;
    for (let i = 0; i < numTables; i += 1) { const o = 12 + i * 16; if (buf.toString("latin1", o, o + 4) === "cmap") cmap = buf.readUInt32BE(o + 8); }
    expect(cmap).toBeGreaterThan(0);
    const n = buf.readUInt16BE(cmap + 2);
    let sub = 0;
    for (let i = 0; i < n; i += 1) { const o = cmap + 4 + i * 8; const platform = buf.readUInt16BE(o), enc = buf.readUInt16BE(o + 2); if ((platform === 3 && (enc === 10 || enc === 1)) || platform === 0) { sub = cmap + buf.readUInt32BE(o + 4); if (platform === 3 && enc === 10) break; } }
    const format = buf.readUInt16BE(sub);
    const lookup = (cp) => {
      if (format === 4) {
        const segX2 = buf.readUInt16BE(sub + 6);
        const ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, rangeOffs = deltas + segX2;
        for (let s = 0; s < segX2 / 2; s += 1) {
          if (cp <= buf.readUInt16BE(ends + s * 2)) {
            const start = buf.readUInt16BE(starts + s * 2);
            if (cp < start) return 0;
            const ro = buf.readUInt16BE(rangeOffs + s * 2);
            if (ro === 0) return (cp + buf.readInt16BE(deltas + s * 2)) & 0xffff;
            const g = buf.readUInt16BE(rangeOffs + s * 2 + ro + (cp - start) * 2);
            return g === 0 ? 0 : (g + buf.readInt16BE(deltas + s * 2)) & 0xffff;
          }
        }
        return 0;
      }
      if (format === 12) {
        const groups = buf.readUInt32BE(sub + 12);
        for (let g = 0; g < groups; g += 1) { const o = sub + 16 + g * 12; const s = buf.readUInt32BE(o), e = buf.readUInt32BE(o + 4); if (cp >= s && cp <= e) return buf.readUInt32BE(o + 8) + (cp - s); }
      }
      return 0;
    };
    expect(lookup(0x20b9), "glyph for ₹").toBeGreaterThan(0);
    expect(lookup(0x41), "glyph for A").toBeGreaterThan(0);
  });
  it("the combined PDF has four clearly separated sections, each starting on its own page", async () => {
    const { pdf, sections } = await make("combined");
    expect(sections.map((s) => s.spec.title)).toEqual(["Member Registrations", "Memberships", "Payment Follow-Up", "Bookings"]);
    const firstPageOf = (title) => pdf.pages.findIndex((p) => p.items.some((i) => i.str === title && i.transform[5] > p.height - 60));
    const starts = ["Member Registrations", "Memberships", "Payment Follow-Up", "Bookings"].map(firstPageOf);
    expect(starts.every((n) => n >= 0)).toBe(true);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(new Set(starts).size).toBe(4);
    expect(starts[0]).toBe(0);
    // each section starts on a fresh page: the combined page count is exactly the sum of the four separate reports
    const separate = [];
    for (const key of COMBINED_KEYS) separate.push((await make(key)).pdf.numPages);
    expect(pdf.numPages).toBe(separate.reduce((x, y) => x + y, 0));
    expect(starts).toEqual([0, separate[0], separate[0] + separate[1], separate[0] + separate[1] + separate[2]]);
  });
  it("an empty report prints a clear message instead of an empty table", async () => {
    const { pdf } = await make("members", { members: [] });
    expect(pdf.numPages).toBe(1);
    expect(pdf.pages[0].text).toContain("No records match these filters.");
    expect(pdf.pages[0].text).toContain("0 records");
  });
  it("shows shortened identifiers and says so", async () => {
    const { pdf } = await make("bookings");
    expect(pdf.pages[0].text).toContain("00000001");
    expect(pdf.pages[0].text).toContain("Identifiers are shortened");
  });
  it("cell text and column widths", () => {
    expect(pdfCell({ key: "amount", type: "money" }, { amount: 18500, currency: "INR" })).toBe("₹18,500.00");
    expect(pdfCell({ key: "x", type: "status" }, { x: "partially_refunded" })).toBe("Partially refunded");
    expect(pdfCell({ key: "x", type: "text" }, { x: null })).toBe("");
    const w = columnWidths(REPORTS.memberships.columns, 277);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(277, 5);
    expect(Math.min(...w)).toBeGreaterThan(8);
  });
});

describe("running an export", () => {
  const api = () => fakeApi({ members: [memberRow(1)], memberships: [membershipRow(1)], payments: [paymentRow(1)], bookings: [bookingRow(1)] }, { summary: PAY_SUMMARY });
  const loaders = { fonts: async () => fonts, logo: async () => null };

  it("creates an Excel file and records metadata only", async () => {
    const a = api();
    const out = await runExport({ kind: "payments", format: "xlsx", filters: { status: "success", email: "a@b.org" }, api: a, loaders });
    expect(out.blob.size).toBeGreaterThan(1000);
    expect(out.filename).toMatch(/^chr-payments-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(a.logs).toEqual([["payments", "xlsx", { status: "success" }, 1, "success"]]);
  });
  it("creates a PDF and a combined PDF", async () => {
    const a = api();
    const one = await runExport({ kind: "bookings", format: "pdf", filters: {}, api: a, loaders });
    expect(one.blob.type).toBe("application/pdf");
    const all = await runExport({ kind: "combined", format: "pdf", filters: { status: "failed", from: "2026-10-01" }, api: a, loaders });
    expect(all.filename).toMatch(/^chr-combined-report-/);
    expect(a.logs.at(-1)).toEqual(["combined", "pdf", { from: "2026-10-01" }, 4, "success"]);
  });
  it("records a failure (without contents) and rethrows; a failed audit write never hides the real error", async () => {
    const a = fakeApi({}, { fail: "payments" });
    await expect(runExport({ kind: "payments", format: "xlsx", filters: {}, api: a, loaders })).rejects.toMatchObject({ code: "DATABASE" });
    expect(a.logs).toEqual([["payments", "xlsx", {}, 0, "failure"]]);
    const b = fakeApi({}, { fail: "payments" });
    b.logExport = () => Promise.reject(new Error("audit down"));
    await expect(runExport({ kind: "payments", format: "pdf", filters: {}, api: b, loaders })).rejects.toMatchObject({ code: "DATABASE" });
  });
  it("refuses bad filters or formats before fetching anything", async () => {
    const a = api();
    await expect(runExport({ kind: "payments", format: "xlsx", filters: { status: "paid" }, api: a, loaders })).rejects.toThrow(/status/i);
    await expect(runExport({ kind: "payments", format: "csv", filters: {}, api: a, loaders })).rejects.toMatchObject({ code: "INVALID_FORMAT" });
    expect(a.calls.filter((c) => !String(c.key).startsWith("summary"))).toHaveLength(1); // only the csv attempt fetched, never the bad-filter one
  });
  it("is read-only: it only ever calls report functions and the audit writer", async () => {
    const a = api();
    await runExport({ kind: "combined", format: "xlsx", filters: {}, api: a, loaders });
    const allowed = new Set(["members", "memberships", "payments", "bookings", "summary:payments"]);
    expect(a.calls.every((c) => allowed.has(c.key))).toBe(true);
  });
});

// Optional: CHR_SAMPLE_DIR=<folder> npx vitest run src/admin/exports writes sample files there for a visual check.
describe.skipIf(!process.env.CHR_SAMPLE_DIR)("sample files for a visual check", () => {
  it("writes a combined PDF and workbook", async () => {
    const dir = process.env.CHR_SAMPLE_DIR;
    const many = (n, make) => Array.from({ length: n }, (_, i) => make(i + 1));
    const a = fakeApi({
      members: many(40, (i) => memberRow(i)), memberships: many(25, (i) => membershipRow(i)),
      payments: [paymentRow(1), paymentRow(2, { payment_status: "failed", amount: 3000, paid_at: null }), paymentRow(3, { payment_status: "refunded", amount: 5000 }), paymentRow(4, { payment_status: "partially_refunded", amount: 2000 }), ...many(30, (i) => paymentRow(i + 10, { amount: 150000 + i }))],
      bookings: many(35, (i) => bookingRow(i)),
    }, { summary: PAY_SUMMARY });
    const sections = await collectReports("combined", { from: "2026-10-01" }, { api: a });
    const doc = await buildPdf({ sections, generatedAt: new Date(), fonts, logoDataUrl: "data:image/png;base64," + fs.readFileSync(path.join(here, "../../../public/assests/chr-logo-120.png")).toString("base64") });
    fs.writeFileSync(path.join(dir, "combined.pdf"), Buffer.from(doc.output("arraybuffer")));
    fs.writeFileSync(path.join(dir, "combined.xlsx"), Buffer.from(await (await workbookBlob(await buildWorkbook({ sections }))).arrayBuffer()));
  });
});
