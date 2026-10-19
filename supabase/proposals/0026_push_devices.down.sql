-- Reverts 0026_push_devices.sql. Notifications themselves are untouched.
begin;

do $$
begin
  perform cron.unschedule('csf-push-sweep');
exception when others then
  null;
end $$;

drop trigger if exists trg_notification_push on public.notifications;
drop function if exists public._trg_notification_push();
drop function if exists public._push_dispatch(uuid);
drop function if exists public.register_push_device(text, text, text);
drop function if exists public.unregister_push_device(text);
drop table if exists public.push_deliveries;
drop table if exists public.push_devices;

notify pgrst, 'reload schema';

commit;

-- Also remove the Vault secrets if they were added:
--   delete from vault.secrets where name in ('push_send_url', 'push_send_secret');
