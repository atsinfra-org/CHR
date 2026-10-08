-- Phase 5 (part 1/2) — Store, credit model, horse-level booking: SCHEMA.
--
-- Extends the existing schema; creates no parallel tables for anything that
-- already exists (plans, memberships, payments, credit_ledger, bookings,
-- attendance, audit_logs, class_sessions, schedule_templates, horses).
--
-- Migration strategy (documented per brief §45/§46):
--  * Live DB at migration time: 2 profiles, 0 memberships, 0 payments,
--    0 bookings, 0 ledger rows, 0 attendance. Nothing historical can be
--    harmed. Everything is additive or soft (deactivate, never delete),
--    except FUTURE, UNBOOKED, generated sessions of the retired operating
--    schedule, which are removed and regenerated (past sessions untouched).
--  * Legacy "Junior/Adult Riding Membership" plans are DEACTIVATED, not
--    deleted, so any historic row that references them stays valid.
--  * Rollback: see 0016_store_credit_model.down.sql.

-- ─── 1. Membership plans: Gold / Platinum / One-Time Ride ───────────────────
alter table public.membership_plans
  add column if not exists plan_code text,
  add column if not exists reschedules_allowed integer not null default 2,
  add column if not exists kind text not null default 'membership';

alter table public.membership_plans
  add constraint membership_plans_plan_code_key unique (plan_code),
  add constraint membership_plans_reschedules_allowed_check check (reschedules_allowed >= 0),
  add constraint membership_plans_kind_check check (kind in ('membership', 'one_time_ride'));

-- Retire the old age-banded plans (no memberships reference them yet).
update public.membership_plans set is_active = false where plan_code is null;

insert into public.membership_plans
  (name, description, price, currency, class_credits, validity_days, min_age, max_age, is_active, plan_code, reschedules_allowed, kind)
values
  ('Gold Membership',     '8 riding classes, 2 reschedules',  15000, 'INR',  8, 30, null, null, true, 'GOLD',          2, 'membership'),
  ('Platinum Membership', '12 riding classes, 2 reschedules', 18000, 'INR', 12, 30, null, null, true, 'PLATINUM',      2, 'membership'),
  ('One-Time Ride',       'A single riding class',             2000, 'INR',  1, 30, null, null, true, 'ONE_TIME_RIDE', 1, 'one_time_ride');

-- ─── 2. Memberships: reschedule allowance + idempotent activation key ──────
alter table public.memberships
  add column if not exists total_credits integer,
  add column if not exists reschedules_allowed integer not null default 0,
  add column if not exists reschedules_used integer not null default 0,
  add column if not exists order_item_id uuid;

alter table public.memberships
  add constraint memberships_reschedules_check
  check (reschedules_used >= 0 and reschedules_used <= reschedules_allowed);

update public.memberships m
set total_credits = p.class_credits,
    reschedules_allowed = p.reschedules_allowed
from public.membership_plans p
where p.id = m.plan_id and m.total_credits is null;

-- A store order may legitimately contain a membership while an earlier one
-- is still active (two tabs, a renewal bought early). Payment has already
-- been captured at that point, so activation must never fail on this index.
drop index if exists public.uq_memberships_one_active_per_user;

-- ─── 3. Credit ledger: new transaction types, zero-amount reschedule rows ──
alter table public.credit_ledger drop constraint if exists credit_ledger_amount_check;
alter table public.credit_ledger drop constraint if exists credit_ledger_transaction_type_check;

alter table public.credit_ledger
  add constraint credit_ledger_transaction_type_check
  check (transaction_type in
    ('membership_purchase','booking','cancellation','admin_adjustment','refund','expiry',
     'absence_restore','reschedule')),
  add constraint credit_ledger_amount_check
  check (amount <> 0 or transaction_type = 'reschedule');

-- One restoration per booking, enforced by the database, not by app logic.
create unique index if not exists uq_credit_ledger_absence_restore_per_booking
  on public.credit_ledger (booking_id)
  where transaction_type = 'absence_restore';

-- ─── 4. Bookings: horse-level protection, reschedule chain, new states ────
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings
  add constraint bookings_status_check
  check (status in ('held','confirmed','cancelled','completed','no_show','expired','absent','rescheduled'));

alter table public.bookings
  add column if not exists original_booking_id uuid references public.bookings(id),
  add column if not exists reschedule_count integer not null default 0;

create index if not exists idx_bookings_original_booking on public.bookings (original_booking_id)
  where original_booking_id is not null;

-- THE double-booking guard: one active booking per (session, horse).
create unique index if not exists uq_bookings_active_horse_per_session
  on public.bookings (session_id, horse_id)
  where horse_id is not null and status in ('held', 'confirmed');

