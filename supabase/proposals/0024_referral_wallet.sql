-- Phase 9 — Refer & earn, and the wallet.
-- Requires 0016–0023. One transaction; safe to run more than once.
--
-- The rule: a member shares their code. When the friend's FIRST membership is
-- paid, the member who referred them gets Rs 500 in their wallet. Only the
-- referrer is paid. The wallet balance is spent automatically on any bill
-- (create_order takes p_use_wallet): the payment to Razorpay is reduced by the
-- amount used, never below Rs 1.
--
--  * referral_codes   one short code per member, created on first use
--  * referrals        who referred whom; a person can be referred once, never
--                     by themselves, and only before they have bought anything
--  * wallet_ledger    append-only credits and debits; balance = their sum
--  * trigger on memberships: when a membership is created active, the pending
--    referral of its owner is rewarded, once, up to referral_max_rewards per
--    referrer
--  * orders.wallet_applied; wallet spent on an order goes back if the order is
--    cancelled unpaid (or expires), and is taken again if a late payment
--    reopens it
--  * create_order(p_items, p_use_wallet): body is the live 0019 one plus the
--    wallet lines

begin;

insert into public.system_settings (key, value, description) values
  ('referral_reward_amount', '500'::jsonb, 'Rs credited to the referrer when their friend''s first membership is paid.'),
  ('referral_max_rewards', '10'::jsonb, 'Most referral rewards one member can earn.')
on conflict (key) do nothing;

create table if not exists public.referral_codes (
  user_id uuid primary key references auth.users (id) on delete cascade,
  code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references auth.users (id) on delete cascade,
  referred_id uuid not null unique references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'rewarded', 'capped')),
  reward_amount numeric,
  created_at timestamptz not null default now(),
  rewarded_at timestamptz,
  constraint referrals_not_self check (referrer_id <> referred_id)
);
create index if not exists ix_referrals_referrer on public.referrals (referrer_id);

create table if not exists public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  amount numeric not null check (amount <> 0),
  kind text not null check (kind in ('referral_reward', 'order_redeem', 'order_restore')),
  order_id uuid references public.orders (id),
  referral_id uuid references public.referrals (id),
  description text,
  created_at timestamptz not null default now()
);
create index if not exists ix_wallet_ledger_user on public.wallet_ledger (user_id, created_at desc);

alter table public.orders add column if not exists wallet_applied numeric not null default 0 check (wallet_applied >= 0);

alter table public.referral_codes enable row level security;
alter table public.referrals enable row level security;
alter table public.wallet_ledger enable row level security;

drop policy if exists "Members read own referral code" on public.referral_codes;
create policy "Members read own referral code" on public.referral_codes for select to authenticated using (user_id = auth.uid());
drop policy if exists "Members read referrals they made" on public.referrals;
create policy "Members read referrals they made" on public.referrals for select to authenticated using (referrer_id = auth.uid());
drop policy if exists "Members read own wallet" on public.wallet_ledger;
create policy "Members read own wallet" on public.wallet_ledger for select to authenticated using (user_id = auth.uid());
drop policy if exists "Staff read wallet" on public.wallet_ledger;
create policy "Staff read wallet" on public.wallet_ledger for select to authenticated using (public.is_staff_or_admin());

-- Writes happen only inside the functions below.
revoke insert, update, delete, truncate on public.referral_codes, public.referrals, public.wallet_ledger from anon, authenticated;
revoke all on public.referral_codes, public.referrals, public.wallet_ledger from anon;

create or replace function public.my_wallet_balance()
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0) from public.wallet_ledger where user_id = auth.uid();
$$;

create or replace function public.my_referral_code()
returns text language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_code text;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  select code into v_code from public.referral_codes where user_id = v_user;
  if v_code is not null then return v_code; end if;
  loop
    v_code := upper(substr(md5(random()::text || clock_timestamp()::text || v_user::text), 1, 8));
    begin
      insert into public.referral_codes (user_id, code) values (v_user, v_code);
      return v_code;
    exception when unique_violation then
      select code into v_code from public.referral_codes where user_id = v_user;  -- lost a race for this member
      if v_code is not null then return v_code; end if;                           -- otherwise the code clashed: try again
    end;
  end loop;
