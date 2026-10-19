-- Reverts 0027_recurring_weekly_bookings.sql.
-- Bookings and credit-ledger rows the schedule already created are ordinary bookings and are KEPT
-- (they stay valid and spent); only the schedule bookkeeping is removed. The Platinum 15-class
-- plan value is NOT reverted (it is the live value).
begin;

do $$
begin
  perform cron.unschedule('csf-recurring-bookings');
exception when others then
  null;
end $$;

drop function if exists public.session_availability_range(date, date);
drop function if exists public.book_replacement(uuid, uuid);
drop function if exists public.admin_excuse_booking(uuid, text);
drop function if exists public.my_recurring_schedule();
drop function if exists public.end_recurring_schedule();
drop function if exists public.confirm_recurring_schedule(jsonb);
drop function if exists public.generate_recurring_bookings();
drop function if exists public._recurring_generate(uuid);
drop function if exists public._recurring_try_book(uuid, uuid, uuid);
drop table if exists public.recurring_occurrences;
drop table if exists public.recurring_schedule_slots;
drop table if exists public.recurring_schedules;
alter table public.membership_plans drop column if exists recurring_slots_per_week;

notify pgrst, 'reload schema';

commit;
