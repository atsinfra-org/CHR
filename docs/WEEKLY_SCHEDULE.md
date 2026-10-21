# Weekly recurring classes

Members on **Gold** (8 classes, up to 2 a week) and **Platinum** (15 classes, up to 4 a week) can choose weekdays and times once.
The club then books those classes week after week until the plan ends or its classes run out. **One-Time Ride (₹3,000)** books single
classes only. Prices, class counts and weekly allowances live in `membership_plans` (`price`, `class_credits`, `recurring_slots_per_week`),
never in the screens. A booking is a place in a class (capacity per class, default 3); there are no horses in the software.

## How it works
| Piece | Where |
|---|---|
| The weekly **preference** (weekdays + times) | `recurring_schedules`, `recurring_schedule_slots` |
| Each **real class** it produced, or why it did not | `recurring_occurrences` (`booked`, `skipped_full`, `skipped_no_credits`, `skipped_other`, `replaced`) |
| The **booking** and its **class** (one credit each) | `bookings` + `credit_ledger`, through the same rules as `book_class()` |
| Set / change / stop | `confirm_recurring_schedule`, `end_recurring_schedule`; read with `my_recurring_schedule`, `session_availability_range` |
| Daily generation (also retries full classes) | `generate_recurring_bookings()`, cron `csf-recurring-bookings` 19:45 UTC = 01:15 IST |
| Member screen | **Book a class** (`/account/book`): pick a time, then **Book this class only** or **Repeat every week**; your saved weekly times and the classes booked from them are shown above the calendar. A summary card is on the dashboard. There is no separate weekly page (`/account/weekly` redirects to Book a class). |
| Admin screen | Admin → **Weekly schedules** (read-only) |

Saving a preference, opening the calendar or selecting a time never uses a class. A class is taken off the plan only in the same
transaction that creates its booking, so a refused booking costs nothing. The database refuses the 9th Gold / 16th Platinum class,
a class after the plan ends, a full class (3 places), a second booking of the same class by the same rider, and a retry of the same
request. Cancelling follows the existing policy (`cancellation_returns_credit`, cutoff hours); excusing a class restores exactly one credit once.
Rescheduling keeps the two-reschedule limit and never changes the number of classes.

## One booking action on Book a class
| Plan | Action on the page | Calls | Result |
|---|---|---|---|
| Gold, Platinum | **Repeat every week** (the only booking button) | `confirm_recurring_schedule(existing times + this one)` | the weekly pattern is saved; the database books the dated classes that exist, and the daily job (`csf-recurring-bookings`) books the rest as the timetable opens |
| One-Time Ride (no weekly allowance) | Book this class | `book_class(session)` | one dated class, as before; it cannot repeat |

A class picked by a Gold or Platinum member is never booked on its own from this page. A weekly save is reported as saved only after `my_recurring_schedule()` is read back and contains the chosen time; errors are shown in plain words and nothing is claimed on failure.
`book_class` stays in the database: One-Time Ride bookings, the waitlist offer and staff tools depend on it, and the database still decides capacity, credits and limits for every booking path.
(History: the page once had only a single-class button, so members wanting a weekly schedule got one class and no schedule; then it had two buttons; now repeating is the only choice for plans that can repeat.)

## Weekly limit (migration 0035)
`book_class`, `reschedule_booking` and `member_current_block_usage` now use
`greatest(system_settings.weekly_class_limit, plan.recurring_slots_per_week)`: Platinum 4, Gold 3 (unchanged), One-Time Ride 3 (unchanged).
Nothing else in those functions changed (each is the exact production definition with one line altered).

## Tests (local replica only)
```
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=... \
  psql -d <db with 0016-0035> -f supabase/tests/phase12_recurring_weekly.sql     # Gold 8/9th, Platinum 15/16th, final 3 credits, capacity 3/4th, expiry, retries, excuse, isolation
  psql -d <db with 0016-0035> -f supabase/tests/phase20_platinum_weekly_limit.sql # Platinum 4 a week, Gold 3, reschedule in a full week, credits exact, other members' bookings
TEMPLATE_DB=<db> bash supabase/tests/recurring-capacity-concurrency.sh 20          # 20 riders race for a 3-place class; one rider sends the same request 6 times
psql -d <db with 0016-0035> -f supabase/tests/phase22_weekly_flow.sql           # the bug reproduced, then: schedule saved for the right member, dated classes booked, job idempotent, Gold/Platinum limits, expiry, capacity, errors
npm test                                                                          # screens, wording, preview maths, the two buttons, admin page
```

## Production steps (nothing here has been done)
1. Run `supabase/proposals/0035_platinum_weekly_limit.sql` in the SQL Editor (safe to run twice; rollback `0035_platinum_weekly_limit.down.sql`).
   It does not touch purchases, payments, credits already given or existing bookings.
2. Run `select pg_get_functiondef('public.book_class(uuid)'::regprocedure) like '%recurring_slots_per_week%';` (expect true).
3. Deploy the website. No Edge Function or secret changes are needed.
4. Check with a Platinum account you own: weekly schedule with 4 times, confirm, see the classes under My Classes.

## Open business decisions
* Ordinary absences still restore credits under `absence_credit_restore_enabled` (unchanged); staff "excuse" always restores one.
* Unused classes lapse when the membership expires (unchanged).
* Generated bookings bypass `max_future_bookings` (8) by design; a Platinum schedule books up to 15 ahead.
* The weekly-schedule screen previews the expected classes; the real ones depend on the timetable that has been generated so far and on free places.
