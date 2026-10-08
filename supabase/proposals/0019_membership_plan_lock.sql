-- Phase 6.1 — A purchased membership plan stays unavailable for its whole validity.
-- Requires 0016, 0017, 0018. Replaces store_catalog, create_order and admin_mark_order_paid.
--
-- Rule: while the customer holds that plan with status 'active' and end_date >= today
-- (IST) — i.e. 30 days from billing — the same plan cannot be ordered again, regardless
-- of remaining classes. It becomes purchasable again the day after end_date.
-- Enforced in the database (create_order), shown in the store (store_catalog.active_until),
-- and re-checked when staff confirm payment (admin_mark_order_paid).

create or replace function public._held_plan_until(p_user uuid, p_plan uuid)
returns date language sql stable security definer set search_path = public as $$
  select max(m.end_date)
  from public.memberships m
  where m.user_id = p_user and m.plan_id = p_plan and m.status = 'active'
    and m.end_date >= (now() at time zone 'Asia/Kolkata')::date;
$$;
revoke execute on function public._held_plan_until(uuid, uuid) from public, anon, authenticated;

-- store_catalog gains active_until (null unless the caller currently holds that plan).
drop function if exists public.store_catalog();
create function public.store_catalog()
returns table (
  id uuid, sku text, category text, name text, description text, price numeric, currency text,
  fulfillment text, plan_id uuid, plan_code text, class_credits integer, validity_days integer,
  reschedules_allowed integer, is_purchasable boolean, sort_order integer, active_until date
)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  return query
  select sp.id, sp.sku, sp.category, sp.name, coalesce(sp.description, pl.description),
         coalesce(pl.price, sp.price), coalesce(pl.currency, sp.currency), sp.fulfillment,
         sp.plan_id, pl.plan_code, pl.class_credits, pl.validity_days, pl.reschedules_allowed,
         (sp.is_active and coalesce(pl.price, sp.price) is not null and (sp.plan_id is null or pl.is_active)
            and (sp.plan_id is null or public._held_plan_until(auth.uid(), sp.plan_id) is null)),
         sp.sort_order,
         case when sp.plan_id is null then null else public._held_plan_until(auth.uid(), sp.plan_id) end
  from public.store_products sp
  left join public.membership_plans pl on pl.id = sp.plan_id
  where sp.is_active and (sp.plan_id is null or pl.is_active)
  order by case sp.category when 'membership' then 1 when 'tack' then 2 else 3 end, sp.sort_order;
end;
$$;
revoke execute on function public.store_catalog() from public, anon;
grant execute on function public.store_catalog() to authenticated;

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
  v_held_until date;
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
          -- Phase 6.1: a plan the customer already holds (paid, not yet expired)
          -- cannot be bought again for its whole validity, even with 0 classes left.
          v_held_until := public._held_plan_until(v_user, v_p.plan_id);
          if v_held_until is not null then
            raise exception 'MEMBERSHIP_ALREADY_ACTIVE'
              using detail = format('You already have %s until %s. You can buy it again after that.',
                                    v_p.name, to_char(v_held_until, 'FMDD FMMon YYYY'));
          end if;
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

revoke execute on function public.create_order(jsonb) from public, anon;
grant execute on function public.create_order(jsonb) to authenticated;

-- Staff confirming payment must not create a second copy of a plan the customer already holds
-- (e.g. a pending order placed before the first purchase was confirmed).
create or replace function public.admin_mark_order_paid(
  p_order_id uuid, p_method text default 'manual', p_reference text default null
) returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders;
  v_pay public.payments;
  v_held record;
begin
  if not public.is_staff_or_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if p_method is distinct from 'manual' then raise exception 'INVALID_PAYMENT_METHOD'; end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;

  if v_order.status in ('paid', 'ready_for_collection', 'collected') then return v_order; end if;
  if v_order.status <> 'pending' then
    raise exception 'INVALID_ORDER_STATE' using detail = format('A %s order cannot be marked paid.', v_order.status);
  end if;

  select oi.name, public._held_plan_until(v_order.user_id, oi.plan_id) as held_until into v_held
  from public.order_items oi
  where oi.order_id = p_order_id and oi.category = 'membership'
    and public._held_plan_until(v_order.user_id, oi.plan_id) is not null
  limit 1;
  if found then
    raise exception 'MEMBERSHIP_ALREADY_ACTIVE'
      using detail = format('The customer already has %s until %s. Cancel this order instead.',
                            v_held.name, to_char(v_held.held_until, 'FMDD FMMon YYYY'));
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

  perform public.fulfill_order(p_order_id);

  perform public._audit('orders', p_order_id, 'ORDER_MARKED_PAID',
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'paid', 'method', p_method, 'reference', nullif(trim(p_reference), ''),
                       'amount', v_pay.amount));

  select * into v_order from public.orders where id = p_order_id;
  return v_order;
end;
$$;
revoke execute on function public.admin_mark_order_paid(uuid, text, text) from public, anon;
grant execute on function public.admin_mark_order_paid(uuid, text, text) to authenticated;
