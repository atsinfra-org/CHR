import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Admin -> Exports: route registration, visibility, the page's controls, and a scan for credentials in the export code.
vi.mock("../lib/supabaseClient", () => ({ supabase: { from: () => ({ select: () => ({ order: () => Promise.resolve({ data: [] }) }) }), rpc: vi.fn() } }));

const { default: AdminExports } = await import("./pages/AdminExports.jsx");
const { VALID_ROUTES } = await import("./useAdminRoute.js");
const { PAGE_META, NAV_SECTIONS } = await import("./adminNav.js");

const here = path.dirname(fileURLToPath(import.meta.url));

describe("Admin -> Exports", () => {
  it("is a registered route, titled Exports, and administrators only (hidden from staff)", () => {
    expect(VALID_ROUTES).toContain("exports");
    expect(PAGE_META.exports.title).toBe("Exports");
    expect(PAGE_META.exports.adminOnly).toBe(true);
    const visibleToStaff = NAV_SECTIONS.flatMap((s) => s.items).filter((i) => !i.adminOnly).map((i) => i.key);
    expect(visibleToStaff).not.toContain("exports");
  });
  it("offers every report, both formats, the filters and the three actions", () => {
    const html = renderToStaticMarkup(<AdminExports />);
    for (const label of ["Member registrations", "Memberships", "Payments (follow-up)", "Bookings", "Combined administrative report"]) expect(html).toContain(label);
    expect(html).toContain("Excel (.xlsx)");
    expect(html).toContain("PDF (.pdf)");
    expect(html).toContain("Preview summary");
    expect(html).toContain("Export Excel");
    expect(html).toContain("Payment status");
    expect(html).toContain("Payment created date from");
    expect(html).toContain("audit log");
    expect(html.toLowerCase()).not.toContain("horse");
  });
  it("no credentials, keys or storage uploads anywhere in the export code", () => {
    const files = [...fs.readdirSync(path.join(here, "exports")).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js")).map((f) => path.join(here, "exports", f)), path.join(here, "pages", "AdminExports.jsx")];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/service_role|SERVICE_ROLE|serviceRole|api[_-]?key|Bearer |RAZORPAY_(KEY|SECRET|WEBHOOK)|RESEND_(API|WEBHOOK)|\.storage\b|createSignedUrl|getPublicUrl|localStorage|sessionStorage/i);
    }
  });
  it("only the export modules call the report functions, and only through adminApi", () => {
    const api = fs.readFileSync(path.join(here, "adminApi.js"), "utf8");
    for (const fn of ["admin_report_members", "admin_report_memberships", "admin_report_payments", "admin_report_bookings", "admin_report_summary", "admin_log_export"]) expect(api).toContain(`"${fn}"`);
    const page = fs.readFileSync(path.join(here, "pages", "AdminExports.jsx"), "utf8");
    expect(page).not.toMatch(/\.from\("(payments|memberships|profiles|bookings)"/); // no direct table reads for the data
  });
});
