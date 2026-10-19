# 0027 — Recurring weekly bookings

Status: **proposal, not applied.** Nothing here has been run against the live database.

## What it does
A member picks weekdays and times (Gold up to 2 a week, Platinum up to 4). The server books the
matching real class sessions until the membership ends or the credits run out — one booking and one
credit each, through the same ledger, capacity and membership rules as `book_class()`.

| Piece | Purpose |
|---|---|
| `recurring_schedules` / `_slots` / `_occurrences` | the weekly preference, and one row per (schedule, class) so a retry never books a class twice or re-books one the member cancelled |
| `confirm_recurring_schedule(slots)` | member: set/change the pattern, then book |
| `end_recurring_schedule()` | member: stop the pattern (bookings stay) |
| `my_recurring_schedule()` | member: pattern, generated classes and live state |
| `admin_excuse_booking(booking, reason)` | staff: excuse one class, restore exactly one credit (idempotent) |
| `book_replacement(excused_booking, session)` | member: use that credit; **not** a reschedule |
| `generate_recurring_bookings()` | daily job (19:45 UTC = 01:15 IST) and retry of classes that were full |
| `session_availability_range(from, to)` | a week of availability in one call |
| `membership_plans.recurring_slots_per_week` | Gold 2, Platinum 4, One-Time Ride 0 |

Capacity is the class's places (`capacity`, default 3). There is no horse table since 0022.

## Apply (SQL Editor), then verify
1. Run `0027_recurring_weekly_bookings.sql` (safe to run twice). If it says pg_cron is unavailable, enable it and re-run.
2. Run `tests/phase12_recurring_weekly.sql` — it creates test users and **rolls back**; it should print `ALL PHASE 12 CHECKS PASSED`.
3. Check the job: `select jobname, schedule, active from cron.job where jobname = 'csf-recurring-bookings';`

Roll back with `0027_recurring_weekly_bookings.down.sql` (bookings and ledger rows already created are kept).

## Not changed
`book_class`, `reschedule_booking`, `cancel_booking`, `admin_mark_attendance`, payment/activation
functions, existing settings, and every existing booking, credit and attendance row. Platinum is already
15 live; the migration only makes fresh databases agree, and never touches purchased memberships.

## Decisions needed (business rules the new feature runs into)
1. **`weekly_class_limit = 3`** still applies to `reschedule_booking` (and to `book_class`). A Platinum
   member with 4 classes in a week cannot move one into that same week. Generated bookings use the plan's
   own weekly allowance instead. Raising the setting to 4 (Settings in the admin area) removes the conflict
   but also lets a Gold member book 4 single classes a week by hand.
2. **`max_future_bookings = 8`** applies to single bookings made by hand. Generated bookings deliberately bypass it
   (a Platinum schedule books up to 15 ahead).
3. **Gold = 2 and Platinum = 4 weekly slots** are the maximums I set from the brief; change
   `membership_plans.recurring_slots_per_week` if the club wants different numbers.
4. **Ordinary absences still restore credits** under the existing `absence_credit_restore_enabled = true` policy.
   The new excuse action is separate and always restores one credit; I did not change the ordinary policy.
5. **Unused credits lapse at expiry** (existing `expire_memberships`). Unchanged.
