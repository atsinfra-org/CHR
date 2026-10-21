# Admin exports (Excel and PDF)

**Status:** built and tested locally. Migration `0036_admin_reports.sql` is **not applied** and nothing is deployed.

Administrators can download member, membership, payment and booking records as `.xlsx` or `.pdf` from **Admin → Exports**
(the page is hidden from staff). Files are created in the administrator's browser from pages of data returned by
administrator-only database functions. Nothing is stored, no file is uploaded and there is no download link to share.

## Reports and filters
| Report | One row per | Filters |
|---|---|---|
| Member registrations | member (role `member`) with their *current* membership (active first, else latest to end) | registration date, membership status (incl. "No membership"), membership type |
| Memberships | membership | purchase date, status, plan |
| Payments (follow-up) | payment | payment-created date, payment status, gateway |
| Bookings | booking (a real reservation) | class date, booking status, membership type |
| Combined | all four, as four sheets (Excel) / four sections (PDF) | date range and membership type; status filters do not apply |

Dates are India (IST) calendar days. Statuses are exactly the database's: payments `created, pending, processing, success, failed,
expired, refunded, partially_refunded`; memberships `pending_payment, active, expired, cancelled, suspended`; bookings
`held, confirmed, cancelled, completed, no_show, expired, absent, rescheduled`.

## Accuracy rules
* **Credits** are the membership's own `total_credits` and `credits_remaining` (which match the ledger). "Classes used" is total minus remaining. Nothing is recalculated.
* **Revenue** counts only payments with status `success`. Refunded and partially refunded payments are listed separately with their **original** amount, because the database stores no refund amount; nothing is netted off. Failed, pending, created, processing and expired payments are never revenue.
* **Amounts** are INR exactly as stored (no paise conversion).
* **One row per entity:** joins that could fan out (an order with several items, a member with several memberships, a booking with attendance) are collapsed first. Items bought are joined into one cell.
* **Blank means no data.** All current phone numbers are empty and are exported blank, never invented. Erased accounts and `*.invalid` placeholder emails are blank. Payment metadata and gateway payloads are never exported. There are no horse columns.
* **Plan price** is the plan's current price; **Payment amount** is the whole linked payment (an order can include shop items).
* **Activation / start** is the membership's start date.
* **Bookings** are real reservations. A weekly-schedule preference that has produced no booking is not listed. `Booked via` and `Weekly schedule ref.` show which bookings came from a schedule.

## Files
* **Excel (ExcelJS):** named sheets, title, generated-at (IST), applied filters, payments revenue summary, frozen and filterable header row, column widths, ₹ and date formats, landscape print setup.
  **Formula-injection protection:** text that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a leading apostrophe; phone numbers and plain numbers are untouched. Only the exported text changes, never the database.
* **PDF (jsPDF + AutoTable, searchable text):** landscape A4, CHR band and logo, title, generated-at, filters, repeated table header, "Page x of y", confidential footer, wrapped text, scaled columns. Identifiers are shortened to 8 characters (Excel has them in full).
  Embedded **Noto Sans** subset (Latin, Latin-1/Extended-A, common punctuation, ₹; about 74 KB per weight; SIL OFL, `src/admin/exports/fonts/OFL-NotoSans.txt`). Characters outside it (for example Devanagari) print as `?` in the PDF; Excel keeps them.
* Libraries and fonts load only when an export starts, as separate chunks (ExcelJS about 256 KB gzipped, jsPDF about 140 KB gzipped).

## Security
* Every report function checks `is_admin()` itself; staff and members get `FORBIDDEN`, `anon` cannot execute them, and the internal row sources are callable by nobody. Hiding the button is not the control.
* Filters and paging are validated in the database (limit 1 to 500, valid dates and statuses, plain plan and gateway values). The browser never queries the data tables for exports.
* No service-role key or secret is in the browser bundle or in any file. No storage bucket or signed link is used.
* `admin_log_export` records who exported what (report, format, whitelisted filters, row count, success or failure) in `audit_logs` (`table_name = 'admin_exports'`). Contents and personal data are never logged.
* A report over 20,000 rows is refused with a message to narrow the filters. Page size is 500. A second click while an export runs does nothing.

## Tests
```
npm test                                   # exports, formatting, injection, paging, Excel read-back, PDF text/pages/widths/₹, admin page
psql -d <replica with 0016-0036> -f supabase/tests/phase21_admin_reports.sql   # authorization, validation, fan-out, paging, revenue, redaction, audit (rolls back)
```
Samples for a visual check: `CHR_SAMPLE_DIR=<folder> npx vitest run src/admin/exports` writes `combined.pdf` and `combined.xlsx`.

## Production steps (nothing done yet)
1. Review `supabase/proposals/0036_admin_reports.sql`, run it in the Supabase SQL Editor (safe to run twice; rollback `0036_admin_reports.down.sql`, which keeps audit rows). It adds functions and three date indexes only.
2. Deploy the website (new dependencies: `exceljs`, `jspdf`, `jspdf-autotable`; dev: `pdfjs-dist` for tests). No Edge Function or secret changes.
3. Sign in as an administrator, open Admin → Exports, preview, then export each report once. Check Admin → Audit Log shows `REPORT_EXPORT` rows.
4. Sign in as staff: the Exports page must not appear.

## Known limitations
* Everything is built in the browser, so very large reports are capped at 20,000 rows each.
* The database holds no refund amount and no payment failure reason, so neither is exported.
* Browsers cannot password-protect the files; handle them as personal data.
