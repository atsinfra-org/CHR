-- Reverses 0039. Keeps every product, price, photo list and order intact:
--   * the added product columns (status, specs, images, ...) and order_items.variant_id/variant_label are KEPT (they hold data);
--   * variants that were ever ordered are kept (their table stays if any exist), the rest are removed;
--   * create_order() goes back to the version before 0039; the photo bucket and its files are kept, only the admin upload rules go.
begin;
drop trigger if exists trg_store_product_status on public.store_products;
drop function if exists public._trg_store_product_status();
drop function if exists public.store_tack_details();
drop function if exists public.admin_tack_products();
drop function if exists public.admin_set_product_status(uuid, text);
drop function if exists public.admin_duplicate_product(uuid);
drop function if exists public.admin_delete_product(uuid);
drop function if exists public.admin_save_variants(uuid, jsonb);
drop function if exists public.admin_save_product(uuid, jsonb);
drop function if exists public.admin_save_category(uuid, jsonb);
drop function if exists public.admin_delete_category(uuid);
drop function if exists public._valid_tack_images(jsonb);
drop function if exists public._admin_only();
drop table if exists public.store_product_costs;
do $$ begin
  if to_regclass('public.store_product_variants') is not null
     and not exists (select 1 from public.order_items where variant_id is not null) then
    alter table public.order_items drop column if exists variant_id;
    drop table public.store_product_variants;
  end if;
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists "Admins upload tack images" on storage.objects';
    execute 'drop policy if exists "Admins replace tack images" on storage.objects';
    execute 'drop policy if exists "Admins remove tack images" on storage.objects';
  end if;
end $$;

-- create_order exactly as it was in production before 0039
CREATE OR REPLACE FUNCTION public.create_order(p_items jsonb, p_use_wallet boolean DEFAULT false)
 RETURNS TABLE(order_id uuid, payment_id uuid, total_amount numeric, currency text, wallet_applied numeric, amount_due numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_wallet numeric := 0;
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

  -- Wallet: spend at most the balance, and always leave at least Rs 1 to pay
  -- (a payment must be positive). Serialised per user so two orders cannot
  -- spend the same balance.
  if p_use_wallet then
    perform pg_advisory_xact_lock(hashtext('wallet:' || v_user::text));
    v_wallet := least(greatest(public.my_wallet_balance(), 0), v_total - 1);
  end if;

  insert into public.orders (user_id, total_amount, has_membership, has_in_store, wallet_applied)
  values (v_user, v_total, v_has_membership, v_has_instore, v_wallet)
  returning * into v_order;

  insert into public.order_items (order_id, product_id, category, name, unit_price, quantity, fulfillment, plan_id)
  select v_order.id, (l ->> 'product_id')::uuid, l ->> 'category', l ->> 'name', (l ->> 'unit_price')::numeric,
         (l ->> 'quantity')::int, l ->> 'fulfillment', nullif(l ->> 'plan_id', '')::uuid
  from jsonb_array_elements(v_lines) l;

  insert into public.payments (user_id, order_id, gateway, amount, currency, status)
  values (v_user, v_order.id, 'razorpay', v_total - v_wallet, 'INR', 'created')
  returning * into v_payment;

  if v_wallet > 0 then
    insert into public.wallet_ledger (user_id, amount, kind, order_id, description)
    values (v_user, -v_wallet, 'order_redeem', v_order.id, 'Used on an order');
  end if;

  return query select v_order.id, v_payment.id, v_order.total_amount, v_order.currency, v_wallet, v_total - v_wallet;
end;
$function$
;

notify pgrst, 'reload schema';
commit;
