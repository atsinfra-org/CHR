import { filtersText, formatDate, formatDateTime, formatMoney, formatTime, pdfSafe, shortId, statusLabel } from "./format";
import { paymentSummaryLines } from "./excel";

const GREEN = [18, 55, 42];
const GOLD = [198, 161, 91];
const IVORY = [246, 242, 232];
const CHARCOAL = [27, 27, 24];
const GREY = [110, 110, 104];
const MARGIN = 10;
const BAND = 16;

/** Text for one table cell. Searchable text, not an image; identifiers are shortened to fit (Excel keeps them whole). */
export function pdfCell(col, row) {
  const raw = row[col.key];
  if (raw == null || raw === "") return "";
  switch (col.type) {
    case "date": return formatDate(raw);
    case "datetime": return formatDateTime(raw);
    case "time": return formatTime(raw);
    case "money": return formatMoney(raw, row.currency);
    case "status": return statusLabel(raw);
    case "id": return shortId(raw);
    case "int": return String(raw);
    default: return pdfSafe(raw);
  }
}

/** Scales the columns' relative weights to the printable width. */
export function columnWidths(columns, totalWidth) {
  const weight = columns.reduce((sum, c) => sum + c.pdf, 0);
  return columns.map((c) => (c.pdf / weight) * totalWidth);
}

/**
 * Builds the PDF: landscape A4, one clearly separated section per report (each starts on a new page), the table header
 * repeated on every page, "Page x of y" on every page, the CHR band, the applied filters and the generation time.
 * `fonts` are base64 TrueType strings of an embedded font that contains the rupee sign.
 */
export async function buildPdf({ sections, generatedAt = new Date(), fonts, logoDataUrl = null, jsPDFClass, autoTableFn }) {
  const jsPDF = jsPDFClass ?? (await import("jspdf")).jsPDF;
  const autoTable = autoTableFn ?? (await import("jspdf-autotable")).default;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4", compress: true });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const usable = pageW - MARGIN * 2;

  doc.addFileToVFS("NotoSans-Regular.ttf", fonts.regular);
  doc.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
  doc.addFileToVFS("NotoSans-Bold.ttf", fonts.bold);
  doc.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");
  doc.setFont("NotoSans", "normal");
  doc.setProperties({ title: sections.length === 1 ? `CHR ${sections[0].spec.title}` : "CHR Administrative Report", author: "Colonel Horse Riding Club", creator: "CHR admin" });

  const pageTitles = new Map();

  sections.forEach((section, index) => {
    const { spec, filters, rows, summary } = section;
    if (index > 0) doc.addPage();
    const startPage = doc.getCurrentPageInfo().pageNumber;
    pageTitles.set(startPage, spec.title);

    let y = BAND + 9;
    doc.setFont("NotoSans", "bold").setFontSize(15).setTextColor(...GREEN);
    doc.text(pdfSafe(spec.title), MARGIN, y);
    y += 6;
    doc.setFont("NotoSans", "normal").setFontSize(8.5).setTextColor(...GREY);
    doc.text(pdfSafe(`Generated ${formatDateTime(generatedAt)} IST   |   ${rows.length} record${rows.length === 1 ? "" : "s"}   |   Amounts in INR   |   Identifiers are shortened here; the Excel export has them in full`), MARGIN, y);
    y += 4.5;
    doc.text(pdfSafe(`Filters: ${filtersText(spec, filters)}`), MARGIN, y, { maxWidth: usable });
    y += 5;
    const lines = paymentSummaryLines(summary);
    if (lines.length) {
      doc.setTextColor(...CHARCOAL).setFontSize(8.5);
      for (const [i, line] of lines.entries()) {
        doc.setFont("NotoSans", i === 0 ? "bold" : "normal");
        doc.text(pdfSafe(line), MARGIN, y, { maxWidth: usable });
        y += 4.2;
      }
      y += 1.5;
    }

    if (rows.length === 0) {
      doc.setFont("NotoSans", "normal").setFontSize(10).setTextColor(...GREY);
      doc.text("No records match these filters.", MARGIN, y + 6);
      return;
    }

    const cols = spec.columns;
    const widths = columnWidths(cols, usable);
    autoTable(doc, {
      startY: y,
      head: [cols.map((c) => pdfSafe(c.header))],
      body: rows.map((row) => cols.map((c) => pdfCell(c, row))),
      margin: { top: BAND + 6, left: MARGIN, right: MARGIN, bottom: 12 },
      tableWidth: usable,
      theme: "grid",
      showHead: "everyPage",
      rowPageBreak: "avoid",
      styles: { font: "NotoSans", fontSize: cols.length > 13 ? 6 : 7.2, cellPadding: 1.1, overflow: "linebreak", valign: "middle", lineColor: [220, 214, 196], lineWidth: 0.1, textColor: CHARCOAL },
      headStyles: { font: "NotoSans", fontStyle: "bold", fillColor: GREEN, textColor: IVORY, halign: "left" },
      alternateRowStyles: { fillColor: [250, 248, 242] },
      columnStyles: Object.fromEntries(cols.map((c, i) => [i, { cellWidth: widths[i], halign: c.type === "money" || c.type === "int" ? "right" : "left" }])),
      didDrawPage: () => pageTitles.set(doc.getCurrentPageInfo().pageNumber, spec.title),
    });
  });

  // The band and footer are drawn last, on every page, so "Page x of y" knows the final count.
  const total = doc.getNumberOfPages();
  for (let p = 1; p <= total; p += 1) {
    doc.setPage(p);
    doc.setFillColor(...GREEN).rect(0, 0, pageW, BAND, "F");
    doc.setFillColor(...GOLD).rect(0, BAND, pageW, 0.7, "F");
    let x = MARGIN;
    if (logoDataUrl) {
      try {
        doc.addImage(logoDataUrl, "PNG", MARGIN, 2, 12, 12);
        x = MARGIN + 15;
      } catch {
        /* the logo is decoration: carry on without it */
      }
    }
    doc.setFont("NotoSans", "bold").setFontSize(11).setTextColor(...IVORY).text("Colonel Horse Riding Club", x, 8.5);
    doc.setFont("NotoSans", "normal").setFontSize(8).setTextColor(...GOLD).text("Guwahati", x, 12.6);
    doc.setFontSize(9).setTextColor(...IVORY).text(pdfSafe(pageTitles.get(p) ?? ""), pageW - MARGIN, 9.5, { align: "right" });
    doc.setFont("NotoSans", "normal").setFontSize(7.5).setTextColor(...GREY);
    doc.text("Confidential: contains members' personal information. Handle in line with the club's privacy notice.", MARGIN, pageH - 5);
    doc.text(`Page ${p} of ${total}`, pageW - MARGIN, pageH - 5, { align: "right" });
  }
  return doc;
}

export async function pdfBlob(doc) {
  return doc.output("blob");
}
