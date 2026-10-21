import { adminApi } from "../adminApi";
import { collectReports, combinedFilters, ExportError, normaliseFilters } from "./reports";
import { buildWorkbook, workbookBlob } from "./excel";
import { fileName } from "./format";

/**
 * Generates one export in the browser and returns the file. Libraries (ExcelJS, jsPDF, the font) are loaded only
 * here, when an administrator asks for an export. On success AND on failure a metadata-only audit row is recorded
 * (report, format, filters, row count, outcome; never the contents). The database independently refuses anyone who
 * is not an administrator, so a hidden button is not the control.
 */
export async function runExport({ kind, format, filters, onProgress, api = adminApi, loaders = {}, signal }) {
  const auditFilters = kind === "combined" ? combinedFilters(filters) : normaliseFilters(kind, filters);
  let rowCount = 0;
  try {
    const sections = await collectReports(kind, filters, { api, onProgress, signal });
    rowCount = sections.reduce((sum, s) => sum + s.rows.length, 0);
    const generatedAt = new Date();
    let blob;
    onProgress?.({ stage: "building" });
    if (format === "xlsx") {
      const wb = await buildWorkbook({ sections, generatedAt });
      blob = await workbookBlob(wb);
    } else if (format === "pdf") {
      const [{ buildPdf, pdfBlob }, fontsMod] = await Promise.all([import("./pdf"), loaders.fonts ? Promise.resolve(null) : import("./fonts")]);
      const fonts = loaders.fonts ? await loaders.fonts() : await fontsMod.loadPdfFonts();
      const logoDataUrl = loaders.logo ? await loaders.logo() : fontsMod ? await fontsMod.loadLogo() : null;
      blob = await pdfBlob(await buildPdf({ sections, generatedAt, fonts, logoDataUrl }));
    } else {
      throw new ExportError("INVALID_FORMAT", "That file format isn't supported.");
    }
    if (!blob || blob.size === 0) throw new ExportError("EMPTY_FILE", "The file could not be created. Please try again.");
    await api.logExport(kind, format, auditFilters, rowCount, "success").catch(() => null);
    return { blob, filename: fileName(kind, format, generatedAt), rows: rowCount, sections };
  } catch (err) {
    await api.logExport(kind, format, auditFilters, rowCount, "failure").catch(() => null);
    throw err;
  }
}

/** Words an export failure for the administrator; never shows raw database or library text. */
export function exportErrorMessage(err) {
  if (err instanceof ExportError && err.code !== "DATABASE") return err.message;
  if (err instanceof ExportError) return err.message || "The report could not be loaded.";
  return "The file could not be created. Please try again.";
}
