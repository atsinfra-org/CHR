# CHR — DPDP Compliance Gap Register

Companion to `DPDP_DATA_AUDIT.md`. Priorities are engineering priorities (per the audit brief's own P0–P3 scale), not a substitute for a legal severity assessment.

Status values used below: `OPEN`, `IN_PROGRESS`, `IMPLEMENTED_UNVERIFIED`, `VERIFIED`, `BLOCKED`, `BUSINESS_DECISION_REQUIRED`, `LEGAL_REVIEW_REQUIRED`.

---

## Update 2026-10-19 — implementation pass

The mobile repository (`F:\ATGC\CHR-Mobile\CHR-mobile-app`) is available and was updated as well. Statuses below were re-checked against the live database (read-only) on 19 Oct 2026. Counts of RLS-protected tables, the absence of storage buckets, and the admin-function authorisation findings were re-confirmed. **No migration has been applied to any real database; nothing was committed.** Legal timeline used (read from the Gazette, G.S.R. 846(E), 13 Nov 2025): Rules 1, 2, 17–21 are in force; Rule 4 starts one year, and Rules 3, 5–16, 22, 23 start eighteen months, after publication — see `DPDP_IMPLEMENTATION_PLAN.md`.

---

### P1-01 — Staff accounts can self-promote to admin

**Description**: `public.prevent_privilege_escalation()` (BEFORE UPDATE trigger on `profiles`) permits a role/status change whenever the *acting* user's own role is already `staff` **or** `admin`. Combined with the permissive "Members update own profile" RLS policy (which does not restrict which columns may change) and the absence of any column-level `GRANT` restricting `UPDATE` on `profiles`, a `staff` account can issue a direct PostgREST `PATCH` on its own row setting `role = 'admin'`, completely bypassing `admin_set_role()` — which was clearly intended to be the only path (it alone enforces `is_admin()`, a mandatory reason string, and a last-admin-count safeguard).

**Evidence**: `supabase/proposals/0002_riding_club_core.sql:318-339` (trigger body); `supabase/proposals/0003_riding_club_rls.sql:52-55` (policy); `supabase/proposals/0014_admin_operations.sql:135-160` (`admin_set_role`'s stricter check); confirmed no compensating column-level grant exists (repository-wide search, no matches).

**Severity**: P1 (High) — internal privilege escalation, not externally anonymous, but a real break in the separation-of-duties the system's own `admin_set_role()` was designed to enforce.

**Applicable provision**: DPDP Act 2023 §8(5) ("reasonable security safeguards... to prevent personal data breach"), insofar as an unauthorised admin promotion would grant access to all members' personal data. `LEGAL_REVIEW_REQUIRED` to confirm this characterisation.

**Remediation**: `supabase/proposals/0028_privilege_escalation_fix.sql` (+ `.down.sql`) — tightens the trigger to require the actor already be `admin`, matching `admin_set_role()` exactly. **Not applied to the remote database.**

**Update 2026-10-19**: Re-verified against the live database today: `prevent_privilege_escalation()` still exempts `staff` (the fix is not applied). The regression test `phase13_privilege_escalation.sql` as first written could not run (it inserted duplicate profile rows and never reached the check); it was repaired and now covers six cases, including that `admin_set_role()` still works. On a database without 0028 the staff self-promotion **succeeds**; with 0028 all checks pass. See `SUPABASE_SECURITY_AUDIT.md` §1. **Owner action: apply 0028 (and 0029) — `DEPLOYMENT_AND_VERIFICATION.md` §1.**

**Status**: `IMPLEMENTED_AND_TESTED` locally; **NOT APPLIED to the live database — the live hole is still open.**

---

### P1-02 — No privacy notice is presented anywhere, including at registration

**Description**: The only "Privacy Policy" / "Terms & Conditions" links in the entire product are in the site footer, and both are dead (`href="#"`). The registration form (`AuthScreen.jsx`) collects name, email, and password with no notice, no link, and no affirmative consent step of any kind.

**Evidence**: `src/components/Footer/Footer.jsx:125-130`; `src/components/auth/AuthScreen.jsx` (full registration flow read, no notice/consent present).

**Severity**: P1 (High) — this is the most basic notice-at-collection expectation under the DPDP Rules.

**Applicable provision**: DPDP Act 2023 §5 (notice) and the Rules' requirements for the content and itemisation of that notice. `LEGAL_REVIEW_REQUIRED` for exact content and the applicable commencement date for this specific obligation — do not assume it is "not yet in force" without checking the official notification.

**Remediation**: Author and publish a real Privacy Policy page; wire the footer links to it; surface it (at minimum a link, ideally a short itemised notice) at the registration step. **Blocked on business input** — see `BUSINESS_DECISION_REQUIRED` items in the Implementation Plan (legal entity name, registered address, grievance contact, actual retention periods). Do not publish a notice with placeholder legal content.

**Update 2026-10-19**: Built: a versioned notice stored in the database (a draft is seeded, never published), public page `/privacy` (+ `/terms`, `/account-deletion`), working footer links, a notice step at website and app registration (a required tick-box appears only when a notice is actually published; a draft never blocks registration), an in-account prompt for existing members that records nothing they did not do, and server-side consent records (append-only, server time, caller identity). Publication is refused until eight club details are supplied and a legal-review confirmation is given. Files: `0030_privacy_foundation.sql`, `src/privacy/*`, `src/lib/privacyLogic.js`, `src/lib/privacyApi.js`, `AuthScreen.jsx`; mobile `src/features/privacy/*`, `sign-up-screen.tsx`. Not verified: the screens in a browser or on a phone (no signed-in test account); the live database. The notice text has not been reviewed by a lawyer.

**Status**: `IMPLEMENTED_NOT_FULLY_VERIFIED` (built and tested; **blocked from going live** by `BUSINESS_DECISION_REQUIRED` and `LEGAL_REVIEW_REQUIRED`).

---

### P1-03 — No account-deletion mechanism

**Description**: No RPC, no UI, no path of any kind for a member to request deletion of their account or data. `auth.users` deletion alone (even if an admin does it manually in the Supabase dashboard) would leave orphaned/broken references across `profiles`, `memberships`, `bookings`, `payments`, `credit_ledger`, `push_devices`, `notifications`, `referral_codes`/`referrals`, `wallet_ledger` — none of which have `ON DELETE` behaviour designed for this (most are plain foreign keys with no cascade specified, so a raw `auth.users` delete would likely just fail on a foreign-key violation, which is at least safe, but not a real solution).

**Evidence**: Repository-wide search for deletion/erasure keywords — only the dead footer links surfaced (unrelated). Live schema foreign-key list obtained via `list_tables` confirms dense interlinking from `profiles.id` with no cascade annotations visible.

**Severity**: P1 (High) — a core DPDP right.

**Remediation**: Not implemented in this phase — see §8 of the audit brief's own instructions ("if a safe, complete deletion workflow cannot be implemented within this phase, produce the dependency map... instead"). A dependency map is below; the actual workflow needs retention-period decisions first (what must be kept for accounting/dispute purposes — payments, audit_logs — vs. what can be deleted/anonymised).

**Deletion dependency map** (for the eventual implementation):

| Table | Treatment when a member requests deletion |
|---|---|
| `profiles` | Candidate for anonymisation (null out `full_name`/`phone`/`email`/`date_of_birth`/`avatar_url`), not row deletion — many tables FK to it. |
| `auth.users` | Deleted last, via `supabase.auth.admin.deleteUser()` (server-side only), after all of the above are handled. |
| `memberships`, `bookings`, `attendance`, `credit_ledger`, `waitlist_entries`, `recurring_*` | Operational history tied to a membership the business may want for dispute/accounting reasons — retain, but the `user_id` link to a now-anonymised profile still works (FK stays valid) since `profiles.id` itself is never deleted, only its content blanked. |
| `payments`, `payment_webhook_events`, `orders`, `order_items` | **Retain** — financial/accounting records; do not delete (confirm retention period with the business, see `BUSINESS_DECISION_REQUIRED` below). |
| `audit_logs` | **Retain** — includes a frozen `old_values`/`new_values` snapshot from before anonymisation; this is expected and correct for an audit trail, but means audit_logs will still contain the member's pre-anonymisation name/phone forever unless a separate, carefully-scoped redaction pass is also designed (not attempted here — high risk of corrupting the audit trail's own integrity). |
| `referral_codes`, `referrals`, `wallet_ledger` | Referral code can be deleted/invalidated; `referrals`/`wallet_ledger` rows reference `auth.users` directly (not `profiles`) — needs its own decision once `auth.users` row is gone (an orphaned FK, or anonymise there too). |
| `push_devices`, `notifications`, `push_deliveries` | Safe to hard-delete — no accounting/audit value once the member is gone. |

**Update 2026-10-19**: Built per the dependency map above, with one important correction found while mapping foreign keys on the live schema: `profiles.id` → `auth.users` is `ON DELETE CASCADE`, **and `memberships`, `wallet_ledger`, `referrals` and `referral_codes` cascade too**, so deleting a login would try to delete the profile and could silently destroy a membership or wallet record. Erasure therefore **never hard-deletes**: it removes what has no record-keeping value, blanks the profile's identifying columns (the row stays so every ledger keeps its link), then the Edge Function disables the login with a *soft* delete. Guards (all enforced in the database): switch on, request reviewed ("in progress"), optional waiting period, and no blocker (active membership, future booking, unpaid order, payment in flight, wallet balance, staff/admin account). It never cancels or refunds anything. Retry-safe and honest: the request is closed only after the login is really disabled. Files: `0031_account_erasure.sql`, `supabase/functions/account-erasure/`, `AdminPrivacy.jsx`, member `PrivacyPage.jsx`, mobile `privacy-screen.tsx`. Tested: `phase15` (database), `account-erasure-function.test.cjs` (18 checks). **Not verified:** the live Edge Function and Supabase's soft-delete behaviour (test with a throwaway account first).

**Status**: `IMPLEMENTED_NOT_FULLY_VERIFIED` (request tracking live-ready; **destructive finalisation is switched off** pending `BUSINESS_DECISION_REQUIRED` and `LEGAL_REVIEW_REQUIRED`).

---

### P2-01 — Live database has drifted ahead of version control

**Description**: `push_devices`, `push_deliveries`, `recurring_schedules`, `recurring_schedule_slots`, and `recurring_occurrences` are live in the database today, but their defining migration files (`0026_push_devices.sql`, `0027_recurring_weekly_bookings.sql`) are untracked in git (confirmed via `git status`). This is a process gap: if the repository can't be trusted to reflect the live schema, every future audit or review has to re-verify against the live database from scratch, as this one did.

**Evidence**: `git status --short` (untracked files list) cross-checked against live `list_tables` output.

**Severity**: P2 (process risk, not itself a data-exposure issue).

**Remediation**: Commit the pending migration files once their author confirms they're final (this audit did not commit them — they are the user's in-progress work, outside this audit's scope to touch).

**Update 2026-10-19**: The push and weekly-schedule migrations (0026, 0027) are now committed to the repository. The proposals folder and the live schema agree for those objects. (The migration-tracking table of the CLI still does not reflect the hand-applied files; that is the repository's existing convention.)

**Status**: `VERIFIED` — resolved.

---

### P2-02 — Full Razorpay webhook payloads retained indefinitely

**Description**: `payment_webhook_events.payload` stores the complete raw webhook body from Razorpay (needed for idempotency — `event_id` is the dedupe key) with no retention limit. This payload almost certainly includes customer name/email/phone/payment-method label as Razorpay sends them, duplicating data already in `profiles`/`payments` in a less-structured, harder-to-govern form.

**Evidence**: `list_tables` column listing for `payment_webhook_events` (`payload jsonb`, comment: "Idempotency ledger... Append-only; written only by process_payment_webhook()"). Exact field contents **UNVERIFIED** (not read from a live row to avoid pulling personal data unnecessarily).

**Severity**: P2.

**Remediation**: Define a retention period for this table specifically (e.g., "idempotency only needs to matter for N days after a payment settles; archive/trim older rows after that"), confirm with the business, then implement as a separate migration/scheduled job. Do not implement a deletion job in this phase without that retention number.

**Status**: `BUSINESS_DECISION_REQUIRED`.

---

### P2-03 — `audit_logs` retains full before/after personal-data snapshots indefinitely

**Description**: Every admin-triggered write captures complete `old_values`/`new_values` JSON of the affected row, with no retention limit. This is the correct design for an audit trail (and is explicitly why `audit_logs` exists), but it means the audit log is itself a long-lived store of personal data that needs its own documented retention answer — not a "fix," a decision.

**Evidence**: `list_tables` column listing for `audit_logs`.

**Severity**: P2.

**Remediation**: Document a retention period (likely long, for legitimate accountability reasons) as `BUSINESS_DECISION_REQUIRED`, then (optionally) a scheduled archival job once that number exists.

**Status**: `BUSINESS_DECISION_REQUIRED`.

---

### P2-04 — No user-rights / grievance request tracking

**Description**: The only inbound contact channel is the public, unauthenticated `enquiries` form — not tied to an account, not categorised as a privacy request, no status lifecycle suited to "access/correction/erasure/grievance" handling (it only has `new`/`answered`).

**Evidence**: `enquiries` table schema (`status` check constraint: `'new'`/`'answered'` only); no other request-handling table exists.

**Severity**: P2.

**Remediation**: See `DPDP_IMPLEMENTATION_PLAN.md` §G — a minimal `privacy_requests` table design is proposed there (not created in this phase: statutory response-deadline details need confirming first, and this audit was not asked to create new tables speculatively).

**Update 2026-10-19**: Built: `privacy_requests` and an event trail, member screens on website and app (copy of data, correction, complaint, nomination, other, close account, withdraw a request, follow status), admin handling (list, assign, status with required outcome note, history), and a controlled export for an open access request. Member isolation, admin-only handling and audit entries without personal data are covered by `phase14`. The Rules (Rule 14(3)) require a published grievance process responding within a period **not exceeding ninety days**; that rule starts 18 months after publication, and no deadline is enforced by the software — an optional internal target shows a "we aim to answer by" date only if the club sets one.

**Status**: `IMPLEMENTED_NOT_FULLY_VERIFIED` (the statutory response period needs counsel; the club's own target is optional).

---

### P2-05 — Leaked-password protection disabled

**Description**: Supabase Auth's HaveIBeenPwned check is off project-wide.

**Evidence**: Supabase security advisor (`auth_leaked_password_protection`, WARN).

**Severity**: P2 — easy win, no migration needed (Auth dashboard setting).

**Remediation**: Enable in Supabase Dashboard → Authentication → Policies. Not performed by this audit (a dashboard toggle is still a production change; left for the project owner).

**Status**: `OPEN`.

---

### P3-01 — One function missing `search_path` hardening

**Description**: `public._int_in_range()` is the only function in the project without `set search_path`, inconsistent with the project's own convention. Low actual risk (no table access in the function body).

**Evidence**: Supabase security advisor (`function_search_path_mutable`, WARN).

**Remediation**: `supabase/proposals/0029_search_path_hardening.sql` (+ `.down.sql`) — proposed, **not applied**.

**Update 2026-10-19**: Applied and re-applied on the local replica without error; `_int_in_range` then shows `search_path=public`. Apply live with 0028.

**Status**: `IMPLEMENTED_AND_TESTED` locally; not applied live.

---

### P3-02 — `available_sessions()` callable without authentication

**Description**: Flagged generically by the advisor (`anon_security_definer_function_executable`). On inspection, this is a deliberate design choice from an earlier security-hardening pass (its own code comment says so), returns only aggregate schedule data (no personal data), and is currently only called from authenticated admin pages — so there is no live exposure today, just a broader grant than strictly needed.

**Severity**: P3 — documented for business sign-off, no fix proposed.

**Status**: `VERIFIED` (intentional, low-risk; revisit if/when the public site ever calls it directly and wants a tighter grant).

---

### P3-03 — `attendance.notes` is unstructured free text written by staff about a member

**Description**: Not a code defect, but worth naming: this column can contain anything a staff member types, with no minimisation guardrail. Flag for the eventual data-minimisation/retention pass rather than a security fix.

**Status**: `BUSINESS_DECISION_REQUIRED` (whether/how long to keep, and whether staff need guidance on what belongs there).

---

## Not a gap (verified, documented for completeness)

- `push_deliveries` RLS-enabled-with-no-policy — correct by design (service-role-only table), see audit §5.
- All 21 live `admin_*` RPCs independently enforce `is_admin()`/`is_staff_or_admin()` — see audit §5 and `SUPABASE_SECURITY_AUDIT.md` §2.
- No service-role or third-party secret is present anywhere in the client bundle (`src/`).
- Razorpay webhook signatures are verified with HMAC-SHA256 + timing-safe comparison.
- Payment amounts are computed server-side from `store_products`/`membership_plans`, never trusted from the client.


---

## New gaps found in the 2026-10-19 pass

### G-01 — Children's data: no parental-consent mechanism
The Rules require a parent's verifiable consent for a child's (under 18) data (Rule 10), with exemptions in the Fourth Schedule (Rule 12). CHR collects a date of birth, has age-limited plans, and the admin overview now counts members whose date of birth says they are under 18. No mechanism exists; designing one needs counsel (is CHR exempt for any purpose?) and a business decision. **Status**: `LEGAL_REVIEW_REQUIRED` / `BUSINESS_DECISION_REQUIRED`.

### G-02 — Dangerous cascades if a login is ever deleted
`profiles.id → auth.users ON DELETE CASCADE`; `memberships`, `wallet_ledger`, `referrals`, `referral_codes` cascade from the user. Deleting a user from the Supabase dashboard (or `auth.admin.deleteUser` without soft-delete) can destroy a membership or wallet ledger for a member who has no payments or bookings, and fails for others on foreign keys. Mitigated for the product by the erasure design (no hard delete); **still a risk for anyone deleting users by hand**. Do not change these foreign keys without a reviewed migration. **Status**: `OPEN` (documented; owner decision on changing the constraints).

### G-03 — Notifications and the one-year retention rule
Erasure deletes a member's notifications. Rule 8(3) (from 18 months after publication) requires retaining personal data and logs of processing for at least one year for stated purposes. Whether notification content falls within that, and how it interacts with erasure, is a legal question. The erasure waiting period (`erasure_hold_days`) exists for this. **Status**: `LEGAL_REVIEW_REQUIRED`.

### G-04 — Placeholder public links
The footer's Instagram and Facebook icons still use `href="#"`; `/terms` is an honest "not published" page. **Status**: `BUSINESS_DECISION_REQUIRED`.

### G-05 — Existing members and acknowledgement
Existing members are not recorded as having consented to anything (by design). They see a non-blocking prompt after a notice is published. Whether the law needs a firmer transition at the start date is for counsel. **Status**: `LEGAL_REVIEW_REQUIRED`.

### G-06 — Mobile app verification
The mobile changes are type-checked, linted and covered by 27 logic/API tests and the earlier 261 suites; the release bundle contains no server secret. They have **not** been exercised on a device with a signed-in account. **Status**: `IMPLEMENTED_NOT_FULLY_VERIFIED`.

### G-07 — Android permissions for Play
`SYSTEM_ALERT_WINDOW`, NFC and legacy storage permissions appear in the release build and look unneeded. See `GOOGLE_PLAY_DATA_SAFETY.md` §4. **Status**: `OPEN` (config change not made; would alter the build).

### G-08 — Data held outside the database
Razorpay, Resend, Expo, Google and the web host hold copies of some data. The software cannot erase those. Each needs its own process (see `BUSINESS_DECISIONS_REQUIRED.md` §6). **Status**: `BUSINESS_DECISION_REQUIRED`.
