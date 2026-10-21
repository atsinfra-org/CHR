-- 0039_tack_catalog_management.sql  (REVIEW ONLY: not applied. Apply in the Supabase SQL Editor after 0038; safe to run twice.)
--
-- Lets administrators run the whole Tack Shop from Admin -> Tack Shop, with no code change or migration per product.
-- It EXTENDS the existing store tables; nothing is dropped or recreated, no product, price or order is rewritten.
--
--   store_categories           Tack Shop categories (name, description, order, on/off). Products point at one.
--   store_products (+columns)  status draft|published|archived (kept in step with the existing is_active flag),
--                              short_description, audience, brand, compare_at_price, specs (jsonb), images (jsonb)
--   store_product_variants     optional sizes/colours per product: own SKU, optional own price, in stock yes/no
--   store_product_costs        optional cost price, readable by administrators only
--   order_items (+columns)     variant_id and variant_label, kept with the order (like name and unit_price already are)
--   create_order()             same as before, plus: a product with variants needs a valid, in-stock variant, and a
--                              variant's own price (if set) is used. Prices still come only from the database.
--   store_tack_details()       what the store needs to show categories, photos, specs and variants
--   admin_* functions          create / edit / duplicate / publish / archive / delete-if-never-ordered products,
--                              categories and variants. Every one checks is_admin() and writes the audit log.
--   Storage bucket tack-images public read; only administrators can upload, replace or remove; JPEG/PNG/WebP, 5 MB max.
--
-- Stock: there is NO counted inventory (the order flow does not reserve or deduct stock). A variant is simply "in stock"
-- or not. Counted stock would need reservation at checkout and release on expiry; see docs/TACK_SHOP_ADMIN.md.
-- Rollback: 0039_tack_catalog_management.down.sql.

begin;

-- ─── 1. Categories ──────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.store_categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 40),
  name text not null check (length(btrim(name)) between 2 and 60),
  description text check (description is null or length(description) <= 500),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.store_categories enable row level security;
drop policy if exists "Anyone reads active categories" on public.store_categories;
create policy "Anyone reads active categories" on public.store_categories for select using (is_active or public.is_staff_or_admin());
revoke insert, update, delete, truncate on public.store_categories from anon, authenticated;

insert into public.store_categories (slug, name, sort_order) values
  ('helmets', 'Helmets', 10), ('breeches', 'Breeches', 20), ('chaps', 'Chaps', 30),
  ('half-boots', 'Half Boots', 40), ('full-boots', 'Full Boots', 50), ('accessories', 'Riding Accessories', 60)
on conflict (slug) do nothing;

-- ─── 2. Product details ─────────────────────────────────────────────────────────────────────────────────────
alter table public.store_products
  add column if not exists status text,
  add column if not exists tack_category_id uuid references public.store_categories(id),
  add column if not exists short_description text,
  add column if not exists audience text,
  add column if not exists brand text,
  add column if not exists compare_at_price numeric(10,2),
  add column if not exists specs jsonb not null default '{}'::jsonb,
  add column if not exists images jsonb not null default '[]'::jsonb;

-- Hidden products stay hidden: the retired generic Breeches is "archived", any other hidden product (the cafe menu) a "draft".
update public.store_products set status = case when is_active then 'published' when sku = 'TACK_BREECHES' then 'archived' else 'draft' end
 where status is null;
