-- Reverses 0033_transactional_email.sql. Unsent emails are discarded. Receipts are DELETED by this
-- file (they are copies of payment facts, regenerable only if you keep the payments), so export first
-- if you want to keep the receipt numbers already sent to members.
begin;
do $$ begin
  perform cron.unschedule('chr-email-sweep');
exception when others then null; end $$;
do $$ begin
  perform cron.unschedule('chr-payment-reconcile');
exception when others then null; end $$;

drop trigger if exists trg_profile_email_erased on public.profiles;
drop function if exists public._trg_profile_email_erased();
drop trigger if exists trg_notification_email on public.notifications;
drop trigger if exists trg_email_outbox_dispatch on public.email_outbox;
drop function if exists public.admin_retry_email(uuid);
drop function if exists public.admin_email_deliveries(text, int);
drop function if exists public.enqueue_payment_pending_email(uuid);
drop function if exists public.payments_needing_reconciliation(int, int);
drop function if exists public.email_job_context(uuid);
drop function if exists public.record_email_provider_event(text, text);
drop function if exists public.complete_email_job(uuid, text, text, text);
drop function if exists public.claim_email_jobs(int, uuid);
drop function if exists public._trg_email_outbox_dispatch();
drop function if exists public._email_dispatch(uuid, text);
drop function if exists public._trg_notification_email();
drop function if exists public._enqueue_email(text, text, uuid, text, uuid, uuid);
drop function if exists public._mask_email(text);
drop table if exists public.email_outbox;
drop function if exists public.my_receipt(uuid);
drop function if exists public._receipt_json(uuid);
drop function if exists public._issue_receipt(uuid);
drop table if exists public.payment_receipts;
drop sequence if exists public.payment_receipt_seq;
drop function if exists public._booking_ref(uuid);
drop function if exists public._order_ref(uuid);
drop function if exists public._email_cfg(text);
delete from public.system_settings where key in
  ('receipt_contact_email', 'receipt_contact_phone', 'receipt_gstin', 'email_arrival_info', 'email_collection_info');
notify pgrst, 'reload schema';
commit;
