-- Phase 6 — Payment-neutral order operations, admin settings/plans, lifecycle jobs.
-- Requires 0016 + 0017. Additive: no existing table is altered, no Phase 5
-- booking/credit/attendance logic changes. Replaces exactly two functions:
--   admin_cancel_booking  (now honours cancellation_returns_credit + notifies)
--   admin_set_order_status (adds customer notifications for collected/cancelled)
--
-- Payment model: Order -> Payment -> Fulfilment (fulfill_order). The payment
-- row is created by create_order() and finalised by EITHER
--   * process_payment_webhook()  (online gateway, deferred), or
--   * admin_mark_order_paid()    (manual/cash/offline, available now),
-- both ending in the same idempotent fulfill_order().

-- ─── 0. Settings ────────────────────────────────────────────────────────────
insert into public.system_settings (key, value, description) values
  ('online_payments_enabled', 'false'::jsonb,
   'When false, checkout places a PENDING order for staff to confirm. The online gateway (Razorpay) is switched on in the final stage.'),
  ('pending_order_expiry_hours', '24'::jsonb,
   'Pending orders with no online payment started are cancelled after this many hours.'),
  ('class_reminder_hours', '24'::jsonb,
   'Customers get an in-app reminder when a booked class starts within this many hours.'),
  ('membership_expiry_notice_days', '3'::jsonb,
   'Customers get an in-app notice when a membership with credits left ends within this many days.')
on conflict (key) do nothing;

-- ─── 1. Mark an order paid (manual / offline) ───────────────────────────────
create or replace function public.admin_mark_order_paid(
  p_order_id uuid, p_method text default 'manual', p_reference text default null
) returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_pay public.payments;
begin
  if not public.is_staff_or_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  -- 'razorpay' is deliberately NOT accepted here: online payments only ever
  -- become successful through the verified webhook path.
  if p_method is distinct from 'manual' then raise exception 'INVALID_PAYMENT_METHOD'; end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

  -- Idempotent: an already-paid order is returned untouched (no second membership / credit).
  if v_order.status in ('paid', 'ready_for_collection', 'collected') then return v_order; end if;
  if v_order.status <> 'pending' then
    raise exception 'INVALID_ORDER_STATE' using detail = format('A %s order cannot be marked paid.', v_order.status);
  end if;

  select * into v_pay from public.payments where order_id = p_order_id for update;
  if not found then raise exception 'PAYMENT_NOT_FOUND'; end if;
  if v_pay.gateway_order_id is not null then
    raise exception 'ONLINE_PAYMENT_IN_PROGRESS'
      using detail = 'An online payment was started for this order; let it complete or fail first.';
  end if;

  update public.payments
  set gateway = 'manual', status = 'success', paid_at = now(),
      metadata = metadata || jsonb_build_object(
        'method', p_method, 'reference', nullif(trim(p_reference), ''), 'marked_by', auth.uid())
  where id = v_pay.id;

  perform public.fulfill_order(p_order_id);   -- membership activation + ledger, idempotent

  perform public._audit('orders', p_order_id, 'ORDER_MARKED_PAID',
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'paid', 'method', p_method, 'reference', nullif(trim(p_reference), ''),
                       'amount', v_pay.amount));

  select * into v_order from public.orders where id = p_order_id;
  return v_order;
end;
$$;

-- ─── 2. Order status changes: notify the customer ───────────────────────────
create or replace function public.admin_set_order_status(p_order_id uuid, p_status text)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_old text;
begin
  if not public.is_staff_or_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if p_status not in ('ready_for_collection', 'collected', 'cancelled') then raise exception 'INVALID_STATUS'; end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  v_old := v_order.status;

  if p_status in ('ready_for_collection', 'collected') and not v_order.has_in_store then
    raise exception 'ORDER_NOT_COLLECTABLE' using detail = 'This order has no in-store items.';
  end if;
  if not (
       (v_old = 'pending' and p_status = 'cancelled')
    or (v_old = 'paid' and p_status in ('ready_for_collection', 'collected', 'cancelled'))
    or (v_old = 'ready_for_collection' and p_status in ('collected', 'cancelled'))
  ) then
    raise exception 'INVALID_ORDER_TRANSITION' using detail = format('%s → %s is not allowed.', v_old, p_status);
  end if;

  update public.orders
  set status = p_status, collected_at = case when p_status = 'collected' then now() else collected_at end
  where id = p_order_id returning * into v_order;

  perform public._audit('orders', p_order_id, 'ORDER_STATUS_CHANGED',
    jsonb_build_object('status', v_old), jsonb_build_object('status', p_status));

  if p_status = 'ready_for_collection' then
    perform public._notify_user(v_order.user_id, 'order_ready', 'Your order is ready for collection',
      'Please collect it in store.', jsonb_build_object('order_id', p_order_id));
  elsif p_status = 'collected' then
    perform public._notify_user(v_order.user_id, 'order_collected', 'Order collected',
      'Thank you — your order has been collected.', jsonb_build_object('order_id', p_order_id));
  elsif p_status = 'cancelled' then
    perform public._notify_user(v_order.user_id, 'order_cancelled', 'Order cancelled',
      'Your order was cancelled. Please contact the club if you have questions.', jsonb_build_object('order_id', p_order_id));
  end if;
  return v_order;
