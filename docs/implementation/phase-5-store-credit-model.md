# Phase 5 — Store → Membership → Booking → Attendance → Rescheduling

**Status: PARTIAL.** Application code, migrations and tests are written; the
frontend builds, lints (warnings only) and 17 unit tests pass. **The database
migrations have NOT been applied to Supabase and nothing in SQL has been
executed or tested**, because the migration tool call was declined twice. The
end-to-end scenario therefore has **not** been run.

## 1. Audit (what existed)

| Area | Found |
|---|---|
| Stack | React 19 + Vite, no router (pathname switch in `main.jsx`), Supabase (Auth, Postgres, Edge Functions), Razorpay |
| Auth | `AuthProvider` (`supabase.auth`), `profiles` row via `handle_new_user()` trigger, role on `profiles.role`; `AccountLogin` page at `/account`; admin gate on `profile.role` |
| DB (live) | `profiles, membership_plans, memberships, payments, payment_webhook_events, credit_ledger, horses, schedule_templates, class_sessions, bookings, attendance, audit_logs, system_settings, enquiries`. Data: 2 profiles, 3 horses, 124 past sessions (1–30 Sep 2026), 0 memberships/payments/bookings/ledger/attendance |
| RPCs | `book_class(uuid)`, `cancel_booking`, `activate_membership`, `process_payment_webhook`, `attach_gateway_order`, `admin_*`, `member_booking_eligibility`, … |
| Payments | Razorpay: `razorpay-create-order`, `razorpay-verify-payment`, `razorpay-webhook` edge functions → `process_payment_webhook()` (idempotent via `payment_webhook_events.event_id`) |
| Old rules in the way | age-banded Junior/Adult plans; `weekly_class_limit=3` per 7-day block; one-active-membership-per-user unique index; `bookings.horse_id` never set (no per-horse protection); 4 daily slots incl. Monday and 06:00; cancel returned the credit inside a 24h window |
| Missing | store/orders/products, notifications, reschedule, horse picker, absence restore, homepage auth |

The "exactly 2 classes" rule was a property of the source Excel only; it does
not exist anywhere in the repo or DB, so there was nothing to remove. **The
Excel (`horse_riding_schedule_exactly_2_classes.xlsx`) was not available**; the
session structure was taken from the brief's text (Tue–Sun; 07–08, 08–09,
16–17, 17–18, 18–19; 3 horses).

## 2. What was reused / changed / created

**Reused:** `profiles`, `membership_plans`, `memberships`, `payments`,
`credit_ledger` (append-only), `bookings`, `attendance` (unique per booking),
`class_sessions`/`schedule_templates`, `audit_logs`, `system_settings`, the
whole Razorpay edge-function chain, `AuthProvider`, member + admin design
systems.

**Changed:** `book_class` (now takes a horse), `cancel_booking`,
`admin_mark_attendance`, `process_payment_webhook`, `handle_new_user`,
`member_booking_eligibility`, `member_current_block_usage`,
`razorpay-create-order`, dashboard/booking/admin attendance screens.

**New:** `store_products`, `orders`, `order_items`, `notifications`;
`create_order`, `fulfill_order`, `store_catalog`, `session_horse_availability`,
`reschedule_booking`, `admin_session_roster`, `admin_set_order_status`,
`admin_set_product_price`, `mark_notifications_read`, booking state-machine
trigger; Store/Cart/Checkout UI; homepage Login/Register modal; admin Schedule,
Orders, Notifications pages.

## 3. Files

SQL (apply in order): `supabase/proposals/0016_store_credit_model.sql`,
`0017_store_credit_functions.sql`; rollback `0016_store_credit_model.down.sql`;
DB test `supabase/tests/phase5_e2e.sql`.

Edge function (edited, **not deployed**): `supabase/functions/razorpay-create-order/index.ts`.

Frontend — new: `src/components/AuthModal/AuthModal.jsx`,
`src/context/AuthModalContext.jsx`, `src/store/{StoreApp.jsx,CartContext.jsx,cartMath.js,useCatalog.js}`,
`src/account/booking/SlotPicker.jsx`, `src/account/bookingErrors.js`,
`src/account/dashboard/{RescheduleDialog,ClassHistory,NotificationsCard}.jsx`,
`src/admin/pages/{AdminSchedule,AdminOrders,AdminNotifications}.jsx`;
modified: `main.jsx`, `App.jsx`, `Navbar.jsx`, `AccountApp.jsx`,
`AccountDashboard.jsx`, `BookClasses.jsx`, `MemberLayout.jsx`,
`MembershipCard.jsx`, `UpcomingClasses.jsx`, `useMemberDashboard.js`,
`RazorpayPaymentFlow.jsx`, `account/ui.jsx`, admin `ui.jsx`, `adminNav.js`,
`adminApi.js`, `AdminApp.jsx`, `useAdminRoute.js`, `AdminAttendance.jsx`,
`AdminBookings.jsx`. Unused now: `src/account/MembershipPurchase.jsx`.