alter table public.store_products alter column status set default 'published', alter column status set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'store_products_status_check') then
    alter table public.store_products add constraint store_products_status_check check (status in ('draft', 'published', 'archived'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'store_products_audience_check') then
    alter table public.store_products add constraint store_products_audience_check check (audience is null or audience in ('Men', 'Women', 'Kids', 'Unisex'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'store_products_compare_at_check') then
    alter table public.store_products add constraint store_products_compare_at_check
      check (compare_at_price is null or (compare_at_price >= 0 and (price is null or compare_at_price >= price)));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'store_products_json_shapes') then
    alter table public.store_products add constraint store_products_json_shapes
      check (jsonb_typeof(specs) = 'object' and jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 12);
  end if;
end $$;

-- status and the existing is_active flag always agree, whichever one a caller sets (admin_set_product_price sets is_active).
create or replace function public._trg_store_product_status()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.is_active is distinct from old.is_active and new.status is not distinct from old.status then
    new.status := case when new.is_active then 'published' when old.status = 'published' then 'draft' else old.status end;
  end if;
  new.is_active := (new.status = 'published');
  return new;
end;
$$;
drop trigger if exists trg_store_product_status on public.store_products;
create trigger trg_store_product_status before insert or update on public.store_products
  for each row execute function public._trg_store_product_status();

-- Categories and photos for the products that exist today (only where not set yet; never overwrites an edit).
update public.store_products sp set tack_category_id = c.id
  from public.store_categories c
 where sp.category = 'tack' and sp.tack_category_id is null
   and c.slug = case when sp.sku = 'TACK_HELMET' then 'helmets' when sp.sku like 'TACK_BREECHES%' then 'breeches'
                     when sp.sku = 'TACK_CHAPS' then 'chaps' when sp.sku = 'TACK_HALF_BOOTS' then 'half-boots'
                     when sp.sku = 'TACK_FULL_BOOTS' then 'full-boots' end;

update public.store_products sp set images = v.images, short_description = coalesce(sp.short_description, v.tagline)
  from (values
    ('TACK_HELMET',     '[{"url":"/assests/tack/helmet.jpeg","alt":"Riding helmet"}]'::jsonb,       'Essential head protection for every ride.'),
    ('TACK_CHAPS',      '[{"url":"/assests/tack/chaps.webp","alt":"Chaps"}]',                'Added leg protection and a secure grip.'),
    ('TACK_HALF_BOOTS', '[{"url":"/assests/tack/half-boots.jpg","alt":"Half boots"}]',      'Practical ankle-height boots for yard and arena.'),
    ('TACK_FULL_BOOTS', '[{"url":"/assests/tack/full-boots-web.jpg","alt":"Full boots"}]',      'Classic tall boots for a polished finish.')
  ) as v(sku, images, tagline)
 where sp.sku = v.sku and sp.images = '[]'::jsonb;

-- The nine breeches: photos (the web copies already in the site), audience and colour, from the supplied photo folders.
update public.store_products sp
   set images = (select jsonb_agg(jsonb_build_object('url', format('/assests/tack/breeches/%s/%s.jpg', v.slug, lpad(i::text, 2, '0')),
                                                     'alt', sp.name || case when i = 0 then '' else format(', photo %s', i + 1) end) order by i)
                 from generate_series(0, v.n - 1) i),
       audience = coalesce(sp.audience, v.audience),
       specs = case when sp.specs ? 'colour' then sp.specs else sp.specs || jsonb_build_object('colour', v.colour) end
  from (values
    ('TACK_BREECHES_WOMEN_NAVY', 'women-navy', 6, 'Women', 'Navy'),
    ('TACK_BREECHES_WOMEN_RED_BLACK', 'women-red-black', 6, 'Women', 'Red'),
    ('TACK_BREECHES_MEN_CHARCOAL', 'men-charcoal', 6, 'Men', 'Charcoal'),
    ('TACK_BREECHES_KIDS_NAVY_PINK', 'kids-navy-pink-details', 4, 'Kids', 'Navy'),
    ('TACK_BREECHES_KIDS_MAGENTA_FLORAL', 'kids-magenta-floral-cuffs', 4, 'Kids', 'Magenta'),
    ('TACK_BREECHES_KIDS_PINK', 'kids-pink', 5, 'Kids', 'Pink'),
    ('TACK_BREECHES_KIDS_PURPLE', 'kids-purple', 5, 'Kids', 'Purple'),
    ('TACK_BREECHES_KIDS_BLACK_STARS', 'kids-black-pink-stars', 3, 'Kids', 'Black'),
    ('TACK_BREECHES_KIDS_BLACK_CAMO', 'kids-black-pink-camo', 5, 'Kids', 'Black')
  ) as v(sku, slug, n, audience, colour)
 where sp.sku = v.sku and sp.images = '[]'::jsonb;

-- ─── 3. Variants, costs, order snapshot ─────────────────────────────────────────────────────────────────────
create table if not exists public.store_product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.store_products(id) on delete cascade,
  sku text not null unique check (sku ~ '^[A-Z0-9][A-Z0-9_-]{2,79}$'),
  size text check (size is null or length(btrim(size)) between 1 and 20),
  colour text check (colour is null or length(btrim(colour)) between 1 and 30),
  price numeric(10,2) check (price is null or (price > 0 and price <= 1000000)),
  in_stock boolean not null default true,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint variant_has_a_label check (size is not null or colour is not null)
);
create index if not exists idx_variants_product on public.store_product_variants (product_id, sort_order);
alter table public.store_product_variants enable row level security;
drop policy if exists "Anyone reads live variants" on public.store_product_variants;
create policy "Anyone reads live variants" on public.store_product_variants for select using (
  (is_active and exists (select 1 from public.store_products p where p.id = product_id and p.is_active)) or public.is_staff_or_admin());