end;
$$;

-- ─── 3. Admin cancel booking: follow the configured credit policy ───────────
-- p_refund_credit NULL  => follow system_settings.cancellation_returns_credit
-- p_refund_credit TRUE/FALSE => explicit, audited admin override.
create or replace function public.admin_cancel_booking(p_booking_id uuid, p_reason text, p_refund_credit boolean default null)
returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings;
  v_session public.class_sessions;
  v_policy boolean;
  v_refund boolean;
begin
  if not public.is_staff_or_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED'; end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_booking.status not in ('held', 'confirmed') then
    raise exception 'BOOKING_NOT_CANCELLABLE' using detail = format('Booking is already %s.', v_booking.status);
  end if;
  select * into v_session from public.class_sessions where id = v_booking.session_id;

  v_policy := coalesce((select (value #>> '{}')::boolean from public.system_settings
                        where key = 'cancellation_returns_credit'), false);
  v_refund := coalesce(p_refund_credit, v_policy);

  -- goes through the booking state machine trigger (confirmed/held -> cancelled)
  update public.bookings
  set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'Admin: ' || p_reason
  where id = p_booking_id returning * into v_booking;

  if v_refund then
    insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type, description, created_by)
    values (v_booking.user_id, v_booking.membership_id, v_booking.id, 1, 'cancellation',
            'Admin cancellation — credit returned', auth.uid());
  end if;

  perform public._audit('bookings', p_booking_id, 'BOOKING_CANCELLED',
    jsonb_build_object('status', 'confirmed'),
    jsonb_build_object('status', 'cancelled', 'by_admin', true, 'reason', p_reason, 'credit_returned', v_refund,
                       'policy_returns_credit', v_policy, 'override', p_refund_credit is not null and p_refund_credit <> v_policy));
  perform public._notify_user(v_booking.user_id, 'booking_cancelled', 'Class cancelled by the club',
    public._fmt_slot(v_session) || case when v_refund then ' · credit returned' else ' · credit not returned' end,
    jsonb_build_object('booking_id', v_booking.id));
  return v_booking;
end;
$$;