## 4. Database changes (in 0016 / 0017)

- **membership_plans:** `plan_code`, `reschedules_allowed`, `kind`; Junior/Adult deactivated (not deleted); Gold ₹15,000/8, Platinum ₹18,000/12, One-Time Ride ₹2,000/1 (30-day validity kept; one-time ride = 1 reschedule, configurable per plan row).
- **memberships:** `total_credits`, `reschedules_allowed`, `reschedules_used` (+check), `order_item_id` (unique → idempotent activation); dropped the one-active-per-user index.
- **credit_ledger:** types `absence_restore`, `reschedule` (zero-amount allowed only for reschedule); unique `(booking_id)` where `absence_restore`.
- **bookings:** states `absent`, `rescheduled`; `original_booking_id`, `reschedule_count`; **unique `(session_id, horse_id)` where status in (held, confirmed)**; transition trigger (e.g. `completed → confirmed` rejected).
- **payments:** `membership_id` nullable, `order_id` unique.
- **Schedule:** templates reset to Tue–Sun × 5 slots, capacity 3; 37 days of sessions regenerated (the 124 existing sessions are all past and untouched; no future sessions existed).
- **system_settings:** `absence_credit_restore_enabled=true`, `max_restored_absences=null`, `cancellation_returns_credit=false`.
- **RLS:** new tables read-only for members (own rows) / staff (all); `notifications` admin rows staff-only; write privileges revoked on all new tables; new RPCs `revoke … from public, anon` + `grant authenticated`; `fulfill_order`, `process_payment_webhook`, helpers not callable by clients.

## 5. Decisions that need the owner's confirmation

1. **`cancellation_returns_credit` defaults to `false`.** Previously a cancel >24h before class returned the credit, which is an unlimited-reschedule loophole (cancel + rebook). Customers now use Reschedule. Set to `true` in `system_settings` to restore the old behaviour.
2. **Absence restores a credit** (policy on, unlimited). Set `max_restored_absences` to cap book→absent loops. `excused` behaves like `absent`; `no_show` forfeits the credit.
3. **A booking can be rescheduled once**; the membership allows 2 reschedules total. Once a credit has been restored, attendance can't be flipped back to present/no-show without an admin credit adjustment (`ATTENDANCE_LOCKED`).
4. **Weekly limit (3 per 7-day block) was kept** (preserved per brief §39). It caps Gold/Platinum usage per week; remove it by setting `weekly_class_limit` high if undesired.
5. A customer can't buy a second membership while one with credits is active (`ACTIVE_MEMBERSHIP_EXISTS`); webhook activation still never fails if two paid concurrently.
6. Availability is refreshed by 10-second polling plus a server re-check at booking time, not Supabase Realtime.

## 6. Migration report (live DB at audit time)

```
Existing users: 2   Existing memberships: 0   Existing credits: 0 rows
Existing future bookings: 0   Existing sessions: 124 (all past)
Conflicting records: 0   Migrated records: plans (2 deactivated, 3 added), 28 templates reset
```

## 7. Test results (honest)

```
Unit (vitest):   17/17 pass   (cart math, error mapping, slot grid, credit impact)
Integration:     NOT RUN — supabase/tests/phase5_e2e.sql written, needs migrations applied
E2E (UI/browser): NOT RUN — needs the DB migration + Razorpay test keys
Typecheck:       PASS (tsc -p tsconfig.app.json --noEmit, no output)
Lint (oxlint):   0 errors, warnings only (same react-refresh/set-state-in-effect patterns as existing code)
Build:           PASS (vite build)
```

## 8. Known limitations / production risks

- Migrations unapplied; the 42-step scenario is unverified. The SQL was reviewed by hand only — expect small fixes on first apply.
- Razorpay needs the secrets and webhook from `phase-4.4-razorpay-integration.md`; `razorpay-create-order` must be **redeployed** for order payments.
- The source Excel was not available (see §1).
- No browser/Playwright E2E harness exists in the repo; none was added.
- Customer notifications are in-app only (no email/SMS); "upcoming class reminder" and "membership expiry" notifications are not implemented (need a scheduled job).
- Refunds for cancelled paid orders are manual in Razorpay.