revoke insert, update, delete, truncate on public.store_product_variants from anon, authenticated;

create table if not exists public.store_product_costs (
  product_id uuid primary key references public.store_products(id) on delete cascade,
  cost_price numeric(10,2) not null check (cost_price >= 0 and cost_price <= 1000000),
  updated_at timestamptz not null default now()
);
alter table public.store_product_costs enable row level security;
drop policy if exists "Administrators read costs" on public.store_product_costs;
create policy "Administrators read costs" on public.store_product_costs for select using (public.is_admin());
revoke all on public.store_product_costs from anon;
revoke insert, update, delete, truncate on public.store_product_costs from authenticated;

alter table public.order_items
  add column if not exists variant_id uuid references public.store_product_variants(id),
  add column if not exists variant_label text;

-- ─── 4. Checkout: unchanged, plus variants (prices only ever from the database) ─────────────────────────────
create or replace function public.create_order(p_items jsonb, p_use_wallet boolean DEFAULT false)
 returns table(order_id uuid, payment_id uuid, total_amount numeric, currency text, wallet_applied numeric, amount_due numeric)
 language plpgsql security definer set search_path to 'public'
as $function$
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
      select (e ->> 'product_id')::uuid as pid, nullif(e ->> 'variant_id', '')::uuid as vid,
             sum(coalesce((e ->> 'quantity')::int, 1)) as qty
      from jsonb_array_elements(p_items) e group by 1, 2
    loop
      v_qty := r.qty;
      declare
        v_p record;
        v_v public.store_product_variants;
        v_label text := null;
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
          if r.vid is not null then raise exception 'INVALID_CART'; end if;
          if v_qty <> 1 then raise exception 'INVALID_QUANTITY' using detail = 'Memberships are bought one at a time.'; end if;
          if not coalesce(v_p.plan_active, false) then raise exception 'PRODUCT_UNAVAILABLE'; end if;
          v_price := v_p.plan_price;
          v_has_membership := true;
          v_membership_lines := v_membership_lines + 1;
          v_held_until := public._held_plan_until(v_user, v_p.plan_id);
          if v_held_until is not null then
            raise exception 'MEMBERSHIP_ALREADY_ACTIVE'
              using detail = format('You already have %s until %s. You can buy it again after that.',
                                    v_p.name, to_char(v_held_until, 'FMDD FMMon YYYY'));
          end if;
        else
          v_price := v_p.price;
          -- A product sold in sizes/colours must be bought as one of them, and that one must be on sale.
          if r.vid is not null then
            select * into v_v from public.store_product_variants where id = r.vid and product_id = v_p.id;
            if not found or not v_v.is_active then raise exception 'VARIANT_UNAVAILABLE'; end if;
            if not v_v.in_stock then
              raise exception 'OUT_OF_STOCK' using detail = format('%s (%s) is out of stock.', v_p.name, concat_ws(', ', v_v.size, v_v.colour));
            end if;
            v_price := coalesce(v_v.price, v_p.price);
            v_label := concat_ws(' / ', v_v.size, v_v.colour);
          elsif exists (select 1 from public.store_product_variants where product_id = v_p.id and is_active) then
            raise exception 'VARIANT_REQUIRED' using detail = format('Choose a size or colour for %s.', v_p.name);
          end if;
          v_has_instore := true;
        end if;

        if v_price is null then
          raise exception 'PRICE_NOT_SET' using detail = format('%s is not available to buy yet.', v_p.name);
        end if;

        v_total := v_total + v_price * v_qty;
        v_lines := v_lines || jsonb_build_object(
          'product_id', v_p.id, 'category', v_p.category, 'name', v_p.name, 'unit_price', v_price,
          'quantity', v_qty, 'fulfillment', v_p.fulfillment, 'plan_id', v_p.plan_id,
          'variant_id', r.vid, 'variant_label', v_label);
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

  if p_use_wallet then
    perform pg_advisory_xact_lock(hashtext('wallet:' || v_user::text));
    v_wallet := least(greatest(public.my_wallet_balance(), 0), v_total - 1);
  end if;

  insert into public.orders (user_id, total_amount, has_membership, has_in_store, wallet_applied)
  values (v_user, v_total, v_has_membership, v_has_instore, v_wallet)
  returning * into v_order;

  insert into public.order_items (order_id, product_id, category, name, unit_price, quantity, fulfillment, plan_id, variant_id, variant_label)
  select v_order.id, (l ->> 'product_id')::uuid, l ->> 'category', l ->> 'name', (l ->> 'unit_price')::numeric,
         (l ->> 'quantity')::int, l ->> 'fulfillment', nullif(l ->> 'plan_id', '')::uuid,
         nullif(l ->> 'variant_id', '')::uuid, nullif(l ->> 'variant_label', '')
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
$function$;

