-- Phase 5 (part 2/2) — Store, credit model, horse-level booking: FUNCTIONS.
-- Requires 0016_store_credit_model.sql to have been applied first.
--
-- Every function here is SECURITY DEFINER with a pinned search_path and
-- re-derives identity from auth.uid(); nothing trusts client-supplied user
-- ids, prices, totals, credit counts or roles.

-- ─── 0. Internal helpers (not callable by clients) ─────────────────────────
create or replace function public._notify_user(
  p_user uuid, p_type text, p_title text, p_body text default null, p_data jsonb default '{}'::jsonb
) returns void language sql security definer set search_path = public as $$
  insert into public.notifications (audience, user_id, type, title, body, data)
  values ('user', p_user, p_type, p_title, p_body, coalesce(p_data, '{}'::jsonb));
$$;

create or replace function public._notify_admins(
  p_type text, p_title text, p_body text default null, p_data jsonb default '{}'::jsonb
) returns void language sql security definer set search_path = public as $$
  insert into public.notifications (audience, type, title, body, data)
  values ('admin', p_type, p_title, p_body, coalesce(p_data, '{}'::jsonb));
$$;

create or replace function public._audit(
  p_table text, p_record uuid, p_action text, p_old jsonb default null, p_new jsonb default null
) returns void language sql security definer set search_path = public as $$
  insert into public.audit_logs (table_name, record_id, action, performed_by, old_values, new_values)
  values (p_table, p_record, p_action, auth.uid(), p_old, p_new);
$$;

create or replace function public._display_name(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(full_name), ''), email, 'Customer') from public.profiles where id = p_user;
$$;

create or replace function public._fmt_slot(p_session public.class_sessions)
returns text language sql immutable set search_path = public as $$
  select to_char(p_session.session_date, 'Dy DD Mon') || ' ' ||
         to_char(p_session.start_time, 'HH24:MI') || '–' || to_char(p_session.end_time, 'HH24:MI');
$$;

