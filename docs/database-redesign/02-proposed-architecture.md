# Phase 2 — Proposed Database Architecture

Status: **PROPOSAL — not applied.** Nothing in this document or its companion SQL files (`supabase/proposals/*.sql`) has been run against the live project. `supabase/schema.sql` (the currently-applied schema) is untouched.

---

## 1. Existing → New Mapping

| Existing Table | Decision | Reason |
|---|---|---|
| `public.enquiries` | **KEEP**, unmodified structurally | Different domain (anonymous lead capture), fully standalone, already working. |
| `public.enquiries` RLS (SELECT/DELETE `to authenticated`) | **MODIFY** — approved | Tighten from "any authenticated user" to admin-only (`is_admin()` — staff explicitly excluded, per confirmed scope) now that `profiles.role` exists. Policy-only change, zero data risk, zero app-behavior change for the existing admin account (backfilled to `role='admin'`, keeps working identically). |

Everything else proposed below is **net-new** — there is nothing else to merge, deprecate, or delete.

---

## 2. Proposed Schema — Entities

Full DDL lives in `supabase/proposals/0002_riding_club_core.sql`. Summary of each table and why it's shaped the way it is:

### `profiles`
One row per `auth.users` row (1:1, `profiles.id` **is** `auth.users.id`, no separate identity). Auto-created by a trigger on `auth.users` insert, defaulting `role='member'`. Holds `full_name`, `phone`, `email` (denormalized copy for convenient joins/search — kept in sync from `auth.users.email` by the same trigger, not authoritative), `avatar_url`, `date_of_birth` (the sole source of truth for age-gated plan pricing — see `membership_plans` below), `role` (`member`/`staff`/`admin`), `status` (`active`/`suspended`), timestamps.

**Why a trigger, not client-side insert:** guarantees every authenticated user has exactly one profile with no race window, and keeps profile creation out of the client's control entirely (a client could otherwise insert a profile with `role='admin'` for itself if this were a plain client insert).

**Why `role`/`status` need a second guard beyond RLS:** Postgres RLS policies are row-scoped, not column-scoped — a policy that lets a member `UPDATE ... where id = auth.uid()` would, without more, also let them set their own `role` to `'admin'`. The proposal adds a `BEFORE UPDATE` trigger (`prevent_privilege_escalation()`) that rejects any change to `role` or `status` unless the acting user already has `role IN ('staff','admin')`. This is belt-and-braces on top of RLS, not a replacement for it.

### `membership_plans`
Reusable catalog: `name`, `description`, `price numeric(10,2)`, `currency`, `class_credits int`, `validity_days int`, `min_age`/`max_age` (nullable inclusive bounds), `is_active bool`. Confirmed pricing becomes two rows — "Junior Riding Membership" (₹12,000, `max_age=11`) and "Adult Riding Membership" (₹16,000, `min_age=12`) — both 8 credits, 30 days. `begin_membership_purchase()` computes the caller's age from `profiles.date_of_birth` (never a client-supplied value) and rejects a purchase outside the chosen plan's age range. Adding a "12 Class Membership" or "Child Membership" later is one `INSERT`, no schema or React change.

### `memberships`
One row per **purchase attempt/instance** — never overwritten on renewal; a user accumulates history. `user_id`, `plan_id`, `start_date`, `end_date`, `status` (`pending_payment` / `active` / `expired` / `cancelled` / `suspended`), `payment_id` (nullable — set once the activating payment is known), plus a **cached** `credits_remaining int` maintained by trigger from `credit_ledger` (fast reads; the ledger, not this column, is authoritative — see below).

### `payments`
One row per **payment attempt** against a membership (so a failed try followed by a successful retry is two rows, both kept — full audit trail, nothing overwritten). `user_id`, `membership_id`, `gateway` (e.g. `'razorpay'`), `gateway_order_id`, `gateway_payment_id`, `amount`, `currency`, `status` (`created`/`pending`/`processing`/`success`/`failed`/`expired`/`refunded`/`partially_refunded`), `paid_at`, `metadata jsonb` (raw gateway payload, for support/debugging), timestamps.

`gateway_order_id` and `gateway_payment_id` are both `UNIQUE` (nullable-safe — see indexing section). This is what makes webhook processing **idempotent**: a retried webhook for the same `gateway_payment_id` hits the unique constraint / an explicit "already processed" check and is a safe no-op, never a duplicate credit grant.

