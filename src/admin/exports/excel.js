import { describeFilters, excelDate, excelDateTime, excelTime, filtersText, formatDateTime, formatMoney, sheetSafe, statusLabel, XLSX_MIME } from "./format";

const GREEN = "FF12372A";
const IVORY = "FFF6F2E8";
const GOLD = "FFC6A15B";

const NUM_FMT = {
  date: "dd-mmm-yyyy",
  datetime: "dd-mmm-yyyy hh:mm",
  time: "h:mm AM/PM",
  int: "0",
};
const moneyFmt = (currency) => (!currency || currency === "INR" ? '"₹"#,##0.00' : `"${currency} "#,##0.00`);

/** The text lines above the payments table: what counts as revenue, and what does not. */
export function paymentSummaryLines(summary) {
  if (!summary) return [];
  const by = summary.by_status ?? {};
  const line = (label, c, a) => `${label}: ${formatMoney(a)} (${c} payment${Number(c) === 1 ? "" : "s"})`;
  const s = summary.successful_revenue ?? { count: 0, amount: 0 };
  const r = summary.refunded_original_amount ?? { count: 0, amount: 0 };
  const p = summary.partially_refunded_original_amount ?? { count: 0, amount: 0 };
  const open = ["created", "pending", "processing", "failed", "expired"].map((k) => `${statusLabel(k)} ${by[k]?.count ?? 0}`).join(", ");
  return [
    line("Successful revenue (status Success only)", s.count, s.amount),
    line("Refunded (original payment amount, not revenue)", r.count, r.amount),
    line("Partially refunded (original payment amount, not revenue)", p.count, p.amount),
    `Not revenue: ${open}`,
    "The database records no refund amount, so nothing is netted off.",
  ];
}

/** One cell's value and number format, from a database row. Text is protected against formula injection. */
export function cellFor(col, row) {
  const raw = row[col.key];
  if (raw == null || raw === "") return { value: null };
  switch (col.type) {
    case "date": return { value: excelDate(raw), numFmt: NUM_FMT.date };
    case "datetime": return { value: excelDateTime(raw), numFmt: NUM_FMT.datetime };
    case "time": return { value: excelTime(raw), numFmt: NUM_FMT.time };
    case "int": return { value: Number(raw), numFmt: NUM_FMT.int };
    case "money": return { value: Number(raw), numFmt: moneyFmt(row.currency) };
    case "status": return { value: statusLabel(raw) };
    default: return { value: sheetSafe(String(raw)) };
  }
}

/**
 * Builds the workbook: one worksheet per report with a title, generation time, filters, (payments) the revenue
 * summary, then a frozen, filterable header row. `sections` come from collectReports().
 */
export async function buildWorkbook({ sections, generatedAt = new Date(), ExcelJS: injected }) {
  const ExcelJS = injected ?? (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Colonel Horse Riding Club";
  wb.created = generatedAt;
  wb.title = sections.length === 1 ? sections[0].spec.title : "CHR Administrative Report";

  for (const { spec, filters, rows, summary } of sections) {
    const cols = spec.columns;
    const ws = wb.addWorksheet(spec.sheet);
    const last = cols.length;
    const put = (text, opts = {}) => {
      const r = ws.addRow([sheetSafe(text)]);
      ws.mergeCells(r.number, 1, r.number, Math.min(last, 8));
      Object.assign(r.getCell(1), { font: opts.font, alignment: { vertical: "middle", wrapText: false } });
      return r;
    };
    put(`Colonel Horse Riding Club: ${spec.title}`, { font: { bold: true, size: 14, color: { argb: GREEN } } });
    put(`Generated ${formatDateTime(generatedAt)} IST  |  ${rows.length} record${rows.length === 1 ? "" : "s"}  |  Amounts in INR`, { font: { size: 10, color: { argb: "FF555555" } } });
    put(`Filters: ${filtersText(spec, filters)}`, { font: { size: 10, color: { argb: "FF555555" } } });
    for (const line of paymentSummaryLines(summary)) put(line, { font: { size: 10, bold: line.startsWith("Successful") } });
    ws.addRow([]);

    const headerRow = ws.addRow(cols.map((c) => c.header));
    headerRow.height = 24;
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: IVORY } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
      cell.border = { bottom: { style: "medium", color: { argb: GOLD } } };
      cell.alignment = { vertical: "middle", wrapText: true };
    });
    cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.excel; });

    for (const row of rows) {
      const r = ws.addRow(cols.map((c) => cellFor(c, row).value));
      cols.forEach((c, i) => {
        const { numFmt } = cellFor(c, row);
        if (numFmt) r.getCell(i + 1).numFmt = numFmt;
        if (c.type === "money" || c.type === "int") r.getCell(i + 1).alignment = { horizontal: "right" };
      });
    }
    if (rows.length === 0) {
      const r = ws.addRow(["No records match these filters."]);
      r.getCell(1).font = { italic: true, color: { argb: "FF777777" } };
    }

    ws.views = [{ state: "frozen", ySplit: headerRow.number, xSplit: 0 }];
    ws.autoFilter = { from: { row: headerRow.number, column: 1 }, to: { row: headerRow.number, column: last } };
    ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, printTitlesRow: `${headerRow.number}:${headerRow.number}` };
    ws.headerFooter = { oddFooter: "&LColonel Horse Riding Club&RPage &P of &N" };
  }
  return wb;
}

/** Workbook -> a downloadable .xlsx Blob. */
export async function workbookBlob(wb) {
  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], { type: XLSX_MIME });
}

export { describeFilters };