revoke execute on function public._notify_user(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public._notify_admins(text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public._audit(text, uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public._display_name(uuid) from public, anon, authenticated;
revoke execute on function public._fmt_slot(public.class_sessions) from public, anon, authenticated;

-- ─── 1. Registration notification ───────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;

  -- Notifications must never be able to block account creation.
  begin
    perform public._notify_admins('registration', 'New customer registered',
      coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), new.email),
      jsonb_build_object('user_id', new.id));
    perform public._notify_user(new.id, 'registration', 'Welcome to Colonel Stud Farm',
      'Your account is ready. Visit the store to choose a membership.');
  exception when others then
    null;
  end;
  return new;
end;
$$;

-- ─── 2. Booking state machine (database-level) ──────────────────────────────
create or replace function public.enforce_booking_transition()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if not (
       (old.status = 'held'      and new.status in ('confirmed', 'cancelled', 'expired', 'rescheduled'))
    or (old.status = 'confirmed' and new.status in ('completed', 'absent', 'no_show', 'rescheduled', 'cancelled'))
    -- attendance corrections between the three attendance outcomes
    or (old.status = 'completed' and new.status in ('absent', 'no_show'))
    or (old.status = 'absent'    and new.status in ('completed', 'no_show'))
    or (old.status = 'no_show'   and new.status in ('completed', 'absent'))
  ) then
    raise exception 'INVALID_BOOKING_TRANSITION'
      using detail = format('A %s booking cannot become %s.', old.status, new.status);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bookings_state_machine on public.bookings;
create trigger trg_bookings_state_machine before update of status on public.bookings
  for each row execute function public.enforce_booking_transition();

-- ─── 3. Store catalog + orders ─────────────────────────────────────────────
create or replace function public.store_catalog()
returns table (
  id uuid, sku text, category text, name text, description text, price numeric, currency text,
  fulfillment text, plan_id uuid, plan_code text, class_credits integer, validity_days integer,
  reschedules_allowed integer, is_purchasable boolean, sort_order integer
)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  return query
  select sp.id, sp.sku, sp.category, sp.name, coalesce(sp.description, pl.description),
         coalesce(pl.price, sp.price), coalesce(pl.currency, sp.currency), sp.fulfillment,
         sp.plan_id, pl.plan_code, pl.class_credits, pl.validity_days, pl.reschedules_allowed,
         (sp.is_active and coalesce(pl.price, sp.price) is not null and (sp.plan_id is null or pl.is_active)),
         sp.sort_order
  from public.store_products sp
  left join public.membership_plans pl on pl.id = sp.plan_id
  where sp.is_active and (sp.plan_id is null or pl.is_active)
  order by case sp.category when 'membership' then 1 when 'tack' then 2 else 3 end, sp.sort_order;
end;
$$;

create or replace function public.create_order(p_items jsonb)
returns table (order_id uuid, payment_id uuid, total_amount numeric, currency text)
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  r record;
  v_lines jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_price numeric;
  v_qty int;
  v_has_membership boolean := false;
  v_has_instore boolean := false;
  v_membership_lines int := 0;
  v_order public.orders;
  v_payment public.payments;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  if not exists (select 1 from public.profiles where id = v_user and status = 'active') then
    raise exception 'ACCOUNT_NOT_ACTIVE';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART';
  end if;
  if jsonb_array_length(p_items) > 30 then raise exception 'CART_TOO_LARGE'; end if;
  if (select count(*) from public.orders where user_id = v_user and status = 'pending'
        and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'TOO_MANY_PENDING_ORDERS';
  end if;

  begin
    for r in
      select (e ->> 'product_id')::uuid as pid, sum(coalesce((e ->> 'quantity')::int, 1)) as qty
      from jsonb_array_elements(p_items) e group by 1
    loop
      v_qty := r.qty;
      declare
        v_p record;
      begin
        select sp.id, sp.category, sp.name, sp.price, sp.fulfillment, sp.is_active, sp.plan_id,
               pl.price as plan_price, pl.is_active as plan_active
        into v_p
        from public.store_products sp
        left join public.membership_plans pl on pl.id = sp.plan_id
        where sp.id = r.pid;

        if not found or not v_p.is_active then
          raise exception 'PRODUCT_UNAVAILABLE';
        end if;
        if v_qty < 1 or v_qty > 20 then raise exception 'INVALID_QUANTITY'; end if;

        if v_p.category = 'membership' then
          if v_qty <> 1 then raise exception 'INVALID_QUANTITY' using detail = 'Memberships are bought one at a time.'; end if;
          if not coalesce(v_p.plan_active, false) then raise exception 'PRODUCT_UNAVAILABLE'; end if;
          v_price := v_p.plan_price;
          v_has_membership := true;
          v_membership_lines := v_membership_lines + 1;
        else
          v_price := v_p.price;
          v_has_instore := true;
        end if;

        if v_price is null then
          raise exception 'PRICE_NOT_SET' using detail = format('%s is not available to buy yet.', v_p.name);
        end if;

        v_total := v_total + v_price * v_qty;
        v_lines := v_lines || jsonb_build_object(
          'product_id', v_p.id, 'category', v_p.category, 'name', v_p.name, 'unit_price', v_price,
          'quantity', v_qty, 'fulfillment', v_p.fulfillment, 'plan_id', v_p.plan_id);
      end;
    end loop;
  exception
    when invalid_text_representation or invalid_parameter_value or not_null_violation then
      raise exception 'INVALID_CART';
  end;

  if v_membership_lines > 1 then
    raise exception 'ONE_MEMBERSHIP_PER_ORDER' using detail = 'Choose one membership per order.';
  end if;
  if v_has_membership and exists (
    select 1 from public.memberships
    where user_id = v_user and status = 'active' and end_date >= v_today and credits_remaining > 0
  ) then
    raise exception 'ACTIVE_MEMBERSHIP_EXISTS'
      using detail = 'You already have an active membership with classes remaining.';
  end if;
  if v_total <= 0 then raise exception 'INVALID_CART'; end if;

  insert into public.orders (user_id, total_amount, has_membership, has_in_store)
  values (v_user, v_total, v_has_membership, v_has_instore)
  returning * into v_order;

  insert into public.order_items (order_id, product_id, category, name, unit_price, quantity, fulfillment, plan_id)
  select v_order.id, (l ->> 'product_id')::uuid, l ->> 'category', l ->> 'name', (l ->> 'unit_price')::numeric,
         (l ->> 'quantity')::int, l ->> 'fulfillment', nullif(l ->> 'plan_id', '')::uuid
  from jsonb_array_elements(v_lines) l;

  insert into public.payments (user_id, order_id, gateway, amount, currency, status)
  values (v_user, v_order.id, 'razorpay', v_total, 'INR', 'created')
  returning * into v_payment;

  return query select v_order.id, v_payment.id, v_order.total_amount, v_order.currency;
end;
$$;

-- Internal: called only from process_payment_webhook(). Idempotent.
create or replace function public.fulfill_order(p_order_id uuid)
returns public.orders language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_payment public.payments;
  v_item record;
  v_plan public.membership_plans;
  v_mid uuid;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_name text;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status <> 'pending' then return v_order; end if;

  select * into v_payment from public.payments where order_id = p_order_id;
  v_name := public._display_name(v_order.user_id);

  update public.orders set status = 'paid', paid_at = now() where id = p_order_id returning * into v_order;

  for v_item in select * from public.order_items where order_id = p_order_id order by created_at, id loop
    if v_item.category = 'membership' then
      select * into v_plan from public.membership_plans where id = v_item.plan_id;

      insert into public.memberships
        (user_id, plan_id, status, start_date, end_date, payment_id, total_credits,
         reschedules_allowed, reschedules_used, order_item_id)
      values
        (v_order.user_id, v_plan.id, 'active', v_today, v_today + (v_plan.validity_days - 1), v_payment.id,
         v_plan.class_credits, v_plan.reschedules_allowed, 0, v_item.id)
      on conflict (order_item_id) where order_item_id is not null do nothing
      returning id into v_mid;

      if v_mid is not null then
        insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description)
        values (v_order.user_id, v_mid, v_plan.class_credits, 'membership_purchase',
                'Membership activated: ' || v_plan.name);

        insert into public.audit_logs (table_name, record_id, action, performed_by, new_values)
        values ('memberships', v_mid, 'MEMBERSHIP_ACTIVATED', null,
                jsonb_build_object('plan', v_plan.plan_code, 'credits', v_plan.class_credits,
                                   'order_id', p_order_id, 'user_id', v_order.user_id));

        perform public._notify_user(v_order.user_id, 'membership_activated', v_plan.name || ' activated',
          format('You have %s classes, valid until %s.', v_plan.class_credits,
                 to_char(v_today + (v_plan.validity_days - 1), 'DD Mon YYYY')),
          jsonb_build_object('membership_id', v_mid));
        perform public._notify_admins('membership_purchase', v_plan.name || ' purchased',
          format('%s — ₹%s', v_name, trim(to_char(v_item.unit_price, 'FM99,99,999'))),
          jsonb_build_object('order_id', p_order_id, 'membership_id', v_mid, 'user_id', v_order.user_id));
      end if;
      v_mid := null;
    end if;
  end loop;

  insert into public.audit_logs (table_name, record_id, action, performed_by, new_values)
  values ('payments', v_payment.id, 'PAYMENT_VERIFIED', null,
          jsonb_build_object('order_id', p_order_id, 'amount', v_payment.amount));

  perform public._notify_user(v_order.user_id, 'payment_success', 'Payment successful',
    format('We received ₹%s for your order.', trim(to_char(v_order.total_amount, 'FM99,99,999'))),
    jsonb_build_object('order_id', p_order_id));
  perform public._notify_admins('payment_success', 'Payment successful',
    format('%s paid ₹%s', v_name, trim(to_char(v_order.total_amount, 'FM99,99,999'))),
    jsonb_build_object('order_id', p_order_id, 'payment_id', v_payment.id));

  if exists (select 1 from public.order_items where order_id = p_order_id and category = 'tack') then
    perform public._notify_admins('tack_order', 'New in-store tack order', v_name,
      jsonb_build_object('order_id', p_order_id));
  end if;
  if exists (select 1 from public.order_items where order_id = p_order_id and category = 'cafe') then
    perform public._notify_admins('cafe_order', 'New cafe order', v_name,
      jsonb_build_object('order_id', p_order_id));
  end if;

  return v_order;
end;
$$;

-- process_payment_webhook: unchanged contract; now fulfils store orders.
create or replace function public.process_payment_webhook(
  p_event_id text, p_event_type text, p_gateway_order_id text, p_gateway_payment_id text,
  p_status text, p_amount numeric default null, p_currency text default null, p_metadata jsonb default '{}'::jsonb
) returns public.payments
language plpgsql security definer set search_path = public as $$
declare
  v_payment public.payments;
  v_mismatch_detail text;
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

  update public.payments
  set gateway_payment_id = p_gateway_payment_id,
      status = p_status,
      paid_at = case when p_status = 'success' then now() else paid_at end,
      metadata = metadata || p_metadata
  where id = v_payment.id
  returning * into v_payment;

  if p_status = 'success' then
    if v_payment.order_id is not null then
      perform public.fulfill_order(v_payment.order_id);
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

-- ─── 4. Availability reads ──────────────────────────────────────────────────
create or replace function public.session_horse_availability(p_date date)
returns table (
  session_id uuid, session_date date, start_time time, end_time time, session_status text,
  capacity integer, booked_count integer, available_count integer, is_bookable boolean,
  horse_id uuid, horse_name text, horse_state text
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_now_ist timestamp := now() at time zone 'Asia/Kolkata';
  v_window int := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days'), 30);
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  return query
  with grid as (
    select s.id sid, s.session_date sdate, s.start_time st, s.end_time et, s.status sstatus, s.capacity cap,
           h.id hid, h.name hname, h.status hstatus,
           b.id bid, b.user_id buser
    from public.class_sessions s
    cross join public.horses h
    left join public.bookings b
      on b.session_id = s.id and b.horse_id = h.id and b.status in ('held', 'confirmed')
    where s.session_date = p_date and h.is_active
  ), agg as (
    select g.*,
           (count(g.bid) over (partition by g.sid))::int as booked,
           (count(*) filter (where g.bid is null and g.hstatus = 'available') over (partition by g.sid))::int as free_horses
    from grid g
  )
  select a.sid, a.sdate, a.st, a.et, a.sstatus, a.cap, a.booked,
         greatest(least(a.cap - a.booked, a.free_horses), 0),
         (a.sstatus = 'open'
           and (a.sdate + a.st) > v_now_ist
           and a.sdate <= v_now_ist::date + v_window),
         a.hid, a.hname,
         case when a.bid is not null and a.buser = auth.uid() then 'mine'
              when a.bid is not null then 'booked'
              when a.hstatus = 'available' then 'available'
              else 'unavailable' end
  from agg a
  order by a.st, a.hname;
end;
$$;

-- ─── 5. Booking ─────────────────────────────────────────────────────────────
drop function if exists public.book_class(uuid);

create or replace function public.book_class(p_session_id uuid, p_horse_id uuid default null)
returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_session public.class_sessions;
  v_membership public.memberships;
  v_horse_id uuid;
  v_horse public.horses;
  v_balance int;
  v_booked_count int;
  v_booking public.bookings;
  v_block_days int;
  v_block_limit int;
  v_week_index int;
  v_week_count int;
  v_next_eligible_date date;
  v_booking_window_days int;
  v_constraint text;
  v_now_ist_date date := (now() at time zone 'Asia/Kolkata')::date;
  v_now_ist_time time := (now() at time zone 'Asia/Kolkata')::time;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  -- Row lock on the session serialises every booking/reschedule for it.
  select * into v_session from public.class_sessions where id = p_session_id for update;
  if not found then raise exception 'SESSION_NOT_FOUND'; end if;
  if v_session.status <> 'open' then
    raise exception 'SESSION_NOT_AVAILABLE'
      using detail = format('This session is %s and not open for booking.', v_session.status);
  end if;
  if v_session.session_date < v_now_ist_date
     or (v_session.session_date = v_now_ist_date and v_session.start_time <= v_now_ist_time) then
    raise exception 'INVALID_SESSION_DATE' using detail = 'This session has already started or passed.';
  end if;

  v_booking_window_days := (select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days');
  if v_booking_window_days is not null and v_session.session_date > v_now_ist_date + v_booking_window_days then
    raise exception 'INVALID_SESSION_DATE'
      using detail = format('Bookings are only open up to %s days ahead.', v_booking_window_days);
  end if;

  -- Prefer a membership that is valid for this session date, has credits,
  -- and expires soonest.
  select * into v_membership
  from public.memberships
  where user_id = v_user_id and status = 'active'
    and end_date >= v_now_ist_date and end_date >= v_session.session_date
    and credits_remaining > 0
  order by end_date asc
  limit 1
  for update;

  if not found then
    if exists (select 1 from public.memberships
               where user_id = v_user_id and status = 'active' and end_date >= v_now_ist_date and credits_remaining > 0) then
      raise exception 'MEMBERSHIP_EXPIRED'
        using detail = 'Your membership ends before this class. Choose an earlier date.';
    elsif exists (select 1 from public.memberships
                  where user_id = v_user_id and status = 'active' and end_date >= v_now_ist_date) then
      raise exception 'NO_CREDITS_REMAINING';
    end if;
    raise exception 'NO_ACTIVE_MEMBERSHIP';
  end if;

  select coalesce(sum(amount), 0) into v_balance from public.credit_ledger where membership_id = v_membership.id;
  if v_balance <= 0 then raise exception 'NO_CREDITS_REMAINING'; end if;

  if exists (select 1 from public.bookings
             where user_id = v_user_id and session_id = p_session_id and status in ('held', 'confirmed')) then
    raise exception 'DUPLICATE_BOOKING';
  end if;

  v_block_days := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'membership_block_days'), 7);
  v_block_limit := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'weekly_class_limit'), 3);
  v_week_index := (v_session.session_date - v_membership.start_date) / v_block_days;

  select count(*) into v_week_count
  from public.bookings b
  join public.class_sessions cs on cs.id = b.session_id
  where b.membership_id = v_membership.id
    and b.status in ('held', 'confirmed', 'completed', 'no_show')
    and (cs.session_date - v_membership.start_date) / v_block_days = v_week_index;

  if v_week_count >= v_block_limit then
    v_next_eligible_date := v_membership.start_date + v_block_days * (v_week_index + 1);
    raise exception 'WEEKLY_LIMIT_REACHED'
      using detail = format('You have reached the maximum of %s classes for this %s-day period. You can book another class from %s.',
                            v_block_limit, v_block_days, to_char(v_next_eligible_date, 'FMMonth FMDD, YYYY')),
            hint = v_next_eligible_date::text;
  end if;

  select count(*) into v_booked_count from public.bookings
  where session_id = p_session_id and status in ('held', 'confirmed');
  if v_booked_count >= v_session.capacity then raise exception 'SESSION_FULL'; end if;

  if p_horse_id is not null then
    select * into v_horse from public.horses where id = p_horse_id;
    if not found or not v_horse.is_active or v_horse.status <> 'available' then
      raise exception 'HORSE_NOT_AVAILABLE';
    end if;
    if exists (select 1 from public.bookings
               where session_id = p_session_id and horse_id = p_horse_id and status in ('held', 'confirmed')) then
      raise exception 'SLOT_NO_LONGER_AVAILABLE';
    end if;
    v_horse_id := p_horse_id;
  else
    select h.id into v_horse_id
    from public.horses h
    where h.is_active and h.status = 'available'
      and not exists (select 1 from public.bookings b
                      where b.session_id = p_session_id and b.horse_id = h.id and b.status in ('held', 'confirmed'))
    order by h.name
    limit 1;
    if v_horse_id is null then raise exception 'SESSION_FULL'; end if;
  end if;

  begin
    insert into public.bookings (user_id, membership_id, session_id, horse_id, status, booked_at)
    values (v_user_id, v_membership.id, p_session_id, v_horse_id, 'confirmed', now())
    returning * into v_booking;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'uq_bookings_active_horse_per_session' then
      raise exception 'SLOT_NO_LONGER_AVAILABLE';
    end if;
    raise exception 'DUPLICATE_BOOKING';
  end;

  insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type, description)
  values (v_user_id, v_membership.id, v_booking.id, -1, 'booking', 'Class booked');

  v_name := public._display_name(v_user_id);
  perform public._audit('bookings', v_booking.id, 'BOOKING_CREATED', null,
    jsonb_build_object('session_id', p_session_id, 'horse_id', v_horse_id, 'membership_id', v_membership.id));
  perform public._notify_user(v_user_id, 'booking_confirmed', 'Booking confirmed',
    public._fmt_slot(v_session) || ' · ' || (select name from public.horses where id = v_horse_id),
    jsonb_build_object('booking_id', v_booking.id));
  perform public._notify_admins('booking_created', 'New class booking',
    v_name || ' · ' || public._fmt_slot(v_session) || ' · ' || (select name from public.horses where id = v_horse_id),
    jsonb_build_object('booking_id', v_booking.id, 'session_id', p_session_id, 'user_id', v_user_id));

  return v_booking;
