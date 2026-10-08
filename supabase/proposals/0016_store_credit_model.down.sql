-- Rollback for 0016/0017. Only safe BEFORE real store orders / v5 bookings exist
-- (it drops the new tables). Run 0017's reverse first (functions), then this.
--
-- NOTE: the previous bodies of book_class(uuid), cancel_booking, admin_mark_attendance,
-- process_payment_webhook, handle_new_user, member_booking_eligibility and
-- member_current_block_usage are in 0010/0011/0013/0014 and 0009/0007; re-apply
-- those files' definitions after running this to restore the old behaviour.

drop trigger if exists trg_bookings_state_machine on public.bookings;
drop function if exists public.enforce_booking_transition();
drop function if exists public.mark_notifications_read(uuid[]);
drop function if exists public.admin_set_product_price(uuid, numeric, boolean);
drop function if exists public.admin_set_order_status(uuid, text);
drop function if exists public.admin_session_roster(date);
drop function if exists public.reschedule_booking(uuid, uuid, uuid);
drop function if exists public.session_horse_availability(date);
drop function if exists public.book_class(uuid, uuid);
drop function if exists public.fulfill_order(uuid);
drop function if exists public.create_order(jsonb);
drop function if exists public.store_catalog();
drop function if exists public._fmt_slot(public.class_sessions);
drop function if exists public._display_name(uuid);
drop function if exists public._audit(text, uuid, text, jsonb, jsonb);
drop function if exists public._notify_admins(text, text, text, jsonb);
drop function if exists public._notify_user(uuid, text, text, text, jsonb);

delete from public.system_settings
  where key in ('absence_credit_restore_enabled', 'max_restored_absences', 'cancellation_returns_credit');

drop table if exists public.notifications;
alter table public.payments drop constraint if exists payments_subject_check;
drop index if exists public.uq_payments_order;
alter table public.payments drop column if exists order_id;
alter table public.memberships drop constraint if exists memberships_order_item_id_fkey;
drop index if exists public.uq_memberships_order_item;
drop table if exists public.order_items;
drop table if exists public.orders;
drop table if exists public.store_products;

drop index if exists public.uq_bookings_active_horse_per_session;
drop index if exists public.uq_credit_ledger_absence_restore_per_booking;
alter table public.bookings drop column if exists original_booking_id, drop column if exists reschedule_count;

alter table public.memberships
  drop constraint if exists memberships_reschedules_check,
  drop column if exists order_item_id, drop column if exists reschedules_used,
  drop column if exists reschedules_allowed, drop column if exists total_credits;
create unique index if not exists uq_memberships_one_active_per_user
  on public.memberships (user_id) where status = 'active';

alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('held','confirmed','cancelled','completed','no_show','expired'));
alter table public.credit_ledger drop constraint if exists credit_ledger_transaction_type_check;
alter table public.credit_ledger drop constraint if exists credit_ledger_amount_check;
alter table public.credit_ledger
  add constraint credit_ledger_transaction_type_check
  check (transaction_type in ('membership_purchase','booking','cancellation','admin_adjustment','refund','expiry')),
  add constraint credit_ledger_amount_check check (amount <> 0);

update public.membership_plans set is_active = true where plan_code is null;
delete from public.membership_plans where plan_code is not null;
alter table public.membership_plans
  drop constraint if exists membership_plans_kind_check,
  drop constraint if exists membership_plans_reschedules_allowed_check,
  drop constraint if exists membership_plans_plan_code_key,
  drop column if exists kind, drop column if exists reschedules_allowed, drop column if exists plan_code;
-- payments.membership_id NOT NULL is intentionally NOT restored (order-only payments may exist).
-- Schedule templates/sessions are not reverted; edit schedule_templates via the admin Sessions page.