### `credit_ledger`
Append-only. `user_id`, `membership_id`, `booking_id` (nullable), `amount int` (`CHECK amount <> 0`), `transaction_type` (`membership_purchase`/`booking`/`cancellation`/`admin_adjustment`/`refund`/`expiry`), `description`, `created_by` (nullable — who performed an `admin_adjustment`; null for system-generated rows), `created_at`. **Never UPDATEd or DELETEd** by the application — corrections are new offsetting rows, so the full history is always reconstructable. A membership's true balance is `COALESCE(SUM(amount), 0) FROM credit_ledger WHERE membership_id = X`; `memberships.credits_remaining` is a trigger-maintained cache of exactly that query, kept only for fast reads.

### `horses`
`name`, `description`, `status` (`available`/`maintenance`/`rest`/`medical`/`retired`), `is_active bool`. Nothing about "3 horses" is encoded anywhere — capacity is derived from the count of active/available horses **at the moment a session is generated**, then stored concretely on that session (see below), so admins can add a 4th horse or retire one without silently changing already-booked sessions' capacity retroactively.

### `schedule_templates`
The recurring weekly pattern (`day_of_week 0–6`, `start_time`, `end_time`, `capacity` nullable-override, `is_active`). This is what an admin edits to say "Mondays now also have a 5th session" — it does **not** itself represent bookable slots.