end;
$$;

-- ─── 6. Rescheduling ────────────────────────────────────────────────────────
create or replace function public.reschedule_booking(
  p_booking_id uuid, p_new_session_id uuid, p_new_horse_id uuid default null
) returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_old public.bookings;
  v_old_session public.class_sessions;
  v_new_session public.class_sessions;
  v_membership public.memberships;
  v_new public.bookings;
  v_horse public.horses;
  v_horse_id uuid;
  v_booked int;
  v_block_days int;
  v_block_limit int;
  v_week_index int;
  v_week_count int;
  v_window int;
  v_constraint text;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_now_time time := (now() at time zone 'Asia/Kolkata')::time;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;

  select * into v_old from public.bookings where id = p_booking_id for update;
  if not found or v_old.user_id <> v_user_id then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_old.status not in ('held', 'confirmed') then
    raise exception 'BOOKING_NOT_RESCHEDULABLE' using detail = format('This booking is already %s.', v_old.status);
  end if;
  if v_old.reschedule_count >= 1 then
    raise exception 'ALREADY_RESCHEDULED' using detail = 'A rescheduled class cannot be rescheduled again.';
  end if;

  -- Lock both sessions in a stable order (no deadlock between two users swapping).
  perform 1 from public.class_sessions where id in (v_old.session_id, p_new_session_id) order by id for update;
  select * into v_old_session from public.class_sessions where id = v_old.session_id;
  select * into v_new_session from public.class_sessions where id = p_new_session_id;
  if v_new_session.id is null then raise exception 'SESSION_NOT_FOUND'; end if;

  if v_old_session.session_date < v_today
     or (v_old_session.session_date = v_today and v_old_session.start_time <= v_now_time) then
    raise exception 'RESCHEDULE_WINDOW_CLOSED' using detail = 'This class has already started or passed.';
  end if;

  select * into v_membership from public.memberships where id = v_old.membership_id for update;
  if v_membership.status <> 'active' or v_membership.end_date < v_today then
    raise exception 'MEMBERSHIP_EXPIRED';
  end if;
  if v_membership.reschedules_used >= v_membership.reschedules_allowed then
    raise exception 'RESCHEDULE_LIMIT_REACHED'
      using detail = format('You have used all %s reschedules on this membership.', v_membership.reschedules_allowed);
  end if;

  if v_new_session.status <> 'open' then raise exception 'SESSION_NOT_AVAILABLE'; end if;
  if v_new_session.session_date < v_today
     or (v_new_session.session_date = v_today and v_new_session.start_time <= v_now_time) then
    raise exception 'INVALID_SESSION_DATE' using detail = 'That session has already started or passed.';
  end if;
  v_window := (select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days');
  if v_window is not null and v_new_session.session_date > v_today + v_window then
    raise exception 'INVALID_SESSION_DATE' using detail = format('Bookings are only open up to %s days ahead.', v_window);
  end if;
  if v_new_session.session_date > v_membership.end_date then
    raise exception 'MEMBERSHIP_EXPIRED' using detail = 'Your membership ends before that class.';
  end if;
  if p_new_session_id = v_old.session_id and (p_new_horse_id is null or p_new_horse_id = v_old.horse_id) then
    raise exception 'SAME_SLOT';
  end if;

  -- Release the old slot first; everything below runs in this one transaction.
  update public.bookings set status = 'rescheduled' where id = v_old.id;

  v_block_days := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'membership_block_days'), 7);
  v_block_limit := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'weekly_class_limit'), 3);
  v_week_index := (v_new_session.session_date - v_membership.start_date) / v_block_days;
  select count(*) into v_week_count
  from public.bookings b join public.class_sessions cs on cs.id = b.session_id
  where b.membership_id = v_membership.id
    and b.status in ('held', 'confirmed', 'completed', 'no_show')
    and (cs.session_date - v_membership.start_date) / v_block_days = v_week_index;
  if v_week_count >= v_block_limit then raise exception 'WEEKLY_LIMIT_REACHED'; end if;

  if exists (select 1 from public.bookings
             where user_id = v_user_id and session_id = p_new_session_id and status in ('held', 'confirmed')) then
    raise exception 'DUPLICATE_BOOKING';
  end if;

  select count(*) into v_booked from public.bookings
  where session_id = p_new_session_id and status in ('held', 'confirmed');
  if v_booked >= v_new_session.capacity then raise exception 'SESSION_FULL'; end if;

  if p_new_horse_id is not null then
    select * into v_horse from public.horses where id = p_new_horse_id;
    if not found or not v_horse.is_active or v_horse.status <> 'available' then
      raise exception 'HORSE_NOT_AVAILABLE';
    end if;
    if exists (select 1 from public.bookings
               where session_id = p_new_session_id and horse_id = p_new_horse_id and status in ('held', 'confirmed')) then
      raise exception 'SLOT_NO_LONGER_AVAILABLE';
    end if;
    v_horse_id := p_new_horse_id;
  else
    select h.id into v_horse_id from public.horses h
    where h.is_active and h.status = 'available'
      and not exists (select 1 from public.bookings b
                      where b.session_id = p_new_session_id and b.horse_id = h.id and b.status in ('held', 'confirmed'))
    order by h.name limit 1;
    if v_horse_id is null then raise exception 'SESSION_FULL'; end if;
  end if;

  begin
    insert into public.bookings (user_id, membership_id, session_id, horse_id, status, booked_at,
                                 original_booking_id, reschedule_count)
    values (v_user_id, v_membership.id, p_new_session_id, v_horse_id, 'confirmed', now(),
            v_old.id, v_old.reschedule_count + 1)
    returning * into v_new;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'uq_bookings_active_horse_per_session' then raise exception 'SLOT_NO_LONGER_AVAILABLE'; end if;
    raise exception 'DUPLICATE_BOOKING';
  end;

  update public.memberships set reschedules_used = reschedules_used + 1 where id = v_membership.id;

  -- Zero-amount ledger row: the audit trail shows the entitlement MOVED,
  -- and that no credit was consumed.
  insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type, description)
  values (v_user_id, v_membership.id, v_new.id, 0, 'reschedule',
          'Rescheduled ' || public._fmt_slot(v_old_session) || ' → ' || public._fmt_slot(v_new_session) || ' (no credit used)');

  perform public._audit('bookings', v_new.id, 'BOOKING_RESCHEDULED',
    jsonb_build_object('booking_id', v_old.id, 'session_id', v_old.session_id, 'horse_id', v_old.horse_id),
    jsonb_build_object('booking_id', v_new.id, 'session_id', v_new.session_id, 'horse_id', v_new.horse_id,
                       'reschedules_used', v_membership.reschedules_used + 1));
  perform public._notify_user(v_user_id, 'reschedule_confirmed', 'Class rescheduled',
    public._fmt_slot(v_old_session) || ' → ' || public._fmt_slot(v_new_session),
    jsonb_build_object('booking_id', v_new.id));
  perform public._notify_admins('booking_rescheduled', 'Class rescheduled',
    public._display_name(v_user_id) || ' · ' || public._fmt_slot(v_old_session) || ' → ' || public._fmt_slot(v_new_session),
    jsonb_build_object('old_booking_id', v_old.id, 'new_booking_id', v_new.id, 'user_id', v_user_id));

  return v_new;
