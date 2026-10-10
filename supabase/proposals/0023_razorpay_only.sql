-- Phase 8 — Razorpay is the only way to pay.
-- Requires 0016–0019. Runs in one transaction; safe to run more than once.
--
-- Why: customers now pay online and the server marks an order paid when
-- Razorpay confirms it. Staff no longer approve payments by hand.
--
-- What changes
--  1. admin_mark_order_paid() is removed: no order can be marked paid by hand.
--  2. expire_stale_orders(): every order still unpaid after
--     pending_order_expiry_hours is cancelled. Until now an order was left
--     pending for ever once its payment window had been opened.
--  3. process_payment_webhook(): a confirmed payment is never lost on a closed
--     order. If the order had only timed out, it is reopened and fulfilled.
--     If staff had cancelled it, staff and the customer are told to expect a
--     refund. Everything else in the function is unchanged from 0017.
--  4. online_payments_enabled is set to true and retired (the app no longer
--     reads it; it stays true so an older copy of the site still pays online).

begin;

-- ─── 1. No manual approval ──────────────────────────────────────────────────
drop function if exists public.admin_mark_order_paid(uuid, text, text);

-- ─── 2. Unpaid orders expire ────────────────────────────────────────────────
create or replace function public.expire_stale_orders()
returns integer language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_n int := 0;
  v_hours int := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'pending_order_expiry_hours'), 24);
begin
  for r in
    select o.id, o.user_id from public.orders o
    where o.status = 'pending'
      and o.created_at < now() - make_interval(hours => v_hours)
    for update of o skip locked
  loop
    update public.orders set status = 'cancelled' where id = r.id;
    update public.payments set status = 'expired' where order_id = r.id and status in ('created', 'pending');
    perform public._audit('orders', r.id, 'ORDER_EXPIRED', jsonb_build_object('status', 'pending'),
      jsonb_build_object('status', 'cancelled', 'after_hours', v_hours));
    perform public._notify_user(r.user_id, 'order_expired', 'Order expired',
      'Your unpaid order was cancelled. You can place a new one any time.', jsonb_build_object('order_id', r.id));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

update public.system_settings
set description = 'An order that is not paid within this many hours is cancelled automatically.'
where key = 'pending_order_expiry_hours';

-- ─── 3. Confirmed payments are never lost ───────────────────────────────────
create or replace function public.process_payment_webhook(
  p_event_id text, p_event_type text, p_gateway_order_id text, p_gateway_payment_id text,
  p_status text, p_amount numeric default null, p_currency text default null, p_metadata jsonb default '{}'::jsonb
) returns public.payments
language plpgsql security definer set search_path = public as $$
declare
  v_payment public.payments;
  v_mismatch_detail text;
  v_prev_status text;
begin
  if p_status not in ('success', 'failed') then
    raise exception 'Invalid status %', p_status;
  end if;

  begin
    insert into public.payment_webhook_events (event_id, event_type, gateway_order_id, gateway_payment_id, payload)
    values (p_event_id, p_event_type, p_gateway_order_id, p_gateway_payment_id, p_metadata);
  exception when unique_violation then
    select * into v_payment from public.payments where gateway_order_id = p_gateway_order_id;
    return v_payment;
  end;

  select * into v_payment from public.payments where gateway_order_id = p_gateway_order_id for update;
  if not found then
    raise exception 'UNKNOWN_GATEWAY_ORDER_ID';
  end if;

  if v_payment.status in ('success', 'failed') then
    return v_payment;
  end if;

  if p_status = 'success' then
    if p_amount is null or p_currency is null then
      raise exception 'Amount/currency required to mark a payment successful';
    end if;

    if v_payment.amount <> p_amount or v_payment.currency <> p_currency then
      v_mismatch_detail := format('expected %s %s, got %s %s', v_payment.currency, v_payment.amount, p_currency, p_amount);

      update public.payments
      set gateway_payment_id = p_gateway_payment_id,
          metadata = metadata || p_metadata || jsonb_build_object('amount_mismatch', v_mismatch_detail)
      where id = v_payment.id
      returning * into v_payment;

      insert into public.audit_logs (table_name, record_id, action, new_values)
      values ('payments', v_payment.id, 'AMOUNT_MISMATCH_FLAGGED',
              jsonb_build_object('detail', v_mismatch_detail, 'event_id', p_event_id));

      return v_payment;
    end if;
  end if;

  v_prev_status := v_payment.status;

  update public.payments
  set gateway_payment_id = p_gateway_payment_id,
      status = p_status,
      paid_at = case when p_status = 'success' then now() else paid_at end,
      metadata = metadata || p_metadata
  where id = v_payment.id
  returning * into v_payment;

  if p_status = 'success' then
    if v_payment.order_id is not null then
      -- Paid after the order had timed out unpaid: the customer did nothing
      -- wrong, so the order is reopened and fulfilled as normal.
      if v_prev_status = 'expired' then
        update public.orders set status = 'pending' where id = v_payment.order_id and status = 'cancelled';
      end if;

      perform public.fulfill_order(v_payment.order_id);

      -- Money for an order that is closed for another reason (staff cancelled
      -- it): never keep it silently. Staff are told to refund it.
      if exists (select 1 from public.orders where id = v_payment.order_id and status in ('cancelled', 'failed')) then
        insert into public.audit_logs (table_name, record_id, action, new_values)
        values ('payments', v_payment.id, 'PAYMENT_FOR_CLOSED_ORDER',
                jsonb_build_object('order_id', v_payment.order_id, 'amount', v_payment.amount, 'event_id', p_event_id));
        perform public._notify_admins('payment_needs_refund', 'Payment received for a cancelled order',
          public._display_name(v_payment.user_id) || ' paid ₹' || trim(to_char(v_payment.amount, 'FM99,99,999')) || '. Refund it in Razorpay.',
          jsonb_build_object('order_id', v_payment.order_id, 'payment_id', v_payment.id));
        perform public._notify_user(v_payment.user_id, 'payment_needs_refund', 'Payment received for a cancelled order',
          'This order had already been cancelled. The club has been told and will refund you.',
          jsonb_build_object('order_id', v_payment.order_id));
      end if;
    elsif v_payment.membership_id is not null then
      perform public.activate_membership(v_payment.membership_id, v_payment.id);
    end if;
  elsif v_payment.order_id is not null then
    update public.orders set status = 'failed' where id = v_payment.order_id and status = 'pending';
    perform public._notify_user(v_payment.user_id, 'payment_failed', 'Payment failed',
      'Your payment did not go through. No money was taken for this order.',
      jsonb_build_object('order_id', v_payment.order_id));
    perform public._notify_admins('payment_failed', 'Payment failed',
      public._display_name(v_payment.user_id),
      jsonb_build_object('order_id', v_payment.order_id, 'payment_id', v_payment.id));
  end if;

  return v_payment;
end;
$$;

-- ─── 4. Retire the on/off switch ────────────────────────────────────────────
update public.system_settings
set value = 'true'::jsonb,
    description = 'Retired: checkout always pays online through Razorpay. Kept true for older copies of the site.'
where key = 'online_payments_enabled';

notify pgrst, 'reload schema';

commit;