-- ─── 5. Policy settings (configurable, not hard-coded) ──────────────────────
insert into public.system_settings (key, value, description) values
  ('absence_credit_restore_enabled', 'true'::jsonb,
   'When true, an ABSENT/EXCUSED attendance mark restores the booking''s credit (once per booking).'),
  ('max_restored_absences', 'null'::jsonb,
   'Max absence restorations per membership. null = unlimited. Guards against book/absent/restore loops.')
on conflict (key) do nothing;

-- ─── 6. Operating schedule: Tue–Sun, 5 sessions/day, 3 horses ──────────────
-- (Source Excel was not available to this build; structure taken verbatim
--  from the brief: 07-08, 08-09, 16-17, 17-18, 18-19. dow: 0=Sun … 6=Sat.)
update public.schedule_templates set is_active = false;

with slots(st, et) as (
  values ('07:00'::time, '08:00'::time), ('08:00', '09:00'), ('16:00', '17:00'), ('17:00', '18:00'), ('18:00', '19:00')
), days(d) as (values (2), (3), (4), (5), (6), (0))
update public.schedule_templates t
set is_active = true, capacity = 3
from days, slots
where t.day_of_week = days.d and t.start_time = slots.st and t.end_time = slots.et;

with slots(st, et) as (
  values ('07:00'::time, '08:00'::time), ('08:00', '09:00'), ('16:00', '17:00'), ('17:00', '18:00'), ('18:00', '19:00')
), days(d) as (values (2), (3), (4), (5), (6), (0))
insert into public.schedule_templates (day_of_week, start_time, end_time, capacity, is_active)
select days.d, slots.st, slots.et, 3, true
from days cross join slots
where not exists (
  select 1 from public.schedule_templates t
  where t.day_of_week = days.d and t.start_time = slots.st and t.end_time = slots.et
);

-- Remove only FUTURE, UNBOOKED sessions from the retired schedule; past
-- sessions and anything with a booking are preserved.
delete from public.class_sessions s
where s.session_date >= (now() at time zone 'Asia/Kolkata')::date
  and not exists (select 1 from public.bookings b where b.session_id = s.id)
  and (s.template_id is null
       or not exists (select 1 from public.schedule_templates t where t.id = s.template_id and t.is_active));

-- Regenerate 36 days of sessions (booking window is 30 days) from the new templates.
insert into public.class_sessions (session_date, start_time, end_time, capacity, template_id)
select d::date, t.start_time, t.end_time, coalesce(t.capacity, 3), t.id
from generate_series((now() at time zone 'Asia/Kolkata')::date,
                     (now() at time zone 'Asia/Kolkata')::date + 36, interval '1 day') as d
join public.schedule_templates t on t.day_of_week = extract(dow from d) and t.is_active
on conflict (session_date, start_time, end_time) do nothing;

-- ─── 7. Store catalog ───────────────────────────────────────────────────────
create table public.store_products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  category text not null check (category in ('membership', 'tack', 'cafe')),
  name text not null,
  description text,
  -- For memberships the authoritative price lives on membership_plans; this
  -- stays null so there is exactly one source of truth. For tack/cafe a null
  -- price means "not yet priced" => not purchasable (brief §7: never invent).
  price numeric(10,2) check (price is null or price >= 0),
  currency text not null default 'INR',
  fulfillment text not null check (fulfillment in ('SERVICE', 'IN_STORE_ONLY')),
  plan_id uuid references public.membership_plans(id),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_products_membership_plan check ((category = 'membership') = (plan_id is not null)),
  constraint store_products_fulfillment_rule check (
    (category = 'membership' and fulfillment = 'SERVICE' and price is null)
    or (category <> 'membership' and fulfillment = 'IN_STORE_ONLY')
  )
);
create trigger trg_store_products_updated_at before update on public.store_products
  for each row execute function public.set_updated_at();

insert into public.store_products (sku, category, name, description, price, fulfillment, plan_id, sort_order)
select 'MEM_' || p.plan_code, 'membership', p.name, p.description, null, 'SERVICE', p.id,
       case p.plan_code when 'ONE_TIME_RIDE' then 1 when 'GOLD' then 2 else 3 end
from public.membership_plans p where p.plan_code is not null;