end;
$$;

-- ─── 7. Cancellation: keep the policy configurable, close the loophole ──────
insert into public.system_settings (key, value, description) values
  ('cancellation_returns_credit', 'false'::jsonb,
   'When false (default) a customer cancellation does NOT return the credit — customers use reschedule_booking() instead. Set true to restore the legacy "credit back if cancelled before cancellation_cutoff_hours" behaviour.')
on conflict (key) do nothing;

create or replace function public.cancel_booking(p_booking_id uuid, p_reason text default null)
returns public.bookings
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_booking public.bookings;
  v_session public.class_sessions;
  v_cutoff_hours int;
  v_returns boolean;
  v_returned boolean := false;
  v_is_staff boolean := public.is_staff_or_admin();
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_booking.user_id <> v_user_id and not v_is_staff then
    raise exception 'Not authorized to cancel this booking';
  end if;
  if v_booking.status not in ('held', 'confirmed') then
    raise exception 'BOOKING_NOT_CANCELLABLE' using detail = format('This booking is already %s.', v_booking.status);
  end if;

  select * into v_session from public.class_sessions where id = v_booking.session_id;
  select (value #>> '{}')::int into v_cutoff_hours from public.system_settings where key = 'cancellation_cutoff_hours';
  v_returns := coalesce((select (value #>> '{}')::boolean from public.system_settings where key = 'cancellation_returns_credit'), false);

  update public.bookings
  set status = 'cancelled', cancelled_at = now(), cancellation_reason = p_reason
  where id = p_booking_id returning * into v_booking;

  if v_returns and (v_cutoff_hours is null or
       ((v_session.session_date::text || ' ' || v_session.start_time::text)::timestamp at time zone 'Asia/Kolkata') - now()
         >= make_interval(hours => v_cutoff_hours)) then
    insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type, description)
    values (v_booking.user_id, v_booking.membership_id, v_booking.id, 1, 'cancellation', 'Cancelled — credit returned');
    v_returned := true;
  end if;

  perform public._audit('bookings', v_booking.id, 'BOOKING_CANCELLED',
    jsonb_build_object('status', 'confirmed'),
    jsonb_build_object('status', 'cancelled', 'credit_returned', v_returned));
  perform public._notify_user(v_booking.user_id, 'booking_cancelled', 'Booking cancelled',
    public._fmt_slot(v_session) || case when v_returned then ' · credit returned' else ' · credit not returned' end,
    jsonb_build_object('booking_id', v_booking.id));
  perform public._notify_admins('booking_cancelled', 'Booking cancelled',
    public._display_name(v_booking.user_id) || ' · ' || public._fmt_slot(v_session),
    jsonb_build_object('booking_id', v_booking.id));

  return v_booking;
end;
$$;

-- ─── 8. Attendance (admin/staff only) ───────────────────────────────────────
create or replace function public.admin_mark_attendance(p_booking_id uuid, p_status text, p_notes text)
returns public.attendance
language plpgsql security definer set search_path = public as $$
declare
  v_booking public.bookings;
  v_session public.class_sessions;
  v_att public.attendance;
  v_old_status text;
  v_already_restored boolean;
  v_enabled boolean;
  v_max int;
  v_restored_count int;
  v_inserted int := 0;
  v_balance int;
  v_restored_now boolean := false;
  v_skip_reason text;
begin
  if not public.is_staff_or_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if p_status not in ('present', 'absent', 'no_show', 'excused') then raise exception 'INVALID_STATUS'; end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_booking.status not in ('confirmed', 'completed', 'no_show', 'absent') then
    raise exception 'BOOKING_NOT_ATTENDABLE'
      using detail = format('Attendance cannot be set on a %s booking.', v_booking.status);
  end if;
  select * into v_session from public.class_sessions where id = v_booking.session_id;

  select status into v_old_status from public.attendance where booking_id = p_booking_id;
  v_already_restored := exists (select 1 from public.credit_ledger
                                where booking_id = p_booking_id and transaction_type = 'absence_restore');

  -- Once a credit was restored, moving back to present/no_show would need a
  -- manual, reasoned credit adjustment instead of a silent flip.
  if v_already_restored and p_status in ('present', 'no_show') then
    raise exception 'ATTENDANCE_LOCKED'
      using detail = 'The credit for this class was already restored. Use a credit adjustment to correct it.';
  end if;

  insert into public.attendance (booking_id, status, marked_by, marked_at, notes)
  values (p_booking_id, p_status, auth.uid(), now(), nullif(trim(p_notes), ''))
  on conflict (booking_id)
  do update set status = excluded.status, marked_by = excluded.marked_by,
                marked_at = excluded.marked_at, notes = excluded.notes
  returning * into v_att;

  update public.bookings
  set status = case p_status when 'present' then 'completed' when 'no_show' then 'no_show' else 'absent' end,
      completed_at = case when p_status = 'present' then coalesce(completed_at, now()) else completed_at end
  where id = p_booking_id;

  if p_status in ('absent', 'excused') and not v_already_restored then
    v_enabled := coalesce((select (value #>> '{}')::boolean from public.system_settings
                           where key = 'absence_credit_restore_enabled'), false);
    v_max := (select nullif(value #>> '{}', 'null')::int from public.system_settings where key = 'max_restored_absences');
    select count(*) into v_restored_count from public.credit_ledger
    where membership_id = v_booking.membership_id and transaction_type = 'absence_restore';

    if not v_enabled then
      v_skip_reason := 'policy disabled';
    elsif v_max is not null and v_restored_count >= v_max then
      v_skip_reason := 'restoration limit reached';
    else
      insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type, description, created_by)
      values (v_booking.user_id, v_booking.membership_id, v_booking.id, 1, 'absence_restore',
              'Absence credit restored (' || p_status || ')', auth.uid())
      on conflict (booking_id) where transaction_type = 'absence_restore' do nothing;
      get diagnostics v_inserted = row_count;
      v_restored_now := v_inserted > 0;
    end if;
  end if;

  perform public._audit('attendance', v_att.id, 'ATTENDANCE_MARKED_' || upper(p_status),
    jsonb_build_object('status', v_old_status),
    jsonb_build_object('booking_id', p_booking_id, 'status', p_status, 'credit_restored', v_restored_now,
                       'restore_skipped', v_skip_reason));

  perform public._notify_user(v_booking.user_id, 'attendance_recorded', 'Attendance recorded',
    public._fmt_slot(v_session) || ' · ' || initcap(replace(p_status, '_', ' ')),
    jsonb_build_object('booking_id', p_booking_id));

  if v_restored_now then
    perform public._audit('credit_ledger', v_booking.id, 'CREDIT_RESTORED', null,
      jsonb_build_object('booking_id', p_booking_id, 'membership_id', v_booking.membership_id));
    select coalesce(sum(amount), 0) into v_balance from public.credit_ledger where membership_id = v_booking.membership_id;
    perform public._notify_user(v_booking.user_id, 'credit_restored', 'Class credit restored',
      format('You have %s class%s remaining.', v_balance, case when v_balance = 1 then '' else 'es' end),
      jsonb_build_object('booking_id', p_booking_id));
  end if;

  if p_status in ('absent', 'excused') and v_old_status is distinct from p_status then
    perform public._notify_admins('attendance_absent', 'Customer marked ' || p_status,
      public._display_name(v_booking.user_id) || ' · ' || public._fmt_slot(v_session)
        || case when v_restored_now then ' · credit restored' else '' end,
      jsonb_build_object('booking_id', p_booking_id));
  end if;

  return v_att;
end;
$$;

-- ─── 9. Admin reads / order + catalog management ───────────────────────────
create or replace function public.admin_session_roster(p_date date)
returns table (
  session_id uuid, start_time time, end_time time, session_status text,
  horse_id uuid, horse_name text, horse_status text,
  booking_id uuid, booking_status text, user_id uuid, customer_name text, customer_email text,
  attendance_status text, plan_name text, credits_remaining integer,
  reschedules_used integer, reschedules_allowed integer, reschedule_count integer, original_booking_id uuid
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff_or_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  return query
  select s.id, s.start_time, s.end_time, s.status, h.id, h.name, h.status,
         b.id, b.status, b.user_id, p.full_name, p.email, a.status,
         pl.name, m.credits_remaining, m.reschedules_used, m.reschedules_allowed,
         b.reschedule_count, b.original_booking_id
  from public.class_sessions s
  cross join public.horses h
  left join lateral (
    select bb.* from public.bookings bb
    where bb.session_id = s.id and bb.horse_id = h.id and bb.status in ('held', 'confirmed', 'completed', 'absent', 'no_show')
    order by bb.created_at desc limit 1
  ) b on true
  left join public.profiles p on p.id = b.user_id
  left join public.attendance a on a.booking_id = b.id
  left join public.memberships m on m.id = b.membership_id
  left join public.membership_plans pl on pl.id = m.plan_id
  where s.session_date = p_date and h.is_active
  order by s.start_time, h.name;
end;
$$;

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
  end if;
  return v_order;
end;
$$;

create or replace function public.admin_set_product_price(p_product_id uuid, p_price numeric, p_is_active boolean)
returns public.store_products
language plpgsql security definer set search_path = public as $$
declare
  v_old public.store_products;
  v_new public.store_products;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  select * into v_old from public.store_products where id = p_product_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if v_old.category = 'membership' then
    raise exception 'USE_PLAN_PRICING' using detail = 'Membership prices live on the membership plan.';
  end if;
  if p_price is not null and p_price < 0 then raise exception 'INVALID_AMOUNT'; end if;

  update public.store_products set price = p_price, is_active = coalesce(p_is_active, is_active)
  where id = p_product_id returning * into v_new;

  perform public._audit('store_products', p_product_id, 'PRODUCT_PRICE_CHANGED',
    jsonb_build_object('price', v_old.price, 'is_active', v_old.is_active),
    jsonb_build_object('price', v_new.price, 'is_active', v_new.is_active));
  return v_new;
end;
$$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  update public.notifications
  set read_at = now()
  where read_at is null
    and (p_ids is null or id = any(p_ids))
    and ((audience = 'user' and user_id = auth.uid()) or (audience = 'admin' and public.is_staff_or_admin()));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Same membership choice as book_class(), so the dashboard and the booking
-- engine can never disagree about which membership is "current".
create or replace function public.member_booking_eligibility()
returns table (
  has_active_membership boolean, membership_id uuid, membership_start_date date, membership_end_date date,
  credits_remaining integer, min_bookable_date date, max_bookable_date date, block_class_limit integer,
  block_classes_used integer, block_classes_remaining integer, current_block_start date, current_block_end date
)
language plpgsql stable set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_membership public.memberships;
  v_booking_window_days int;
  v_block record;
  v_today_ist date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;
  v_booking_window_days := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'booking_window_days'), 30);

  select * into v_membership from public.memberships m
  where m.user_id = v_user_id and m.status = 'active' and m.end_date >= v_today_ist
  order by (m.credits_remaining > 0) desc, m.end_date asc
  limit 1;

  if not found then
    return query select false, null::uuid, null::date, null::date, null::int, null::date, null::date,
                        null::int, null::int, null::int, null::date, null::date;
    return;
  end if;

  select * into v_block from public.member_current_block_usage();

  return query select true, v_membership.id, v_membership.start_date, v_membership.end_date,
    v_membership.credits_remaining, v_today_ist, least(v_today_ist + v_booking_window_days, v_membership.end_date),
    v_block.block_class_limit, v_block.block_classes_used, v_block.block_classes_remaining,
    v_block.current_block_start, v_block.current_block_end;
end;
$$;

create or replace function public.member_current_block_usage()
returns table (
  membership_id uuid, current_block_start date, current_block_end date,
  block_class_limit integer, block_classes_used integer, block_classes_remaining integer
)
language plpgsql stable set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_membership public.memberships;
  v_block_days int;
  v_block_limit int;
  v_block_index int;
  v_block_start date;
  v_block_end date;
  v_used int;
  v_today_ist date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;

  select * into v_membership from public.memberships m
  where m.user_id = v_user_id and m.status = 'active' and m.end_date >= v_today_ist
  order by (m.credits_remaining > 0) desc, m.end_date asc
  limit 1;
  if not found or v_membership.start_date is null then return; end if;

  v_block_days := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'membership_block_days'), 7);
  v_block_limit := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'weekly_class_limit'), 3);
  v_block_index := (v_today_ist - v_membership.start_date) / v_block_days;
  v_block_start := v_membership.start_date + v_block_index * v_block_days;
  v_block_end := least(v_membership.start_date + v_block_index * v_block_days + (v_block_days - 1), v_membership.end_date);

  select count(*) into v_used
  from public.bookings b join public.class_sessions cs on cs.id = b.session_id
  where b.membership_id = v_membership.id
    and b.status in ('held', 'confirmed', 'completed', 'no_show')
    and (cs.session_date - v_membership.start_date) / v_block_days = v_block_index;

  return query select v_membership.id, v_block_start, v_block_end, v_block_limit, v_used, greatest(v_block_limit - v_used, 0);
end;
$$;

-- ─── 10. Grants ─────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  foreach f in array array[
    'public.store_catalog()',
    'public.create_order(jsonb)',
    'public.session_horse_availability(date)',
    'public.book_class(uuid, uuid)',
    'public.reschedule_booking(uuid, uuid, uuid)',
    'public.cancel_booking(uuid, text)',
    'public.admin_mark_attendance(uuid, text, text)',
    'public.admin_session_roster(date)',
    'public.admin_set_order_status(uuid, text)',
    'public.admin_set_product_price(uuid, numeric, boolean)',
    'public.mark_notifications_read(uuid[])',
    'public.member_booking_eligibility()',
    'public.member_current_block_usage()'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- Server-side only: payment fulfilment and the booking-state trigger.
revoke execute on function public.fulfill_order(uuid) from public, anon, authenticated;
revoke execute on function public.process_payment_webhook(text, text, text, text, text, numeric, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.process_payment_webhook(text, text, text, text, text, numeric, text, jsonb) to service_role;
revoke execute on function public.enforce_booking_transition() from public, anon, authenticated;