### `class_sessions`
One row per **actual, concrete, bookable occurrence** on a specific date (`session_date`, `start_time`, `end_time`, `capacity int not null`, `status` `open`/`closed`/`cancelled`/`completed`, `template_id` nullable — which template generated it, for traceability). `capacity` is resolved and **frozen** at generation time (from the template's override or the active-horse count), then only changed afterward via an explicit admin action — exactly the "default capacity + session-level override" behavior requested, without capacity silently drifting if horse status changes later. `UNIQUE(session_date, start_time, end_time)` prevents accidentally generating the same slot twice.

Generation is a small `generate_sessions(from_date, to_date)` function that reads `schedule_templates` and inserts the missing `class_sessions` rows for that date range (`ON CONFLICT DO NOTHING` against the unique constraint) — run by an admin action or a scheduled job, not thousands of manually-inserted rows.

### `bookings`
`user_id`, `membership_id`, `session_id`, `horse_id` (**nullable** — capacity is reserved immediately; horse assignment can follow, automatically or by staff), `status` (`held`/`confirmed`/`cancelled`/`completed`/`no_show`/`expired`), `booked_at`, `cancelled_at`, `completed_at`, `cancellation_reason`. A partial unique index — `UNIQUE(user_id, session_id) WHERE status IN ('held','confirmed')` — makes "a user can't double-book the same session" a hard database guarantee, not just application logic, while still allowing a cancelled-then-rebooked history for the same user/session pair.

### `attendance`
`booking_id` (`UNIQUE` — one attendance record per booking), `status` (`present`/`absent`/`no_show`/`excused`), `marked_by`, `marked_at`, `notes`.

### `system_settings`
Simple key/value (`key text primary key`, `value jsonb`, `description`, `updated_at`) for `cancellation_cutoff_hours`, `default_session_capacity`, `booking_window_days`, `max_future_bookings`, `waitlist_enabled` — read by both the frontend (to *display* the cancellation policy) and by `cancel_booking()` (to *enforce* it), so the rule lives in exactly one place.

### `audit_logs`
`table_name`, `record_id`, `action`, `performed_by`, `old_values jsonb`, `new_values jsonb`, `created_at`. Written by triggers on the sensitive tables (`memberships`, `payments`, `credit_ledger`, admin actions) — gives "who changed what, when" without hand-rolling it per table.

---

## 3. ERD

```
auth.users (Supabase-managed)
    │ 1:1 (trigger-created)
    ▼
profiles ────────────────────────────────────────────┐
    │ role: member/staff/admin                        │ marked_by
    │ 1:N                                              │
    ▼                                                  │
memberships ◄────────────┐                             │
    │  N:1                │ payment_id (nullable)      │
    │  plan_id             │                            │
    ▼                      │                            │
membership_plans           │                            │
                            │                            │
memberships ──1:N──► payments                            │
    │                  (unique gateway_order_id,          │
    │                   unique gateway_payment_id)        │
    │                                                     │
    ▼                                                     │
credit_ledger ◄──────────────────────────┐                │
    │ N:1 membership_id, N:1 user_id      │ -1 on booking  │
    │                                      │ +1 on eligible │
    ▼                                      │   cancellation │
bookings ──N:1──► class_sessions ──N:1──► schedule_templates│
    │  N:1 membership_id                       │            │
    │  N:1 horse_id (nullable) ────────► horses │            │
    │                                                        │
    ▼                                                        │
attendance ─────────────────────────────────────────────────┘

system_settings         audit_logs
  (standalone config)     (written by triggers on the tables above)
```

Cardinalities: `auth.users 1—1 profiles`, `profiles 1—N memberships`, `membership_plans 1—N memberships`, `memberships 1—N payments`, `memberships 1—N credit_ledger`, `memberships 1—N bookings`, `class_sessions 1—N bookings`, `schedule_templates 1—N class_sessions`, `horses 1—N bookings` (nullable), `bookings 1—1 attendance`.

---

## 4. RLS Architecture

Full policy SQL in `supabase/proposals/0003_riding_club_rls.sql`. All tables below have RLS **enabled**; anything not explicitly granted is denied by default (Postgres/Supabase default-deny).

| Table | Member (own data) | Staff | Admin | Notes |
|---|---|---|---|---|
| `profiles` | SELECT own, UPDATE own (name/phone/avatar only — role/status guarded by trigger) | SELECT all | SELECT all, UPDATE all | |
| `membership_plans` | SELECT where `is_active` | SELECT all | ALL | Public-readable catalog (even `anon`, for a pricing page) |
| `memberships` | SELECT own | SELECT all, UPDATE (status/dates only — not credits) | SELECT all, UPDATE all | No member INSERT/UPDATE — created only via `create_payment_order`/webhook path |
| `payments` | SELECT own | SELECT all | SELECT all | **No INSERT/UPDATE policy for `anon`/`authenticated` at all** — only `service_role` (bypasses RLS by default) via the webhook Edge Function writes here |
| `credit_ledger` | SELECT own | SELECT all | SELECT all | **No direct INSERT for anyone** — only via `SECURITY DEFINER` RPCs (`book_class`, `cancel_booking`, `activate_membership`, `admin_adjust_credits`) |
| `horses` | SELECT (active only) | SELECT all | ALL | |
| `schedule_templates` | — | SELECT | ALL | Members don't need this directly |
| `class_sessions` | SELECT | SELECT | ALL | Availability must be visible to browse/book |
| `bookings` | SELECT own | SELECT all, UPDATE (reschedule/assign horse) | SELECT all, UPDATE all | No member INSERT/UPDATE — only via `book_class`/`cancel_booking` RPCs. Admin "manually create booking" also goes through a privileged RPC (`admin_create_booking`), **not** a raw INSERT policy — a manual admin booking must obey the same capacity lock as everyone else, or the whole anti-double-booking guarantee has a back door. |
| `attendance` | SELECT own (via booking join) | INSERT/UPDATE (mark attendance), SELECT all | ALL | |
| `system_settings` | SELECT | SELECT | UPDATE | |
| `audit_logs` | — | — | SELECT | Written by triggers, not client writes |

**Helper functions used by policies:** `public.is_staff_or_admin()` and `public.is_admin()`, both `SECURITY DEFINER STABLE`, checking `profiles.role` for `auth.uid()`. Written once, reused across every policy above instead of repeating the `EXISTS (SELECT ... FROM profiles ...)` subquery in every single policy.

**The core principle carried through every write-heavy table:** *nothing security- or capacity-critical is writable by a plain client INSERT/UPDATE.* Every state transition that affects money, credits, or slot capacity happens inside a `SECURITY DEFINER` function that does its own authorization check via `auth.uid()`, not by trusting the RLS-permitted shape of a client request.

---

## 5. Database Functions / RPCs

Full SQL in `supabase/proposals/0004_riding_club_functions.sql`.

### `book_class(p_session_id uuid) returns bookings`
The critical one. `SECURITY DEFINER`. Inside a single implicit transaction:
1. Resolve `auth.uid()`; reject if not authenticated.
2. `SELECT ... FROM class_sessions WHERE id = p_session_id FOR UPDATE` — **row lock**. A second concurrent call for the same session blocks here until the first transaction commits or rolls back; this is what makes the whole operation safe under concurrency, not an application-level check-then-insert.
3. Verify `status = 'open'` and the session hasn't already started.
4. `SELECT ... FROM memberships WHERE user_id = auth.uid() AND status = 'active' AND end_date >= current_date ORDER BY end_date DESC LIMIT 1 FOR UPDATE` — lock the membership too, so two simultaneous bookings against *different* sessions on the same membership can't both read "1 credit left" and both succeed.
5. Compute live balance from `credit_ledger` (not the cached column); reject if `<= 0`.
6. Reject if the user already holds an active booking for this session (belt-and-braces — the partial unique index would catch it regardless).
7. **Weekly cap — max 3 bookings per 7-day block.** Blocks are fixed, non-overlapping, and anchored to the membership's own `start_date` — *not* calendar Mon–Sun, per the confirmed business rule. Block index = `(session_date - membership.start_date) / 7` (integer division); a candidate session belongs to block N, and the count of the member's `held`/`confirmed`/`completed`/`no_show` bookings whose *own* session also falls in block N must be `< 3` (`cancelled`/`expired` bookings correctly don't count — they freed their slot). The final block of a 30-day membership is a 2-day tail (day 28–29) and still carries the same cap of 3, matching the confirmed example. On rejection, raises `WEEKLY_LIMIT_REACHED` with the exact next-eligible date (`start_date + 7 * (block_index + 1)`) in the exception's `DETAIL`/`HINT` — the frontend reads this rather than recomputing it, so the displayed message and the enforced rule can never drift apart.
   - **Design choice, flagged explicitly:** this is a *fixed*-block interpretation of "any 7-day period," matching the worked example given (Sep10–16 / Sep17–23 / ...), not a fully sliding window re-checked for every possible 7-day span. The tradeoff: fixed blocks permit 3 bookings on a block's last 3 days plus 3 more on the next block's first 3 days (6 in 6 days) — a true sliding window would close that gap but is substantially more complex to reason about and to give the member an exact "book again from" date for. Went with fixed blocks per the given example; flag if sliding-window semantics were actually intended.
8. Count existing `held`/`confirmed` bookings for the session (this check, unlike the weekly cap, only cares about *currently occupied seats*, so `completed`/`no_show` from past sessions correctly don't apply here); reject if `>= capacity`.
9. `INSERT` the booking (`status = 'confirmed'`), `INSERT` the `-1` ledger row, return the booking row.

Any failure at any step raises an exception, which rolls back everything from that call — no partial state (a booking without a matching ledger debit, or vice versa) is possible. Total credits per membership are unaffected by this rule — still exactly `plan.class_credits` (8) — the weekly cap only paces *when* those 8 can be used, it never changes how many exist.

### `cancel_booking(p_booking_id uuid) returns bookings`
`SECURITY DEFINER`. Locks the booking row, verifies it belongs to `auth.uid()` (or caller is staff/admin), checks it's `held`/`confirmed`. Reads `cancellation_cutoff_hours` from `system_settings`, compares to the session's start time. If outside the cutoff (or a staff/admin cancellation, per policy), inserts a `+1` ledger row; if within cutoff, does not. Sets `status='cancelled'`, `cancelled_at`, `cancellation_reason`.

### `process_payment_webhook(...)`
Callable **only by `service_role`** — invoked from a Supabase Edge Function that receives the payment gateway's webhook, verifies its signature server-side (never trusting the payload alone), then calls this function with the verified, gateway-confirmed fields. Looks up the `payments` row by `gateway_order_id`; if `gateway_payment_id` is already recorded and `status = 'success'`, returns immediately (idempotent no-op — handles gateway webhook retries safely). Otherwise updates `payments` (`status`, `gateway_payment_id`, `paid_at`, `metadata`) and, on success, calls `activate_membership`.

### `activate_membership(p_membership_id uuid)`
`SECURITY DEFINER`, idempotent (only acts if the membership is still `pending_payment`): sets `status='active'`, `start_date=now()`, `end_date = start_date + (plan.validity_days - 1)` (inclusive span — a 30-day plan starting Sep 10 ends Oct 9, matching the confirmed weekly-block example, not Oct 10), sets `payment_id`, and inserts the `+class_credits` ledger row.

### `create_payment_order(p_plan_id uuid)`
Implemented as an **Edge Function**, not a pure SQL RPC — creating the order requires an authenticated outbound call to the payment gateway's API (needs a secret key, which must never reach the browser). The Edge Function calls the gateway, then calls a small SQL helper (`begin_membership_purchase`) to insert the `pending_payment` membership + `created` payment row referencing the gateway's order id.

### `admin_adjust_credits(p_membership_id uuid, p_amount int, p_reason text)`
`SECURITY DEFINER`, checks `is_staff_or_admin()` internally (not just via RLS), inserts a `credit_ledger` row with `transaction_type='admin_adjustment'`, `created_by = auth.uid()`, `description = p_reason`.

### `admin_create_booking(...)` / `admin_reassign_horse(...)`
Staff/admin equivalents of `book_class` that still take the same session row lock and capacity check — an admin-created booking must obey the same capacity guarantee as a member-created one.

### View: `class_sessions_availability`
```sql
select s.*, count(b.id) filter (where b.status in ('held','confirmed')) as booked_count,
       s.capacity - count(b.id) filter (where b.status in ('held','confirmed')) as available_slots
from class_sessions s left join bookings b on b.session_id = s.id
group by s.id;
```
The frontend reads this (or an `available_sessions(p_date)` thin wrapper) to **display** availability — it is never the source of truth for whether a booking succeeds; only `book_class`'s row-locked check is.

---

## 6. Migration Plan

```
Existing state: one table (enquiries), no auth-linked profile data, no booking domain.
        ↓
1. Apply 0002_riding_club_core.sql — create all new tables (additive only, nothing existing touched).
        ↓
2. Apply 0003_riding_club_rls.sql — enable RLS + policies on the new tables.
        ↓
3. Apply 0004_riding_club_functions.sql — create RPCs, triggers, the availability view.
        ↓
4. Backfill: for every existing row in auth.users (today: just the admin account(s) created
   manually via the Supabase dashboard), insert a matching `profiles` row — the auto-create
   trigger only fires on *future* auth.users inserts, so pre-existing accounts need one manual
   backfill INSERT. Set the known admin account(s)' role='admin' explicitly (you'll need to
   supply which email(s) — I won't guess).
        ↓
5. (Optional, recommended) Apply the `enquiries` RLS tightening — swap "to authenticated" for
   "is_staff_or_admin()" on the SELECT/DELETE policies, now that role exists.
        ↓
6. Apply 0005_seed_dev_data.sql in a DEV/STAGING project only — 3 horses, one weekly
   schedule_templates set, one membership_plan, and generated class_sessions for the
   next ~14 days. Never run against the live project with real enquiries data unless you
   want that seed data live too.
        ↓
7. Validation (Phase 5, after approval + implementation — concurrency test, RLS test, etc.)
        ↓
8. Application migration (Phase 4) — wire the React app to the new tables/RPCs.
```

**Data-loss risk: none.** Every step above is additive (`CREATE TABLE`, `CREATE POLICY`, `CREATE FUNCTION`) except step 5, which only changes *who* an existing policy trusts — it doesn't touch any row in `enquiries`. Nothing is dropped, renamed, or altered destructively anywhere in this plan.

---

## 7. Application Impact (Phase 4 preview — not done yet)

Nothing existing breaks from applying the schema alone (it's purely additive), but building the actual member/booking experience will eventually need:

- **New:** registration/login pages, a member dashboard, a membership purchase flow (plan selection → Edge Function → payment gateway redirect → return/confirmation page), a booking calendar UI calling `book_class`/`cancel_booking`, new admin panel pages (Memberships, Payments, Sessions, Horses, Bookings, Attendance) alongside the existing Overview/Enquiries.
- **Modified:** `src/admin/AdminLayout.jsx` sidebar (new nav sections), possibly `src/context/EnquiryModalContext.jsx`-style contexts for the new auth/member session if member auth needs different UI than the admin-only auth currently in `src/admin/`.
- **Unmodified:** everything under `EnquiryModal`, `useEnquiries`, and the existing admin Overview/Enquiries pages — they keep working exactly as-is against `enquiries`, untouched by any of this.

This redesign delivers the **database and RPC layer only**. None of the above React work is implied by database approval — it would be its own follow-up scoped separately, per "avoid unnecessary complexity" / "don't over-engineer what isn't currently required."
