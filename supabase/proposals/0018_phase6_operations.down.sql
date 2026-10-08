-- Rollback for 0018. Safe: only functions, cron jobs and 4 setting rows were added.
-- admin_cancel_booking and admin_set_order_status are restored to their previous
-- bodies by re-applying 0014 (admin_cancel_booking) and 0017 (admin_set_order_status).
do $$
begin
  perform cron.unschedule('csf-expire-memberships');
  perform cron.unschedule('csf-expire-stale-orders');
  perform cron.unschedule('csf-generate-sessions');
  perform cron.unschedule('csf-lifecycle-notifications');
exception when others then null;
end $$;

drop function if exists public.admin_mark_order_paid(uuid, text, text);
drop function if exists public.admin_update_setting(text, jsonb);
drop function if exists public.admin_update_plan(uuid, numeric, integer, integer, boolean);
drop function if exists public.admin_store_metrics();
drop function if exists public.expire_memberships();
drop function if exists public.expire_stale_orders();
drop function if exists public.generate_future_sessions();
drop function if exists public.send_lifecycle_notifications();
drop function if exists public._int_in_range(jsonb, int, int);

delete from public.system_settings
 where key in ('online_payments_enabled', 'pending_order_expiry_hours', 'class_reminder_hours', 'membership_expiry_notice_days');