-- ─── 4. Admin settings (validated, audited) ─────────────────────────────────
create or replace function public._int_in_range(p jsonb, p_lo int, p_hi int)
returns boolean language sql immutable as $$
  select jsonb_typeof(p) = 'number' and (p #>> '{}') ~ '^[0-9]{1,6}$'
         and (p #>> '{}')::int between p_lo and p_hi;
$$;

create or replace function public.admin_update_setting(p_key text, p_value jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  select value into v_old from public.system_settings where key = p_key for update;
  if not found then raise exception 'UNKNOWN_SETTING'; end if;

  if p_key in ('absence_credit_restore_enabled', 'cancellation_returns_credit') then
    if jsonb_typeof(p_value) is distinct from 'boolean' then raise exception 'INVALID_VALUE' using detail = 'Must be true or false.'; end if;
  elsif p_key = 'max_restored_absences' then
    if not (jsonb_typeof(p_value) = 'null' or public._int_in_range(p_value, 0, 1000)) then
      raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 0 to 1000, or leave empty for unlimited.'; end if;
  elsif p_key = 'weekly_class_limit' then
    if not public._int_in_range(p_value, 1, 14) then raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 1 to 14.'; end if;
  elsif p_key = 'booking_window_days' then
    if not public._int_in_range(p_value, 1, 90) then raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 1 to 90.'; end if;
  elsif p_key = 'pending_order_expiry_hours' then
    if not public._int_in_range(p_value, 1, 720) then raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 1 to 720.'; end if;
  elsif p_key = 'class_reminder_hours' then
    if not public._int_in_range(p_value, 1, 168) then raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 1 to 168.'; end if;
  elsif p_key = 'membership_expiry_notice_days' then
    if not public._int_in_range(p_value, 1, 30) then raise exception 'INVALID_VALUE' using detail = 'Use a whole number from 1 to 30.'; end if;
  else
    raise exception 'SETTING_NOT_EDITABLE';
  end if;

  update public.system_settings set value = p_value, updated_at = now() where key = p_key;
  perform public._audit('system_settings', gen_random_uuid(), 'SETTING_CHANGED',
    jsonb_build_object('key', p_key, 'value', v_old), jsonb_build_object('key', p_key, 'value', p_value));
  return p_value;
end;
$$;

-- ─── 5. Membership plan management (affects FUTURE purchases only) ──────────
create or replace function public.admin_update_plan(
  p_plan_id uuid, p_price numeric, p_class_credits integer, p_reschedules_allowed integer, p_is_active boolean
) returns public.membership_plans
language plpgsql security definer set search_path = public as $$
declare
  v_old public.membership_plans;
  v_new public.membership_plans;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  select * into v_old from public.membership_plans where id = p_plan_id for update;
  if not found then raise exception 'PLAN_NOT_FOUND'; end if;
  if v_old.plan_code is null then raise exception 'PLAN_NOT_EDITABLE' using detail = 'Legacy plans cannot be edited.'; end if;
  if p_price is null or p_price <= 0 or p_price > 1000000 then raise exception 'INVALID_VALUE' using detail = 'Price must be above 0 and at most 1,000,000.'; end if;
  if p_class_credits is null or p_class_credits < 1 or p_class_credits > 100 then raise exception 'INVALID_VALUE' using detail = 'Classes must be from 1 to 100.'; end if;
  if p_reschedules_allowed is null or p_reschedules_allowed < 0 or p_reschedules_allowed > 20 then raise exception 'INVALID_VALUE' using detail = 'Reschedules must be from 0 to 20.'; end if;

  update public.membership_plans
  set price = p_price, class_credits = p_class_credits, reschedules_allowed = p_reschedules_allowed,
      is_active = coalesce(p_is_active, is_active)
  where id = p_plan_id returning * into v_new;

  perform public._audit('membership_plans', p_plan_id, 'PLAN_UPDATED',
    jsonb_build_object('price', v_old.price, 'class_credits', v_old.class_credits,
                       'reschedules_allowed', v_old.reschedules_allowed, 'is_active', v_old.is_active),
    jsonb_build_object('price', v_new.price, 'class_credits', v_new.class_credits,
                       'reschedules_allowed', v_new.reschedules_allowed, 'is_active', v_new.is_active));
  return v_new;
end;
$$;

-- ─── 6. Admin overview KPIs for the Phase 5 data model ──────────────────────
create or replace function public.admin_store_metrics()
returns table (
  members integer, active_memberships integer, gold_memberships integer, platinum_memberships integer,
  one_time_rides integer, remaining_credits integer, upcoming_sessions integer, upcoming_bookings integer,
  completed_classes integer, absent_classes integer, pending_orders integer, paid_orders integer,
  ready_orders integer, collected_orders integer, order_value numeric
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not public.is_staff_or_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  return query select
    (select count(*) from public.profiles p where p.role = 'member')::int,
    (select count(*) from public.memberships m where m.status = 'active' and m.end_date >= v_today)::int,
    (select count(*) from public.memberships m join public.membership_plans pl on pl.id = m.plan_id
       where m.status = 'active' and m.end_date >= v_today and pl.plan_code = 'GOLD')::int,
    (select count(*) from public.memberships m join public.membership_plans pl on pl.id = m.plan_id
       where m.status = 'active' and m.end_date >= v_today and pl.plan_code = 'PLATINUM')::int,
    (select count(*) from public.memberships m join public.membership_plans pl on pl.id = m.plan_id
       where m.status = 'active' and m.end_date >= v_today and pl.plan_code = 'ONE_TIME_RIDE')::int,
    (select coalesce(sum(m.credits_remaining), 0) from public.memberships m
       where m.status = 'active' and m.end_date >= v_today)::int,
    (select count(*) from public.class_sessions s where s.session_date >= v_today and s.status = 'open')::int,
    (select count(*) from public.bookings b join public.class_sessions s on s.id = b.session_id
       where b.status in ('held', 'confirmed') and s.session_date >= v_today)::int,
    (select count(*) from public.bookings b where b.status = 'completed')::int,
    (select count(*) from public.bookings b where b.status = 'absent')::int,
    (select count(*) from public.orders o where o.status = 'pending')::int,
    (select count(*) from public.orders o where o.status = 'paid')::int,
    (select count(*) from public.orders o where o.status = 'ready_for_collection')::int,
    (select count(*) from public.orders o where o.status = 'collected')::int,
    (select coalesce(sum(o.total_amount), 0) from public.orders o
       where o.status in ('paid', 'ready_for_collection', 'collected'));
end;
$$;

-- ─── 7. Lifecycle jobs (called by pg_cron; not callable by clients) ─────────
create or replace function public.expire_memberships()
returns integer language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_n int := 0;
  v_bal int;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  for r in select * from public.memberships where status = 'active' and end_date < v_today for update skip locked loop
    select coalesce(sum(amount), 0) into v_bal from public.credit_ledger where membership_id = r.id;
    update public.memberships set status = 'expired' where id = r.id;
    if v_bal > 0 then
      insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description)
      values (r.user_id, r.id, -v_bal, 'expiry', 'Membership expired — unused credits lapsed');
    end if;
    perform public._audit('memberships', r.id, 'MEMBERSHIP_EXPIRED',
      jsonb_build_object('status', 'active'), jsonb_build_object('status', 'expired', 'credits_lapsed', greatest(v_bal, 0)));
    perform public._notify_user(r.user_id, 'membership_expired', 'Membership expired',
      case when v_bal > 0 then format('%s unused class%s lapsed.', v_bal, case when v_bal = 1 then '' else 'es' end)
           else 'Your membership has ended.' end,
      jsonb_build_object('membership_id', r.id));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Only orders whose online payment never started are expired; an order with a
-- gateway order attached is left for the payment webhook to resolve.
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
      and not exists (select 1 from public.payments p where p.order_id = o.id and p.gateway_order_id is not null)
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

create or replace function public.generate_future_sessions()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_window int := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days'), 30);
  v_default_cap int := (select count(*) from public.horses where is_active and status = 'available');
  v_n int;
begin
  insert into public.class_sessions (session_date, start_time, end_time, capacity, template_id)
  select d::date, t.start_time, t.end_time, coalesce(t.capacity, v_default_cap), t.id
  from generate_series(v_today, v_today + v_window + 7, interval '1 day') as d
  join public.schedule_templates t on t.day_of_week = extract(dow from d) and t.is_active
  on conflict (session_date, start_time, end_time) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function public.send_lifecycle_notifications()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_now timestamp := now() at time zone 'Asia/Kolkata';
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_hours int := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'class_reminder_hours'), 24);
  v_days int := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'membership_expiry_notice_days'), 3);
  v_a int; v_b int;
