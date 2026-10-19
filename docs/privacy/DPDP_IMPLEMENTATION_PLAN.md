# CHR — DPDP Implementation Plan

This orders the remaining work by dependency, not just priority — several stages are blocked on a business or legal answer and should not be jumped ahead of.

---

## Stage 0 — Already done in this phase

- Repository + live-database read-only audit (`DPDP_DATA_AUDIT.md`).
- Gap register (`DPDP_GAP_REGISTER.md`).
- Retention matrix (`DATA_RETENTION_MATRIX.md`).
- Security audit (`SUPABASE_SECURITY_AUDIT.md`).
- Two safe, non-business-logic security migrations **proposed but not applied**: `0028_privilege_escalation_fix.sql`, `0029_search_path_hardening.sql`.

## Stage 1 — Business decisions required (blocks almost everything else)

These cannot be guessed or defaulted. Collect from the CHR business owner before Stage 2:

1. **Legal entity name** that will appear as the "data fiduciary" in the privacy notice.
2. **Registered office address / business address** for the notice.
3. **Privacy contact email/phone** (can be a new inbox, e.g. `privacy@colonelhorseriding...`).
4. **Grievance officer name and contact** (the DPDP Rules require a named grievance mechanism — a role/title is acceptable if a specific person isn't settled yet, but it must be real and reachable).
5. **Retention periods** for: `payments`/`orders` (accounting-driven — check with an accountant/CA for the applicable Indian retention minimum, separately from any DPDP maximum), `payment_webhook_events` (idempotency-driven, likely much shorter than payments themselves), `audit_logs` (likely long, for accountability), `attendance.notes` free text, stale `notifications`.
6. **Account-deletion policy**: what happens to an active membership/future bookings when a member requests deletion? (Cancel and refund? Block deletion until the membership lapses? This is a business rule, not a technical one, and the technical implementation in Stage 4 depends on the answer.)
7. **Vendor data-processing confirmations**: has anyone reviewed Razorpay's, Resend's, and Expo's data-processing terms for a DPDP-relevant commitment? (Not something this audit can determine — it requires reading each vendor's current terms/DPA, which is a one-time legal/ops task, not a code task.)

## Stage 2 — Legal review required

