# CHR — DPDP Data Audit

Status: **Phase 1 discovery/audit.** Read-only inspection of the repository and the live Supabase project. No production data was modified, deleted, or exported to produce this document. No migrations were applied.

Audited: 2026-10-18. Project: Colonel Horse Riding (CHR), `F:\ATGC\CHR`.

Legal-basis and commencement-date questions in this document are flagged for review; nothing here should be treated as legal advice (see §9).

---

## 1. System Architecture

### 1.1 What exists in this repository

- **Website**: React 19 + Vite SPA (`src/`), no router — path-prefix dispatch in `src/main.jsx` renders one of: the public marketing site, `/account` (member area), `/store` (tack/café/membership storefront), `/admin` (staff/admin console), `/orders` (order lookup).
- **Shared auth screen**: `src/components/auth/AuthScreen.jsx` — one component serves member login/register/forgot-password and a separate staff-only login (`variant="staff"`), used from `/account`, `/store`, `/admin`. Supabase Auth (email+password, Google OAuth) is the identity provider.
- **Backend**: Supabase (Postgres 15, Auth, Edge Functions, no Storage buckets in use). No ORM — the frontend calls PostgREST directly (`supabase-js`) for reads and almost exclusively **RPCs** (`SECURITY DEFINER` Postgres functions) for every write and every cross-user read.
- **Payments**: Razorpay, via three Edge Functions (`razorpay-create-order`, `razorpay-verify-payment`, `razorpay-webhook`) plus one DB function (`process_payment_webhook`, not separately listed above — referenced by both the webhook and the verify-payment function as the single idempotent place a payment is ever marked successful).
- **Email**: one Edge Function, `enquiry-email`, sends a notification via Resend when a public enquiry form is submitted. No other outbound email exists in this repo (no transactional email for receipts, booking confirmations, password reset is handled entirely by Supabase Auth's own mailer).
- **Push notifications**: `push_devices` (Expo push tokens), `notifications` (in-app + push source-of-truth), `push_deliveries` (delivery/retry ledger), and an Edge Function `push-send` that reads `notifications`/`push_devices` with the service-role key and calls Expo's push API.

### 1.2 What does **not** exist in this repository

- **No React Native / Expo mobile app.** The task brief describes one (Android package `com.colonelhorseridingclub.app`), and the database schema is clearly built to serve one (Expo push-token format constraint on `push_devices.token`, a dedicated push pipeline) — but no mobile client code is present in `F:\ATGC\CHR`. **UNVERIFIED**: if a mobile app exists, it is a separate repository not covered by this audit. Everything below describes the web client only; any mobile-specific collection (device identifiers beyond the push token, OS-level permissions, app-store data) is **UNVERIFIED** and must be audited separately before this document can be called complete for the whole product.
- **No Supabase Storage usage.** `profiles.avatar_url` exists as a column but has zero upload UI and zero references anywhere outside its own type definition — confirmed by repository-wide search. Not a live feature.
- **No account-deletion feature**, no consent-tracking table, no published Privacy Policy or Terms page (the footer links to both exist but point to `href="#"` — dead links), no user-rights/grievance request form.
- **No `supabase/migrations/` directory, no `supabase/config.toml`.** All schema changes live in `supabase/proposals/*.sql`, applied by hand (per project history) rather than through `supabase db push`. `supabase/schema.sql` is a 54-line historical stub (enquiry storage only) and does **not** reflect the live schema — it predates almost everything below.

### 1.3 Repository vs. live database — confirmed drift

The CLI's own migration-tracking table (`supabase migration list`, read-only, run during this audit) shows 13 entries, all dated 2026-09-09/10 — these do not correspond to the `0002`–`0029` proposal numbering at all and are not a reliable account of what is live.

To get ground truth, this audit queried the live database directly (via the Supabase MCP `list_tables`/`get_advisors` tools — read-only). Findings:

- **26 tables exist live** in `public`, all with `rls_enabled = true`.
- Three migration files are **untracked in git** (`0026_push_devices.sql`, `0027_recurring_weekly_bookings.sql`, and a `0026_push_activation.template.sql`) yet their tables (`push_devices`, `push_deliveries`, `recurring_schedules`, `recurring_schedule_slots`, `recurring_occurrences`) **are already live** in the database. **This means the live schema has been applied ahead of what's committed to version control** — a real process gap (see Gap Register P2-01), independent of DPDP: if the live database and the repository disagree, no later audit or code review can trust the repository alone.
- Two tables intended by a long-removed phase (`horses`) are confirmed **absent** from the live schema (removed by `0022_no_horses.sql`), consistent with project history ("no horses anywhere in the app").
- One function referenced in old migration files (`admin_mark_order_paid`) is confirmed **no longer live** (absent from the full live function list obtained via the security advisor), consistent with project history ("staff 'Mark paid' removed").

### 1.4 Live table inventory (public schema, 2026-10-18)

| Table | Rows (at audit time) | Purpose |
|---|---|---|
| `profiles` | 18 | 1:1 with `auth.users`; name/phone/email/DOB/role/status |
| `enquiries` | 1 | Public contact-form submissions |
| `membership_plans` | 3 | Plan catalog (price, credits, age range) |
| `memberships` | 13 | A member's purchased plan instance + credit balance |
| `payments` | 20 | Razorpay payment records |
| `credit_ledger` | 24 | Append-only ledger backing `memberships.credits_remaining` |
| `schedule_templates` | 40 | Recurring weekly class-time templates (admin-authored) |
| `class_sessions` | 334 | Generated, bookable occurrences |
| `bookings` | 11 | A member's booking of a session |
| `attendance` | 1 | Attendance mark per booking |
| `system_settings` | 9 | Key/value operational config |
| `audit_logs` | 52 | Admin-action audit trail |
| `payment_webhook_events` | 12 | Razorpay webhook idempotency ledger |
| `store_products` | 17 | Tack/café/membership SKUs |
| `orders` | 20 | Store checkout orders |
| `order_items` | 20 | Order line items |
| `notifications` | 127 | In-app + push notification source rows |
| `referral_codes` | 3 | One code per member |
| `referrals` | 0 | Referrer→referred pairing + reward status |
| `wallet_ledger` | 0 | Referral-reward wallet credits/debits |
| `waitlist_entries` | 0 | Session waitlist |
| `push_devices` | 3 | Expo push tokens |
| `push_deliveries` | 13 | Push send attempt/retry ledger |
| `recurring_schedules` | 0 | Member's standing weekly booking slot(s) |
| `recurring_schedule_slots` | 0 | Day/time of a recurring schedule |
| `recurring_occurrences` | 0 | Per-week outcome of a recurring schedule |

Classification: **CONFIRMED** (live `list_tables` query).

---

## 2. Personal-Data Inventory

See `docs/privacy/DATA_RETENTION_MATRIX.md` for the full per-field table (purpose, mandatory/optional, access, sharing, retention). Summary by category below; all CONFIRMED against the live schema and the frontend code that writes to it.

### A. Account and identity — `profiles`, `auth.users`
`full_name`, `phone`, `email`, `date_of_birth`, `avatar_url` (column exists, unused), `role`, `status`, plus whatever Supabase Auth itself holds (`auth.users`: email, hashed password, Google OAuth identity if used, session/refresh tokens, last-sign-in metadata) — **not directly inspected** (reading `auth.users` rows was avoided to not pull live personal data unnecessarily; its existence and structure is standard Supabase Auth, not CHR-specific).

### B. Membership — `membership_plans`, `memberships`
Plan name/price/credits (not personal), and per-member: plan, status, start/end date, credits remaining, which `payment_id` funded it, reschedules used.

### C. Booking and attendance — `class_sessions`, `bookings`, `attendance`, `waitlist_entries`, `recurring_schedules/_slots/_occurrences`
No horse assignment exists anywhere in the current schema (confirmed absent — see §1.3). A booking is a seat in a `class_sessions` row; attendance is `present/absent/no_show/excused` per booking, who marked it, and free-text notes (**notes is free text written by staff about a member — flag for retention/minimisation review, since staff could write anything there**).

### D. Payment — `payments`, `payment_webhook_events`, `orders`, `order_items`
Razorpay `gateway_order_id`/`gateway_payment_id` (references, not card/UPI details — Razorpay's hosted checkout means CHR's own database never receives card numbers, UPI VPAs, or bank details), amount, currency, status, a `metadata jsonb` column (**UNVERIFIED what exactly ends up in this column — not enumerated by schema alone; recommend a follow-up code read of every `.update(... metadata ...)` call site before concluding it never holds anything sensitive**), and the full raw webhook `payload jsonb` in `payment_webhook_events` (**this is Razorpay's complete webhook body, stored verbatim for idempotency — almost certainly contains the customer's name/email/phone/payment method label as sent by Razorpay. This is the single largest concentration of payment-adjacent personal data in the schema and should be in the retention/minimisation review, see Gap Register P2-02**).

### E. Notifications — `push_devices`, `push_deliveries`, `notifications`
Expo push token (format-constrained, device-bound, not itself directly identifying but linked to `user_id`), platform, app version, per-notification title/body/`data jsonb`, read status, and a delivery-attempt ledger with Expo's own error strings.

### F. Administrative/operational — `audit_logs`, `system_settings`, admin exports
`audit_logs` captures `table_name`, `record_id`, `action`, `performed_by`, and full `old_values`/`new_values jsonb` snapshots — **this means every admin-triggered profile/membership/payment change has a complete before/after copy of that row sitting in `audit_logs` indefinitely, including personal-data columns**. This is a legitimate and common audit-trail design, but it is itself a store of personal data that needs its own retention answer (Gap Register P2-03), not an oversight to "fix" by deleting it.

No admin CSV/PDF export feature was found in `src/admin/` (not searched exhaustively for every possible export path, but no "export", "csv", "download" admin action surfaced in the file list reviewed).

### G. Other
Referral codes/relationships (`referral_codes`, `referrals`) link two members' `user_id`s together — this is personal data about the *relationship* between two members, not just one, and should be named explicitly in any privacy notice ("if you use a referral code, we record that you and the referrer are connected").

---

## 3. Data-Flow Map

```
Visitor (public site)
  -> enquiries table (direct insert, anon key)
  -> enquiry-email Edge Function -> Resend (3rd party) -> staff inbox

Member (web, AuthScreen)
  -> Supabase Auth (email+password or Google OAuth)
  -> profiles row (own, via "Members read/update own profile" RLS)
  -> memberships / bookings / attendance / credit_ledger (own rows, RLS-scoped reads;
     all writes go through SECURITY DEFINER RPCs, never direct INSERT/UPDATE)
  -> Store checkout: create_order() -> orders/order_items/payments
       -> razorpay-create-order Edge Function -> Razorpay (3rd party) -> checkout widget
       -> razorpay-verify-payment / razorpay-webhook -> process_payment_webhook()
            -> payments.status, memberships.status/credits, payment_webhook_events (raw payload retained)
  -> register_push_device() -> push_devices -> push-send Edge Function -> Expo (3rd party) -> member's phone

Staff/Admin (web, /admin)
  -> admin_* RPCs (all is_admin()/is_staff_or_admin()-gated) read/write the above on behalf of members
  -> every admin_* write also inserts an audit_logs row (old_values/new_values)
```

Third parties with personal-data flow: **Supabase** (hosting, DB, auth), **Razorpay** (payment processing), **Resend** (enquiry notification email), **Expo** (push notification delivery), **Google** (OAuth sign-in, if a member chooses it). See `docs/privacy/DPDP_IMPLEMENTATION_PLAN.md` §H for what's still unresolved about each.

---

## 4. Existing Privacy Controls

- **NOT IMPLEMENTED**: consent capture/tracking of any kind.
- **NOT IMPLEMENTED**: a reachable Privacy Policy or Terms page (footer links are dead — `href="#"` in both cases, confirmed in `src/components/Footer/Footer.jsx`).
- **NOT IMPLEMENTED**: account deletion (no RPC, no UI, no "delete my account" path found anywhere in `src/`).
- **NOT IMPLEMENTED**: a user-facing data-access/correction/grievance request mechanism beyond the generic public enquiry form (which is not authenticated, not categorised as a privacy request, and not tracked to resolution).
- **PARTIALLY VERIFIED**: members can see and edit their own `full_name`/`phone`/`date_of_birth` via their profile (this is self-service correction for those fields, which is a real, working piece of the "right to correction" even though it was never built with DPDP in mind) — **UNVERIFIED** whether email or other fields are editable the same way (not traced in this pass).

## 5. Existing Security Controls

- **CONFIRMED**: Row Level Security is enabled on all 26 live tables (zero "RLS disabled" findings from the Supabase security advisor).
- **CONFIRMED**: Every privileged (`admin_*`) RPC sampled in this audit — all 21 distinct `admin_*` functions that are actually live — independently checks `is_admin()` or `is_staff_or_admin()` inside the function body (not just relying on RLS or a hidden frontend button). See `SUPABASE_SECURITY_AUDIT.md` §2 for the full list and method.
- **CONFIRMED**: payment amounts in `create_order()` are looked up server-side from `store_products`/`membership_plans`, never taken from the client's request body — a client can only submit `product_id` + `quantity`.
- **CONFIRMED**: the Razorpay webhook verifies the `X-Razorpay-Signature` header with HMAC-SHA256 against a secret read from `Deno.env` (never hardcoded), using a timing-safe comparison.
- **CONFIRMED**: no Supabase service-role key, Razorpay secret, or any other server-only secret is referenced anywhere in `src/` (the client bundle) — only `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`, both intentionally public.
- **CONFIRMED — real finding, fix proposed, not applied**: `public.prevent_privilege_escalation()` (the trigger meant to stop a member granting themselves admin) currently permits a **'staff' account to self-promote to 'admin'** via a direct PostgREST update to their own profile row, bypassing `admin_set_role()`'s stricter admin-only check entirely. See `SUPABASE_SECURITY_AUDIT.md` §1 and Gap Register **P1-01**. A minimal, non-destructive fix is proposed as `supabase/proposals/0028_privilege_escalation_fix.sql` (not applied).
- **CONFIRMED, low severity, judged intentional**: `available_sessions(date)` is callable by the unauthenticated `anon` role. Its own code comment says this is deliberate ("Public session-availability browse... returns ONLY aggregate columns — never user_id, booking id, or any member identity"), and it is only actually called from authenticated admin pages in the current frontend, not the public site. No personal data is returned by it. No fix proposed; documented as a conscious design choice to flag for business sign-off rather than a vulnerability.
- **CONFIRMED, informational, correct-by-design**: `push_deliveries` has RLS enabled with **no policies at all** — meaning nobody can read or write it through the API. Confirmed: the frontend never references this table; it is only touched by the `push-send` Edge Function using the service-role key, which bypasses RLS entirely. No fix needed.
- **WARN, no fix applied yet (trivial)**: `public._int_in_range()` lacks `set search_path`, unlike every other function in the project. Low risk (it touches no tables), but inconsistent with the project's own convention. Fix proposed as `supabase/proposals/0029_search_path_hardening.sql` (not applied).
- **WARN, Auth setting, not a migration**: "Leaked Password Protection" is disabled in Supabase Auth. Recommend enabling it (Dashboard → Authentication → Policies) — this is a one-click setting, not a code change, and this audit did not and should not toggle it without the business owner's say.

## 6–8. Gaps, Severity, Evidence, Remediation

Moved to `docs/privacy/DPDP_GAP_REGISTER.md` for structured tracking (ID, status, owner).

## 9. Unverified Assumptions and Limitations

1. **No mobile app in this repository.** Every finding above is web-only. If a React Native/Expo app exists elsewhere, it must be audited separately — this document cannot speak to it, and the task brief's references to it (Android package name, push-token schema) suggest one does exist somewhere.
2. **`payments.metadata` and `payment_webhook_events.payload` contents were not fully enumerated field-by-field** — classified by structure (jsonb, clearly payment-adjacent) rather than by reading every write site. Recommend a follow-up pass before finalising the retention matrix for these two columns specifically.
3. **`auth.users` was not queried directly** in this audit (to avoid pulling live personal data unnecessarily beyond what was needed) — its contents are assumed to be standard Supabase Auth fields.
4. **No exhaustive search for every possible admin export/download feature** was performed; absence is based on filename/keyword search in `src/admin/`, not a full manual review of every admin page.
5. **Applicable DPDP Rules commencement dates were not independently re-verified against the live MeitY URLs during this pass** (no network access confirmed in this environment) — see `DPDP_IMPLEMENTATION_PLAN.md` §B for what needs confirming before any "X is/isn't currently enforceable" claim is relied on.
6. **This document is an engineering audit, not a legal opinion.** Every "gap" below is a technical/process finding; whether and how it maps to a specific DPDP Act/Rules obligation, and by when, requires confirmation from qualified Indian legal counsel (see Gap Register entries marked `LEGAL_REVIEW_REQUIRED`).