begin
  insert into public.notifications (audience, user_id, type, title, body, data)
  select 'user', b.user_id, 'class_reminder', 'Upcoming class',
         public._fmt_slot(s) || coalesce(' · ' || h.name, ''), jsonb_build_object('booking_id', b.id)
  from public.bookings b
  join public.class_sessions s on s.id = b.session_id
  left join public.horses h on h.id = b.horse_id
  where b.status in ('held', 'confirmed')
    and (s.session_date + s.start_time) > v_now
    and (s.session_date + s.start_time) <= v_now + make_interval(hours => v_hours)
    and not exists (select 1 from public.notifications n
                    where n.type = 'class_reminder' and n.data ->> 'booking_id' = b.id::text);
  get diagnostics v_a = row_count;

  insert into public.notifications (audience, user_id, type, title, body, data)
  select 'user', m.user_id, 'membership_expiring', 'Membership ending soon',
         format('Your membership ends on %s with %s class%s left.', to_char(m.end_date, 'DD Mon YYYY'),
                m.credits_remaining, case when m.credits_remaining = 1 then '' else 'es' end),
         jsonb_build_object('membership_id', m.id)
  from public.memberships m
  where m.status = 'active' and m.credits_remaining > 0
    and m.end_date >= v_today and m.end_date <= v_today + v_days
    and not exists (select 1 from public.notifications n
                    where n.type = 'membership_expiring' and n.data ->> 'membership_id' = m.id::text);
  get diagnostics v_b = row_count;
  return v_a + v_b;
end;
$$;

-- ─── 8. Grants ──────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array[
    'public.admin_mark_order_paid(uuid, text, text)',
    'public.admin_set_order_status(uuid, text)',
    'public.admin_cancel_booking(uuid, text, boolean)',
    'public.admin_update_setting(text, jsonb)',
    'public.admin_update_plan(uuid, numeric, integer, integer, boolean)',
    'public.admin_store_metrics()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array[
    'public.expire_memberships()', 'public.expire_stale_orders()',
    'public.generate_future_sessions()', 'public.send_lifecycle_notifications()',
    'public._int_in_range(jsonb, int, int)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- ─── 9. Schedule the jobs (UTC; IST = UTC+5:30). Skipped, not failed, if pg_cron is unavailable. ──
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron unavailable (%); enable it in Database > Extensions and re-run this block.', sqlerrm;
    return;
  end;
  perform cron.schedule('csf-expire-memberships',    '5 18 * * *',  'select public.expire_memberships()');       -- 23:35 IST daily
  perform cron.schedule('csf-expire-stale-orders',   '15 * * * *',  'select public.expire_stale_orders()');      -- hourly
  perform cron.schedule('csf-generate-sessions',     '30 19 * * *', 'select public.generate_future_sessions()'); -- 01:00 IST daily
  perform cron.schedule('csf-lifecycle-notifications','*/30 * * * *','select public.send_lifecycle_notifications()');
exception when others then
  raise notice 'could not schedule cron jobs: %', sqlerrm;
end $$;