1. Confirm the **exact commencement status** of each relevant DPDP Rules provision against the official MeitY notifications (this audit's environment had no network access to re-verify the URLs in the task brief at the time of writing — **do this before relying on any "not yet enforceable" assumption anywhere in this plan**).
2. Confirm the DPDP Act §8(5)/§8(6) characterisation of **P1-01** (staff self-escalation) as a reportable-class security gap vs. an internal hardening item — this audit treats it as the latter in urgency (fixed via code, not a breach that already happened) but counsel should confirm no disclosure obligation is triggered by the *existence* of the gap itself (as opposed to evidence of exploitation, which this audit found none of).
3. Confirm required **content and format** of the Privacy Notice (Stage 3) against the Rules' Schedule/format requirements, if any are prescribed.
4. Confirm **statutory response timelines** for access/correction/erasure/grievance requests (needed before Stage 5's request-tracking table can set real SLA fields).
5. Confirm whether the **enquiries form** (unauthenticated, no notice today) needs a standalone notice given it collects name/age/email/phone from non-members.

## Stage 3 — Privacy notice and consent (depends on Stage 1 + 2)

1. Author a real Privacy Policy page (static content page in the public site) once Stage 1's business facts and Stage 2's content requirements are in hand. **Do not publish a placeholder.**
2. Wire the two dead footer links (`src/components/Footer/Footer.jsx:125-130`) to the real page and a Terms page.
3. Add a visible, non-blocking link to the notice on `AuthScreen.jsx`'s register step (e.g. "By creating an account you agree to our Privacy Policy" with a real link) — a link-and-acknowledge pattern, not necessarily a blocking checkbox, pending Stage 2's confirmation of what legal basis actually applies to account creation (likely **contract necessity**, not consent, for the core service — meaning a consent checkbox may not even be the right mechanism here; confirm before building one, per the brief's own instruction not to add a generic consent checkbox reflexively).
4. Add the same link to the public `enquiries` form (the one place unauthenticated personal data is collected today with zero notice).
5. **Existing users**: do not fabricate retroactive consent or backdate anything. If a notice-acknowledgement record is needed for existing accounts, the correct approach is a one-time, clearly-dated "we've updated our privacy notice" prompt shown once at next sign-in — a real, dated, unfabricated record of that specific interaction, not a backfilled claim about the past.
6. If and only if Stage 2 confirms a *separate*, consent-based purpose exists (e.g. optional marketing communications), build a dedicated, versioned consent record for that purpose alone — never bundled with account creation or a membership purchase.

## Stage 4 — Account deletion (depends on Stage 1.6)

Follow the dependency map already documented in `DPDP_GAP_REGISTER.md` P1-03. Implementation sketch once retention periods are confirmed:

1. New authenticated RPC, `request_account_deletion()` — scoped to `auth.uid()` only, cannot target another user.
2. The RPC does **not** delete synchronously. It flags the account (e.g. a new `profiles.deletion_requested_at` column) and the actual anonymisation/deletion runs as a reviewable, retryable job — because partial failures must be recoverable (per the brief's own constraint), and some tables need to wait for retention periods to lapse (e.g. a payment made yesterday can't be touched yet even if the account is "deleted" today).
3. Idempotent: running the job twice on the same account is safe.
4. Logged: every deletion/anonymisation step writes its own `audit_logs` row (`action = 'ACCOUNT_DELETION_STEP'`), for a defensible record that the request was honoured.
5. Blocked by an active membership or future booking **only if** Stage 1.6 says so — otherwise cancel them as part of the job.

## Stage 5 — User rights and grievance tracking (depends on Stage 2.4)

Minimal table design (not created in this phase — proposed only):

```sql
-- PROPOSAL, not created. Depends on Stage 2.4 (statutory deadlines) and
-- Stage 1.3 (who the grievance contact is / who gets assigned requests).
create table public.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  category text not null check (category in ('access', 'correction', 'erasure', 'consent_withdrawal', 'grievance', 'other')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'rejected')),
  notes text,                      -- minimal processing notes only — never a copy of the member's full profile
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  assigned_to uuid references public.profiles(id)
);
```

RLS: member can `select`/`insert` their own rows; staff/admin can `select`/`update` all. No deadline columns until Stage 2.4 supplies real numbers.

## Stage 6 — Minimisation and scheduled retention jobs (depends on Stage 1.5)

Only after retention periods are confirmed: scheduled jobs (pg_cron or an Edge Function on a schedule) to trim/anonymise `payment_webhook_events` and stale `notifications` per the agreed periods. **Not built in this phase.**

## Stage 7 — Testing

See `DPDP_DATA_AUDIT.md` for what was already verified by direct inspection (no live exploit was attempted; findings come from reading code/schema and the security advisor, not penetration testing). Before Stage 3–6 ship:

- Confirm (in a non-production environment) that `0028_privilege_escalation_fix.sql` actually blocks a `staff`-role `UPDATE ... SET role = 'admin'` on the actor's own row, and does **not** block `admin_set_role()`'s legitimate admin-initiated path.
- Confirm the account-deletion RPC (once built) rejects a request for any `user_id` other than `auth.uid()`.
- Confirm partial-failure retry safety for the deletion job with a forced mid-job failure in a test environment.

## Vendor data-flow summary (for Stage 1.7)

| Vendor | Data sent | Data received | Why | CHR's control | Open question |
|---|---|---|---|---|---|
| Supabase | All of the above | — | Hosting, DB, Auth | Full (own project) | Supabase's own sub-processor/DPA terms — not reviewed here |
| Razorpay | Amount, currency, order/payment refs; checkout UI collects card/UPI directly, never touching CHR's server | Payment status, payment/order IDs, webhook events | Payment processing | None over how Razorpay stores payment-instrument data (by design — PCI scope reduction) | Razorpay's DPA/retention terms — not reviewed here |
| Resend | Enquiry name/age/email/phone/topic, in the notification email body | Delivery status | Notify staff of a new enquiry | Minimal (one send, not stored by CHR beyond the `enquiries` row itself) | Resend's retention of sent-email content — not reviewed here |
| Expo | Push token, notification title/body | Delivery receipt/ticket | Push delivery | None over Expo's own infra | Expo's retention/DPA terms — not reviewed here |
| Google | OAuth handshake only (email, name, profile picture URL, per standard OAuth scopes) | Identity confirmation | Sign-in convenience | None over Google's own processing | Confirm which OAuth scopes are actually requested (not traced to the exact scope list in this pass) |

No new analytics, tracking, or data-sharing integration was added or proposed as part of this phase, per the task's own constraint.