-- ─── 5. What the store shows ────────────────────────────────────────────────────────────────────────────────
-- Prices and "can it be bought" still come from store_catalog(); this adds the display details for published tack.
create or replace function public.store_tack_details()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'description', c.description)
                                             order by c.sort_order, c.name)
                            from public.store_categories c where c.is_active), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'sku', p.sku, 'category_id', p.tack_category_id, 'category_slug', c.slug,
        'short_description', p.short_description, 'description', p.description, 'audience', p.audience, 'brand', p.brand,
        'compare_at_price', p.compare_at_price, 'specs', p.specs, 'images', p.images, 'sort_order', p.sort_order,
        'variants', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'size', v.size, 'colour', v.colour, 'price', v.price, 'in_stock', v.in_stock)
                                               order by v.sort_order, v.size, v.colour)
                              from public.store_product_variants v where v.product_id = p.id and v.is_active), '[]'::jsonb))
        order by p.sort_order, p.name)
      from public.store_products p left join public.store_categories c on c.id = p.tack_category_id
      where p.category = 'tack' and p.status = 'published' and (c.id is null or c.is_active)), '[]'::jsonb));
$$;
revoke execute on function public.store_tack_details() from public;
grant execute on function public.store_tack_details() to anon, authenticated;

-- ─── 6. Administration (administrators only; every change is audited) ───────────────────────────────────────
create or replace function public._admin_only() returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'FORBIDDEN'; end if;
end;
$$;
revoke execute on function public._admin_only() from public, anon, authenticated;

-- An image is either one of the site's own files (/assests/...) or a file in the tack-images bucket of this project.
create or replace function public._valid_tack_images(p jsonb) returns boolean language sql immutable as $$
  select jsonb_typeof(p) = 'array' and jsonb_array_length(p) <= 12 and not exists (
    select 1 from jsonb_array_elements(p) e
    where jsonb_typeof(e) <> 'object'
       or coalesce(e ->> 'url', '') !~ '^(/assests/[A-Za-z0-9/_.-]+\.(jpe?g|png|webp)|https://[a-z0-9.-]+/storage/v1/object/public/tack-images/[A-Za-z0-9/_.-]+\.(jpe?g|png|webp))$'
       or length(coalesce(e ->> 'alt', '')) > 200)
$$;

create or replace function public.admin_tack_products()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public._admin_only();
  return jsonb_build_object(
    'categories', coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('product_count', (select count(*) from public.store_products p where p.tack_category_id = c.id))
                                             order by c.sort_order, c.name) from public.store_categories c), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(to_jsonb(p) - 'plan_id'
        || jsonb_build_object('category_slug', c.slug, 'category_name', c.name,
             'cost_price', (select cost_price from public.store_product_costs k where k.product_id = p.id),
             'order_count', (select count(*) from public.order_items oi where oi.product_id = p.id),
             'variants', coalesce((select jsonb_agg(to_jsonb(v) || jsonb_build_object('order_count', (select count(*) from public.order_items oi where oi.variant_id = v.id))
                                                   order by v.sort_order, v.size, v.colour)
                                   from public.store_product_variants v where v.product_id = p.id), '[]'::jsonb))
        order by p.sort_order, p.name)
      from public.store_products p left join public.store_categories c on c.id = p.tack_category_id
      where p.category = 'tack'), '[]'::jsonb));
end;
$$;