end;
$$;

-- Called after sign-in with the code from the invite link. Quietly refuses
-- anything that is not a first-time customer using someone else's code.
create or replace function public.claim_referral(p_code text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_referrer uuid;
begin
  if v_user is null then raise exception 'Not authenticated'; end if;
  select user_id into v_referrer from public.referral_codes where code = upper(trim(p_code));
  if v_referrer is null or v_referrer = v_user then return false; end if;
  if exists (select 1 from public.referrals where referred_id = v_user) then return false; end if;
  if exists (select 1 from public.memberships where user_id = v_user) then return false; end if;
  insert into public.referrals (referrer_id, referred_id) values (v_referrer, v_user);
  return true;
end;
$$;

create or replace function public._reward_referrer()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ref public.referrals;
  v_amount numeric := coalesce((select (value #>> '{}')::numeric from public.system_settings where key = 'referral_reward_amount'), 500);
  v_max int := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'referral_max_rewards'), 10);
begin
  select * into v_ref from public.referrals where referred_id = new.user_id and status = 'pending' for update;
  if not found then return new; end if;

  if (select count(*) from public.referrals where referrer_id = v_ref.referrer_id and status = 'rewarded') >= v_max then
    update public.referrals set status = 'capped' where id = v_ref.id;
    return new;
  end if;

  update public.referrals set status = 'rewarded', reward_amount = v_amount, rewarded_at = now() where id = v_ref.id;
  insert into public.wallet_ledger (user_id, amount, kind, referral_id, description)
  values (v_ref.referrer_id, v_amount, 'referral_reward', v_ref.id, 'A friend you referred bought their first membership');
  perform public._notify_user(v_ref.referrer_id, 'referral_reward', 'You earned Rs ' || trim(to_char(v_amount, 'FM99,99,999')),
    'A friend you referred has joined. It is in your wallet and will reduce your next bill.', jsonb_build_object('referral_id', v_ref.id));
  return new;
end;
$$;

drop trigger if exists trg_reward_referrer on public.memberships;
create trigger trg_reward_referrer after insert on public.memberships
  for each row when (new.status = 'active') execute function public._reward_referrer();

-- Wallet money follows the order: back if it is cancelled before being paid
-- (including expiry), taken again if a late payment reopens it.
create or replace function public._wallet_follow_order()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.wallet_applied > 0 and old.status = 'pending' and new.status = 'cancelled' then
    insert into public.wallet_ledger (user_id, amount, kind, order_id, description)
    values (new.user_id, new.wallet_applied, 'order_restore', new.id, 'Returned: the order was not paid');
  elsif new.wallet_applied > 0 and old.status = 'cancelled' and new.status = 'pending' then
    insert into public.wallet_ledger (user_id, amount, kind, order_id, description)
    values (new.user_id, -new.wallet_applied, 'order_redeem', new.id, 'Used on an order that was paid late');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_wallet_follow_order on public.orders;
create trigger trg_wallet_follow_order after update of status on public.orders
  for each row when (old.status is distinct from new.status) execute function public._wallet_follow_order();

drop function if exists public.create_order(jsonb);
create or replace function public.create_order(p_items jsonb, p_use_wallet boolean default false)
returns table (order_id uuid, payment_id uuid, total_amount numeric, currency text, wallet_applied numeric, amount_due numeric)
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
$$;

revoke execute on function public.create_order(jsonb, boolean) from public, anon;
grant execute on function public.create_order(jsonb, boolean) to authenticated;
revoke execute on function public.my_wallet_balance() from public, anon;
grant execute on function public.my_wallet_balance() to authenticated;
revoke execute on function public.my_referral_code() from public, anon;
grant execute on function public.my_referral_code() to authenticated;
revoke execute on function public.claim_referral(text) from public, anon;
grant execute on function public.claim_referral(text) to authenticated;
revoke execute on function public._reward_referrer() from public, anon, authenticated;
revoke execute on function public._wallet_follow_order() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
