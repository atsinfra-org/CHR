-- Reverses 0036_admin_reports.sql. Drops only the report functions; no table, policy or data is touched.
-- Audit rows already written by admin_log_export (table_name 'admin_exports') are KEPT.
begin;
drop function if exists public.admin_log_export(text, text, jsonb, int, text);
drop function if exists public.admin_report_summary(text, date, date, text, text, text);
drop function if exists public.admin_report_bookings(date, date, text, text, int, int);
drop function if exists public.admin_report_payments(date, date, text, text, int, int);
drop function if exists public.admin_report_memberships(date, date, text, text, int, int);
drop function if exists public.admin_report_members(date, date, text, text, int, int);
drop function if exists public._rpt_guard(date, date, int, int);
drop function if exists public._rpt_bookings(date, date, text, text);
drop function if exists public._rpt_payments(date, date, text, text);
drop function if exists public._rpt_memberships(date, date, text, text);
drop function if exists public._rpt_members(date, date, text, text);
drop index if exists public.idx_payments_created_at;
drop index if exists public.idx_memberships_created_at;
drop index if exists public.idx_profiles_created_at;
notify pgrst, 'reload schema';
commit;