-- Creates (p_id null) or updates a tack product. Only the keys present in p_data are changed.
create or replace function public.admin_save_product(p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_old public.store_products;
  v_new public.store_products;
  v_specs jsonb;
  k text;
begin
  perform public._admin_only();
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'INVALID_VALUE'; end if;

  if p_id is not null then
    select * into v_old from public.store_products where id = p_id for update;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
    if v_old.category <> 'tack' then raise exception 'NOT_A_TACK_PRODUCT'; end if;
    v_new := v_old;
  else
    v_new.category := 'tack'; v_new.fulfillment := 'IN_STORE_ONLY'; v_new.currency := 'INR';
    v_new.status := 'draft'; v_new.specs := '{}'::jsonb; v_new.images := '[]'::jsonb; v_new.sort_order := 0;
  end if;

  if p_data ? 'name' then v_new.name := btrim(p_data ->> 'name'); end if;
  if p_data ? 'sku' then v_new.sku := upper(btrim(p_data ->> 'sku')); end if;
  if p_data ? 'status' then v_new.status := p_data ->> 'status'; end if;
  if p_data ? 'category_id' then v_new.tack_category_id := nullif(p_data ->> 'category_id', '')::uuid; end if;
  if p_data ? 'short_description' then v_new.short_description := nullif(btrim(p_data ->> 'short_description'), ''); end if;
  if p_data ? 'description' then v_new.description := nullif(btrim(p_data ->> 'description'), ''); end if;
  if p_data ? 'audience' then v_new.audience := nullif(p_data ->> 'audience', ''); end if;
  if p_data ? 'brand' then v_new.brand := nullif(btrim(p_data ->> 'brand'), ''); end if;
  if p_data ? 'price' then v_new.price := nullif(p_data ->> 'price', '')::numeric; end if;
  if p_data ? 'compare_at_price' then v_new.compare_at_price := nullif(p_data ->> 'compare_at_price', '')::numeric; end if;
  if p_data ? 'sort_order' then v_new.sort_order := coalesce((p_data ->> 'sort_order')::int, 0); end if;
  if p_data ? 'images' then v_new.images := p_data -> 'images'; end if;
  if p_data ? 'specs' then
    v_specs := p_data -> 'specs';
    if jsonb_typeof(v_specs) <> 'object' then raise exception 'INVALID_VALUE' using detail = 'Specifications are not valid.'; end if;
    for k in select jsonb_object_keys(v_specs) loop
      if k not in ('colour', 'sizes', 'material', 'fit', 'care', 'features', 'extra') then
        raise exception 'INVALID_VALUE' using detail = format('Unknown specification "%s".', k);
      end if;
    end loop;
    if length(v_specs::text) > 6000 then raise exception 'INVALID_VALUE' using detail = 'Specifications are too long.'; end if;
    v_new.specs := v_specs;
  end if;

  if v_new.name is null or length(v_new.name) not between 2 and 120 then raise exception 'INVALID_VALUE' using detail = 'The name must be 2 to 120 characters.'; end if;
  if v_new.sku is null or v_new.sku !~ '^[A-Z0-9][A-Z0-9_-]{2,59}$' then raise exception 'INVALID_VALUE' using detail = 'The SKU must be 3 to 60 capital letters, numbers, - or _.'; end if;
  if exists (select 1 from public.store_products where sku = v_new.sku and id is distinct from p_id) then raise exception 'SKU_TAKEN'; end if;
  if v_new.status not in ('draft', 'published', 'archived') then raise exception 'INVALID_VALUE' using detail = 'Unknown status.'; end if;
  if v_new.price is not null and (v_new.price <= 0 or v_new.price > 1000000) then raise exception 'INVALID_VALUE' using detail = 'The price must be above 0 and at most 10,00,000.'; end if;
  if v_new.compare_at_price is not null and (v_new.compare_at_price <= 0 or v_new.compare_at_price > 1000000 or v_new.price is null or v_new.compare_at_price < v_new.price) then
    raise exception 'INVALID_VALUE' using detail = 'A compare-at price needs a selling price and must not be lower than it.';
  end if;
  if v_new.tack_category_id is not null and not exists (select 1 from public.store_categories where id = v_new.tack_category_id) then raise exception 'CATEGORY_NOT_FOUND'; end if;
  if v_new.audience is not null and v_new.audience not in ('Men', 'Women', 'Kids', 'Unisex') then raise exception 'INVALID_VALUE' using detail = 'Unknown audience.'; end if;
  if not public._valid_tack_images(v_new.images) then raise exception 'INVALID_VALUE' using detail = 'One of the photos is not a valid shop image.'; end if;
  if length(coalesce(v_new.description, '')) > 4000 or length(coalesce(v_new.short_description, '')) > 300 or length(coalesce(v_new.brand, '')) > 60 then
    raise exception 'INVALID_VALUE' using detail = 'A text field is too long.';
  end if;

  if p_id is null then
    insert into public.store_products (sku, category, name, description, price, currency, fulfillment, sort_order, status,
                                       tack_category_id, short_description, audience, brand, compare_at_price, specs, images)
    values (v_new.sku, 'tack', v_new.name, v_new.description, v_new.price, 'INR', 'IN_STORE_ONLY', v_new.sort_order, v_new.status,
            v_new.tack_category_id, v_new.short_description, v_new.audience, v_new.brand, v_new.compare_at_price, v_new.specs, v_new.images)
    returning * into v_new;
    perform public._audit('store_products', v_new.id, 'PRODUCT_CREATED', null,
      jsonb_build_object('sku', v_new.sku, 'name', v_new.name, 'price', v_new.price, 'status', v_new.status));
  else
    update public.store_products set sku = v_new.sku, name = v_new.name, description = v_new.description, price = v_new.price,
      sort_order = v_new.sort_order, status = v_new.status, tack_category_id = v_new.tack_category_id,
      short_description = v_new.short_description, audience = v_new.audience, brand = v_new.brand,
      compare_at_price = v_new.compare_at_price, specs = v_new.specs, images = v_new.images, updated_at = now()
    where id = p_id returning * into v_new;
    perform public._audit('store_products', p_id,
      case when v_old.price is distinct from v_new.price then 'PRODUCT_PRICE_CHANGED'
           when v_old.status is distinct from v_new.status then 'PRODUCT_STATUS_CHANGED' else 'PRODUCT_UPDATED' end,
      jsonb_build_object('sku', v_old.sku, 'name', v_old.name, 'price', v_old.price, 'compare_at_price', v_old.compare_at_price,
                         'status', v_old.status, 'category_id', v_old.tack_category_id, 'images', jsonb_array_length(v_old.images)),
      jsonb_build_object('sku', v_new.sku, 'name', v_new.name, 'price', v_new.price, 'compare_at_price', v_new.compare_at_price,
                         'status', v_new.status, 'category_id', v_new.tack_category_id, 'images', jsonb_array_length(v_new.images)));
  end if;

  if p_data ? 'cost_price' then
    if nullif(p_data ->> 'cost_price', '') is null then
      delete from public.store_product_costs where product_id = v_new.id;
    else
      if (p_data ->> 'cost_price')::numeric < 0 or (p_data ->> 'cost_price')::numeric > 1000000 then raise exception 'INVALID_VALUE' using detail = 'The cost price is not valid.'; end if;
      insert into public.store_product_costs (product_id, cost_price) values (v_new.id, (p_data ->> 'cost_price')::numeric)
      on conflict (product_id) do update set cost_price = excluded.cost_price, updated_at = now();
    end if;
  end if;
  return v_new.id;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'INVALID_VALUE' using detail = 'A number or choice in the form is not valid.';
end;
$$;

create or replace function public.admin_set_product_status(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._admin_only();
  perform public.admin_save_product(p_id, jsonb_build_object('status', p_status));
end;
$$;

-- A copy starts as a DRAFT with NO price (a price is never assigned automatically).
create or replace function public.admin_duplicate_product(p_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v public.store_products;
  v_sku text;
  v_new uuid;
  n int := 1;
begin
  perform public._admin_only();
  select * into v from public.store_products where id = p_id and category = 'tack';
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  loop
    v_sku := left(v.sku, 52) || '_COPY' || case when n = 1 then '' else n::text end;
    exit when not exists (select 1 from public.store_products where sku = v_sku);
    n := n + 1;
  end loop;
  v_new := public.admin_save_product(null, jsonb_build_object(
    'sku', v_sku, 'name', left(v.name || ' (copy)', 120), 'status', 'draft', 'category_id', v.tack_category_id,
    'short_description', v.short_description, 'description', v.description, 'audience', v.audience, 'brand', v.brand,
    'specs', v.specs, 'images', v.images, 'sort_order', v.sort_order));
  return v_new;
end;
$$;

-- Permanent deletion only for a product nobody has ever ordered, and only once it is not published.
create or replace function public.admin_delete_product(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v public.store_products;
begin
  perform public._admin_only();
  select * into v from public.store_products where id = p_id and category = 'tack' for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if v.status = 'published' then raise exception 'UNPUBLISH_FIRST'; end if;
  if exists (select 1 from public.order_items where product_id = p_id) then raise exception 'PRODUCT_HAS_ORDERS'; end if;
  delete from public.store_products where id = p_id;
  perform public._audit('store_products', p_id, 'PRODUCT_DELETED', jsonb_build_object('sku', v.sku, 'name', v.name, 'price', v.price), null);
end;
$$;

-- Replaces a product's variant list. A variant left out is deleted if never ordered, otherwise switched off.
create or replace function public.admin_save_variants(p_product_id uuid, p_variants jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  e jsonb;
  v_keep uuid[] := '{}';
  v_id uuid;
  i int := 0;
begin
  perform public._admin_only();
  if not exists (select 1 from public.store_products where id = p_product_id and category = 'tack') then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if p_variants is null or jsonb_typeof(p_variants) <> 'array' or jsonb_array_length(p_variants) > 60 then raise exception 'INVALID_VALUE' using detail = 'Too many variants.'; end if;
  for e in select * from jsonb_array_elements(p_variants) loop
    i := i + 1;
    v_id := nullif(e ->> 'id', '')::uuid;
    -- a variant sent again without its id is matched by its SKU on this product (no duplicate is created)
    if v_id is null then
      select id into v_id from public.store_product_variants where product_id = p_product_id and sku = upper(btrim(e ->> 'sku'));
    end if;
    if v_id is not null and not exists (select 1 from public.store_product_variants where id = v_id and product_id = p_product_id) then raise exception 'VARIANT_NOT_FOUND'; end if;
    if exists (select 1 from public.store_product_variants where sku = upper(btrim(e ->> 'sku')) and id is distinct from v_id)
       or exists (select 1 from public.store_products where sku = upper(btrim(e ->> 'sku'))) then raise exception 'SKU_TAKEN' using detail = format('SKU %s is already used.', e ->> 'sku'); end if;
    if v_id is null then
      insert into public.store_product_variants (product_id, sku, size, colour, price, in_stock, is_active, sort_order)
      values (p_product_id, upper(btrim(e ->> 'sku')), nullif(btrim(e ->> 'size'), ''), nullif(btrim(e ->> 'colour'), ''),
              nullif(e ->> 'price', '')::numeric, coalesce((e ->> 'in_stock')::boolean, true), coalesce((e ->> 'is_active')::boolean, true), i)
      returning id into v_id;
    else
      update public.store_product_variants set sku = upper(btrim(e ->> 'sku')), size = nullif(btrim(e ->> 'size'), ''),
        colour = nullif(btrim(e ->> 'colour'), ''), price = nullif(e ->> 'price', '')::numeric,
        in_stock = coalesce((e ->> 'in_stock')::boolean, true), is_active = coalesce((e ->> 'is_active')::boolean, true),
        sort_order = i, updated_at = now()
      where id = v_id;
    end if;
    v_keep := v_keep || v_id;
  end loop;
  update public.store_product_variants set is_active = false, updated_at = now()
   where product_id = p_product_id and not (id = any(v_keep)) and exists (select 1 from public.order_items oi where oi.variant_id = store_product_variants.id);
  delete from public.store_product_variants
   where product_id = p_product_id and not (id = any(v_keep)) and not exists (select 1 from public.order_items oi where oi.variant_id = store_product_variants.id);
  perform public._audit('store_products', p_product_id, 'PRODUCT_VARIANTS_CHANGED', null, jsonb_build_object('variants', jsonb_array_length(p_variants)));
exception
  when check_violation then raise exception 'INVALID_VALUE' using detail = 'A variant needs a SKU (capital letters, numbers, - or _), a size or colour, and a price above 0 if set.';
  when invalid_text_representation or numeric_value_out_of_range then raise exception 'INVALID_VALUE' using detail = 'A variant price is not valid.';
end;
$$;

create or replace function public.admin_save_category(p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_old public.store_categories;
  v_id uuid;
  v_slug text;
begin
  perform public._admin_only();
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'INVALID_VALUE'; end if;
  v_slug := coalesce(nullif(p_data ->> 'slug', ''), trim(both '-' from regexp_replace(lower(coalesce(p_data ->> 'name', '')), '[^a-z0-9]+', '-', 'g')));
  if p_id is null then
    insert into public.store_categories (slug, name, description, sort_order, is_active)
    values (v_slug, btrim(p_data ->> 'name'), nullif(btrim(p_data ->> 'description'), ''), coalesce((p_data ->> 'sort_order')::int, 0), coalesce((p_data ->> 'is_active')::boolean, true))
    returning id into v_id;
    perform public._audit('store_categories', v_id, 'CATEGORY_CREATED', null, p_data);
  else
    select * into v_old from public.store_categories where id = p_id for update;
    if not found then raise exception 'CATEGORY_NOT_FOUND'; end if;
    update public.store_categories set
      name = coalesce(btrim(p_data ->> 'name'), name),
      description = case when p_data ? 'description' then nullif(btrim(p_data ->> 'description'), '') else description end,
      sort_order = coalesce((p_data ->> 'sort_order')::int, sort_order),
      is_active = coalesce((p_data ->> 'is_active')::boolean, is_active),
      updated_at = now()
    where id = p_id returning id into v_id;
    perform public._audit('store_categories', p_id, 'CATEGORY_UPDATED', to_jsonb(v_old), p_data);
  end if;
  return v_id;
exception
  when unique_violation then raise exception 'CATEGORY_TAKEN' using detail = 'A category with that name already exists.';
  when check_violation or not_null_violation then raise exception 'INVALID_VALUE' using detail = 'A category needs a name of 2 to 60 characters.';
  when invalid_text_representation then raise exception 'INVALID_VALUE';
end;
$$;

-- A category in use is never deleted (switch it off instead).
create or replace function public.admin_delete_category(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v public.store_categories;
begin
  perform public._admin_only();
  select * into v from public.store_categories where id = p_id;
  if not found then raise exception 'CATEGORY_NOT_FOUND'; end if;
  if exists (select 1 from public.store_products where tack_category_id = p_id) then raise exception 'CATEGORY_IN_USE'; end if;
  delete from public.store_categories where id = p_id;
  perform public._audit('store_categories', p_id, 'CATEGORY_DELETED', to_jsonb(v), null);
end;
$$;

revoke execute on function public.admin_tack_products() from public, anon;
revoke execute on function public.admin_save_product(uuid, jsonb) from public, anon;
revoke execute on function public.admin_set_product_status(uuid, text) from public, anon;
revoke execute on function public.admin_duplicate_product(uuid) from public, anon;
revoke execute on function public.admin_delete_product(uuid) from public, anon;
revoke execute on function public.admin_save_variants(uuid, jsonb) from public, anon;
revoke execute on function public.admin_save_category(uuid, jsonb) from public, anon;
revoke execute on function public.admin_delete_category(uuid) from public, anon;
grant execute on function public.admin_tack_products() to authenticated;
grant execute on function public.admin_save_product(uuid, jsonb) to authenticated;
grant execute on function public.admin_set_product_status(uuid, text) to authenticated;
grant execute on function public.admin_duplicate_product(uuid) to authenticated;
grant execute on function public.admin_delete_product(uuid) to authenticated;
grant execute on function public.admin_save_variants(uuid, jsonb) to authenticated;
grant execute on function public.admin_save_category(uuid, jsonb) to authenticated;
grant execute on function public.admin_delete_category(uuid) to authenticated;

-- ─── 7. Photo storage (skipped where Supabase Storage is not present, e.g. a plain Postgres test copy) ────────
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present: bucket and policies skipped';
    return;
  end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('tack-images', 'tack-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

  execute 'drop policy if exists "Admins upload tack images" on storage.objects';
  execute 'drop policy if exists "Admins replace tack images" on storage.objects';
  execute 'drop policy if exists "Admins remove tack images" on storage.objects';
  execute $p$create policy "Admins upload tack images" on storage.objects for insert to authenticated
            with check (bucket_id = 'tack-images' and public.is_admin())$p$;
  execute $p$create policy "Admins replace tack images" on storage.objects for update to authenticated
            using (bucket_id = 'tack-images' and public.is_admin()) with check (bucket_id = 'tack-images' and public.is_admin())$p$;
  execute $p$create policy "Admins remove tack images" on storage.objects for delete to authenticated
            using (bucket_id = 'tack-images' and public.is_admin())$p$;
end $$;

notify pgrst, 'reload schema';

commit;