insert into public.store_products (sku, category, name, price, fulfillment, sort_order) values
  ('TACK_BREECHES',   'tack', 'Breeches',   4000, 'IN_STORE_ONLY', 1),
  ('TACK_HELMET',     'tack', 'Helmet',     2500, 'IN_STORE_ONLY', 2),
  ('TACK_CHAPS',      'tack', 'Chaps',      2500, 'IN_STORE_ONLY', 3),
  ('TACK_HALF_BOOTS', 'tack', 'Half Boots', 3500, 'IN_STORE_ONLY', 4),
  ('TACK_FULL_BOOTS', 'tack', 'Full Boots', 7000, 'IN_STORE_ONLY', 5),
  ('CAFE_TEA_MILK',   'cafe', 'Tea Milk',            25,  'IN_STORE_ONLY', 1),
  ('CAFE_MAGGIE',     'cafe', 'Maggie',              50,  'IN_STORE_ONLY', 2),
  ('CAFE_PAKORA',     'cafe', 'Pakora/Bhajia',       75,  'IN_STORE_ONLY', 3),
  ('CAFE_CHICKEN_FR', 'cafe', 'Chicken Fried Rice',  150, 'IN_STORE_ONLY', 4),
  ('CAFE_VEG_FR',     'cafe', 'Veg Fried Rice',      125, 'IN_STORE_ONLY', 5),
  ('CAFE_COLD_DRINK', 'cafe', 'Cold Drink',          null,'IN_STORE_ONLY', 6),
  ('CAFE_WATER',      'cafe', 'Water',               null,'IN_STORE_ONLY', 7),
  ('CAFE_VEG_SW',     'cafe', 'Veg Sandwich',        100, 'IN_STORE_ONLY', 8),
  ('CAFE_CHICKEN_SW', 'cafe', 'Chicken Sandwich',    150, 'IN_STORE_ONLY', 9);

-- ─── 8. Orders / order items ────────────────────────────────────────────────
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  status text not null default 'pending'
    check (status in ('pending','paid','ready_for_collection','collected','cancelled','failed')),
  total_amount numeric(10,2) not null check (total_amount > 0),
  currency text not null default 'INR',
  has_membership boolean not null default false,
  has_in_store boolean not null default false,
  paid_at timestamptz,
  collected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_orders_user on public.orders (user_id, created_at desc);
create index idx_orders_status on public.orders (status, created_at desc);
create trigger trg_orders_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid not null references public.store_products(id),
  category text not null check (category in ('membership', 'tack', 'cafe')),
  name text not null,
  unit_price numeric(10,2) not null check (unit_price >= 0),
  quantity integer not null check (quantity between 1 and 20),
  fulfillment text not null check (fulfillment in ('SERVICE', 'IN_STORE_ONLY')),
  plan_id uuid references public.membership_plans(id),
  created_at timestamptz not null default now()
);
create index idx_order_items_order on public.order_items (order_id);

alter table public.memberships
  add constraint memberships_order_item_id_fkey foreign key (order_item_id) references public.order_items(id);
create unique index uq_memberships_order_item on public.memberships (order_item_id) where order_item_id is not null;

-- One gateway payment per order; membership_id is only set by the legacy flow.
alter table public.payments alter column membership_id drop not null;
alter table public.payments add column order_id uuid references public.orders(id);
create unique index uq_payments_order on public.payments (order_id) where order_id is not null;
alter table public.payments
  add constraint payments_subject_check check (membership_id is not null or order_id is not null);

-- ─── 9. Notifications ───────────────────────────────────────────────────────
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  audience text not null check (audience in ('user', 'admin')),
  user_id uuid references public.profiles(id),
  type text not null,
  title text not null,
  body text,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_audience_user check ((audience = 'user') = (user_id is not null))
);
create index idx_notifications_user on public.notifications (user_id, created_at desc) where audience = 'user';
create index idx_notifications_admin on public.notifications (created_at desc) where audience = 'admin';

-- ─── 10. RLS (writes are RPC-only: no insert/update/delete policies) ───────
alter table public.store_products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.notifications enable row level security;

create policy "Anyone reads active products" on public.store_products
  for select to anon, authenticated using (is_active);
create policy "Staff/admin read all products" on public.store_products
  for select to authenticated using (public.is_staff_or_admin());
-- (Product price/availability changes go through admin_set_product_price().)

create policy "Members read own orders" on public.orders
  for select to authenticated using (user_id = auth.uid());
create policy "Staff/admin read all orders" on public.orders
  for select to authenticated using (public.is_staff_or_admin());

create policy "Members read own order items" on public.order_items
  for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_items.order_id and o.user_id = auth.uid()));
create policy "Staff/admin read all order items" on public.order_items
  for select to authenticated using (public.is_staff_or_admin());

create policy "Members read own notifications" on public.notifications
  for select to authenticated using (audience = 'user' and user_id = auth.uid());
create policy "Staff/admin read admin notifications" on public.notifications
  for select to authenticated using (audience = 'admin' and public.is_staff_or_admin());

-- Defense in depth on top of "no write policy": strip write privileges.
revoke all on public.orders, public.order_items, public.notifications from anon;
revoke insert, update, delete, truncate on public.orders, public.order_items, public.notifications from authenticated;
revoke all on public.store_products from anon;
grant select on public.store_products to anon;
revoke insert, update, delete, truncate on public.store_products from authenticated;
