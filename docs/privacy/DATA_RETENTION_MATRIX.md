# CHR — Data Lifecycle and Retention Matrix

No universal retention period is assumed anywhere below. Every "BUSINESS DECISION REQUIRED" cell means exactly that — a number has not been invented, and none should be, until the business owner confirms it (and, where relevant, legal counsel confirms any statutory minimum).

| Category / table | Purpose | Location | Who can access (via RLS/RPC) | Shared with 3rd party | In logs/exports? | Current retention behavior | Deletion/anonymisation supported? | Open decision |
|---|---|---|---|---|---|---|---|---|
| Identity — `profiles` | Account record, 1:1 with `auth.users` | Supabase Postgres | Self (own row); staff/admin (all rows) | No | `audit_logs` captures before/after on admin edits | Indefinite | No | Retention period; anonymise-on-deletion design (P1-03) |
| Identity — `auth.users` | Credentials, session state, OAuth identity | Supabase Auth | Supabase Auth only; not directly queried by CHR app code | Google (if OAuth used) | Supabase's own auth logs (not CHR-controlled) | Indefinite (until deleted via Auth admin API) | Yes, via `supabase.auth.admin.deleteUser()` (not yet wired into any CHR flow) | Who/what triggers this; see P1-03 |
| Membership — `membership_plans` | Catalog (not personal data) | Postgres | Public read (catalog) | No | No | Indefinite | N/A | None |
| Membership — `memberships` | A member's plan instance + credit balance | Postgres | Self; staff/admin | No | `audit_logs` on admin edits | Indefinite | No (see P1-03 dependency map) | Retention vs. accounting need |
| Membership — `credit_ledger` | Append-only ledger backing credit balance | Postgres | Self; staff/admin | No | No | Indefinite, append-only (never UPDATE/DELETE by design) | No | Confirm this is acceptable to keep forever (it is the accounting trail for credits — likely yes, but confirm) |
| Booking — `class_sessions`, `schedule_templates` | Scheduling data (mostly not personal) | Postgres | Member-readable (own-booking context); admin full | No | No | Indefinite | N/A | None |
| Booking — `bookings` | A member's seat in a session | Postgres | Self; staff/admin | No | `audit_logs` on admin cancel/excuse | Indefinite | No | Retention vs. accounting/attendance history |
| Booking — `attendance` | Present/absent/no_show/excused + staff notes | Postgres | Self (read); staff/admin (write) | No | `audit_logs` on edits | Indefinite | No | Free-text `notes` minimisation (P3-03); retention period |
| Booking — `waitlist_entries`, `recurring_schedules/_slots/_occurrences` | Waitlist and standing weekly bookings | Postgres | Self; staff/admin | No | No | Indefinite | No | Likely safe to hard-delete on account closure — low sensitivity, no accounting need identified |
| Payment — `payments` | Razorpay payment record (refs, amount, status) | Postgres | Self; staff/admin | Razorpay (order/payment IDs only — no card/UPI detail ever reaches CHR's DB) | `audit_logs`? (not confirmed for payments specifically) | Indefinite | No — **retain for accounting/dispute purposes** | Exact retention period (accounting law minimum + business preference) |
| Payment — `payment_webhook_events` | Full raw Razorpay webhook payload, for idempotency | Postgres | Not exposed to clients at all (service-role only) | N/A (already Razorpay's own data, round-tripped) | No | Indefinite | No | **P2-02**: define how long the full payload needs keeping vs. how long idempotency actually requires it |
| Payment — `orders`, `order_items` | Store checkout orders | Postgres | Self; staff/admin | No | No | Indefinite | No | Same accounting-retention question as `payments` |
| Notifications — `push_devices` | Expo push token per device | Postgres | Self; staff/admin (implicitly, via RPCs) | Expo (token only) | No | Indefinite (device-limit eviction only disables, doesn't delete) | Yes — `unregister_push_device()` deletes by token | Should `disabled_at` rows ever be hard-deleted after N days? |
| Notifications — `notifications`, `push_deliveries` | Notification content + delivery attempts | Postgres | Self (`notifications`, own rows); `push_deliveries` not client-exposed at all | Expo (delivery only) | No | Indefinite | No | Retention for stale/read notifications; likely safe to trim after a fixed window |
| Referral — `referral_codes`, `referrals`, `wallet_ledger` | Referral code, referrer↔referred link, reward ledger | Postgres | Self (own code/balance); staff/admin | No | No | Indefinite | No | `referrals`/`wallet_ledger` reference `auth.users` directly — needs its own plan once account deletion exists |
| Admin/audit — `audit_logs` | Before/after snapshot of every admin-triggered write | Postgres | Admin-only (read); system-written | No | This *is* the log | Indefinite | No — **by design, this is the audit trail** | **P2-03**: confirm an acceptable retention period; do not delete without one |
| Admin/audit — `system_settings` | Operational config (not personal data) | Postgres | Admin (write); effectively public-readable config values | No | No | Indefinite | N/A | None |
| Enquiries — `enquiries` | Public contact-form submissions (name/age/email/phone/topic) | Postgres | Staff/admin only (not the submitter — no account) | Resend (email notification only, not storage) | Sent once via `enquiry-email` | Indefinite | No | Retention period; this is the one place an unauthenticated person's personal data is collected with **zero notice of any kind** today — highest-priority notice gap alongside registration (see Gap Register P1-02) |

## Legend

- "Shared with 3rd party" lists only services that receive the *field in that row*, not every integration CHR has.
- "No deletion support" does not mean deletion is prohibited — it means no code path exists yet. See `DPDP_GAP_REGISTER.md` P1-03 for the full dependency map before building one.


---

## Update 2026-10-19

- Nine retention categories now exist as rows in `retention_rules` (Admin → Privacy → Retention), **all unapproved**. No retention period appears anywhere as a fact; every figure in this matrix remains a proposal for the owner, accountant and counsel to approve.
- `admin_retention_preview` only **counts** records past an approved period. **No automatic deletion job exists or was added.** Any future purge must be a separate, reviewed migration.
- Erasure of one member (0031, disabled by default) removes: profile identifying columns (row kept), push devices, notifications, weekly schedules, referral code. It keeps: payments, orders, memberships, wallet ledger, bookings, attendance, audit log, consent and privacy-request records.
- Open legal questions: statutory minimum for payment/accounting records (accountant); the Rules' one-year retention of data and logs (Rule 8(3); Rule 6(1)(e)) vs erasure — `LEGAL_REVIEW_REQUIRED`; audit-log snapshots that keep pre-erasure name/phone — `BUSINESS_DECISION_REQUIRED`.


---

## Update 19 Oct 2026 (0032)

- **15 retention categories** now exist (Admin → Privacy → Retention), all **unapproved** with no period. Added: member profiles, authentication records, memberships and credits, bookings and attendance, push delivery logs, uploaded documents (none are collected today: no storage buckets, no avatars set).
- **A cleanup executor exists** (`admin_run_retention`), **nothing schedules it and it is off.** It is a dry run unless called with `p_dry_run => false`; it refuses unless the rule is approved, not under legal hold, and `retention_cleanup_enabled` is `true`; it works in batches of 5000, is safe to run again and writes an audit entry.
- **What it may ever touch** (five low-risk categories): notifications (their delivery logs go with them by foreign-key cascade), switched-off phone-alert codes, push delivery logs, **answered** enquiries, and the free-text note on an attendance record (the record stays).
- **What it never touches, even if a period is approved:** payments and orders, payment-provider payloads, audit logs, privacy requests, consent evidence, profiles, memberships and credits, bookings and attendance, authentication records, uploaded documents. These need a reviewed manual decision (`BUSINESS_DECISIONS_REQUIRED.md` item 4).
- Erasure additionally requires a recorded identity check and now closes only when the database sees the login disabled.
