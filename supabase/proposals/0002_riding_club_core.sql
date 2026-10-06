-- ============================================================================
-- PROPOSAL — NOT APPLIED. Part of Phase 2 of the database redesign.
-- Do not run this against the live project until explicitly approved.
-- See docs/database-redesign/02-proposed-architecture.md for rationale.
-- ============================================================================
-- Riding club core schema: profiles, membership_plans, memberships, payments,
-- credit_ledger, horses, schedule_templates, class_sessions, bookings,
-- attendance, system_settings, audit_logs.
--
-- Purely additive — does not touch the existing public.enquiries table.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- profiles
-- ----------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  phone text,
  email text,
  avatar_url text,
  -- Source of truth for age-gated plan eligibility (see membership_plans
  -- min_age/max_age and begin_membership_purchase()). Age is always computed
  -- server-side from this column — never trust a client-supplied age.
  date_of_birth date,
  role text not null default 'member' check (role in ('member', 'staff', 'admin')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Application-facing user data, 1:1 with auth.users. Auto-created by handle_new_user() trigger.';

-- ----------------------------------------------------------------------------
-- membership_plans
-- ----------------------------------------------------------------------------
create table public.membership_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  price numeric(10, 2) not null check (price >= 0),
  currency text not null default 'INR',
  class_credits int not null check (class_credits > 0),
  validity_days int not null check (validity_days > 0),
  -- Age-eligibility range this price applies to (inclusive), both nullable
  -- meaning "no bound on this side" — e.g. Junior: min_age null, max_age 11;
  -- Adult: min_age 12, max_age null. Enforced server-side in
  -- begin_membership_purchase() against profiles.date_of_birth.
  min_age int check (min_age >= 0),
  max_age int check (max_age >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint age_range_valid check (min_age is null or max_age is null or max_age >= min_age)
);

-- ----------------------------------------------------------------------------
-- memberships
-- ----------------------------------------------------------------------------
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  plan_id uuid not null references public.membership_plans (id),
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'active', 'expired', 'cancelled', 'suspended')),
  start_date date,
  end_date date,
  payment_id uuid, -- FK added after payments exists (see below)
  -- Cache of SUM(credit_ledger.amount) for this membership. NOT authoritative —
  -- kept in sync by sync_membership_credit_cache() trigger on credit_ledger.
  credits_remaining int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint end_after_start check (end_date is null or start_date is null or end_date >= start_date)
);

-- ----------------------------------------------------------------------------
-- payments
-- ----------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  membership_id uuid not null references public.memberships (id) on delete cascade,
  gateway text not null default 'razorpay',
  gateway_order_id text,
  gateway_payment_id text,
  amount numeric(10, 2) not null check (amount > 0),
  currency text not null default 'INR',
  status text not null default 'created'
    check (status in ('created', 'pending', 'processing', 'success', 'failed', 'expired', 'refunded', 'partially_refunded')),
  paid_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Idempotency backbone: a given gateway identifier can only ever belong to
  -- one payment row. NULLs are allowed to repeat (a row created before the
  -- gateway assigns an id), but once set, it's unique.
  constraint uq_payments_gateway_order_id unique (gateway_order_id),
  constraint uq_payments_gateway_payment_id unique (gateway_payment_id)
);

alter table public.memberships
  add constraint fk_memberships_payment_id foreign key (payment_id) references public.payments (id);

-- ----------------------------------------------------------------------------
-- credit_ledger — append-only
-- ----------------------------------------------------------------------------
create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  membership_id uuid not null references public.memberships (id) on delete cascade,
  booking_id uuid, -- FK added after bookings exists
  amount int not null check (amount <> 0),
  transaction_type text not null
    check (transaction_type in ('membership_purchase', 'booking', 'cancellation', 'admin_adjustment', 'refund', 'expiry')),
  description text,
  created_by uuid references public.profiles (id), -- who performed an admin_adjustment; null = system
  created_at timestamptz not null default now()
);

comment on table public.credit_ledger is
  'Append-only. Never UPDATE or DELETE from the application — corrections are new offsetting rows.';

-- ----------------------------------------------------------------------------
-- horses
-- ----------------------------------------------------------------------------
create table public.horses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  status text not null default 'available'
    check (status in ('available', 'maintenance', 'rest', 'medical', 'retired')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- schedule_templates
-- ----------------------------------------------------------------------------
create table public.schedule_templates (
  id uuid primary key default gen_random_uuid(),
  day_of_week smallint not null check (day_of_week between 0 and 6), -- 0 = Sunday
  start_time time not null,
  end_time time not null,
  capacity int, -- null = derive from active horse count at generation time
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint end_after_start_template check (end_time > start_time)
);

-- ----------------------------------------------------------------------------
-- class_sessions
-- ----------------------------------------------------------------------------
create table public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  start_time time not null,
  end_time time not null,
  capacity int not null check (capacity > 0),
  status text not null default 'open'
    check (status in ('open', 'closed', 'cancelled', 'completed')),
  template_id uuid references public.schedule_templates (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint end_after_start_session check (end_time > start_time),
  constraint uq_session_slot unique (session_date, start_time, end_time)
);

-- ----------------------------------------------------------------------------
-- bookings
-- ----------------------------------------------------------------------------
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  membership_id uuid not null references public.memberships (id),
  session_id uuid not null references public.class_sessions (id),
  horse_id uuid references public.horses (id), -- nullable: capacity reserved before horse assignment
  status text not null default 'held'
    check (status in ('held', 'confirmed', 'cancelled', 'completed', 'no_show', 'expired')),
  booked_at timestamptz not null default now(),
  cancelled_at timestamptz,
  completed_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.credit_ledger
  add constraint fk_credit_ledger_booking_id foreign key (booking_id) references public.bookings (id);

-- The anti-double-booking guarantee at the constraint level: a user can only
-- hold one active (held/confirmed) booking per session at a time. Combined
-- with the row lock in book_class(), this makes double-booking structurally
-- impossible, not just unlikely.
create unique index uq_bookings_active_per_user_session
  on public.bookings (user_id, session_id)
  where status in ('held', 'confirmed');

-- ----------------------------------------------------------------------------
-- attendance
-- ----------------------------------------------------------------------------
create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings (id) on delete cascade,
  status text not null check (status in ('present', 'absent', 'no_show', 'excused')),
  marked_by uuid references public.profiles (id),
  marked_at timestamptz not null default now(),
  notes text
);

-- ----------------------------------------------------------------------------
-- system_settings
-- ----------------------------------------------------------------------------
create table public.system_settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- audit_logs
-- ----------------------------------------------------------------------------
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  record_id uuid not null,
  action text not null,
  performed_by uuid references public.profiles (id),
  old_values jsonb,
  new_values jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- Indexes — matched to the query patterns the app actually needs.
-- ============================================================================

create index ix_memberships_user_id on public.memberships (user_id);
create index ix_memberships_status on public.memberships (status);
create index ix_memberships_end_date on public.memberships (end_date);

create index ix_payments_user_id on public.payments (user_id);
create index ix_payments_status on public.payments (status);
-- gateway_order_id / gateway_payment_id are already indexed via their UNIQUE constraints.

create index ix_credit_ledger_membership_id on public.credit_ledger (membership_id);
create index ix_credit_ledger_user_id on public.credit_ledger (user_id);

create index ix_class_sessions_session_date on public.class_sessions (session_date);
create index ix_class_sessions_status on public.class_sessions (status);

create index ix_bookings_user_id on public.bookings (user_id);
create index ix_bookings_session_id on public.bookings (session_id);
create index ix_bookings_membership_id on public.bookings (membership_id);
create index ix_bookings_status on public.bookings (status);

-- ============================================================================
-- updated_at maintenance — one generic trigger function, reused everywhere.
-- ============================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger trg_membership_plans_updated_at before update on public.membership_plans
  for each row execute function public.set_updated_at();
create trigger trg_memberships_updated_at before update on public.memberships
  for each row execute function public.set_updated_at();
create trigger trg_payments_updated_at before update on public.payments
  for each row execute function public.set_updated_at();
create trigger trg_horses_updated_at before update on public.horses
  for each row execute function public.set_updated_at();
create trigger trg_schedule_templates_updated_at before update on public.schedule_templates
  for each row execute function public.set_updated_at();
create trigger trg_class_sessions_updated_at before update on public.class_sessions
  for each row execute function public.set_updated_at();
create trigger trg_bookings_updated_at before update on public.bookings
  for each row execute function public.set_updated_at();

-- ============================================================================
-- profiles auto-provisioning from auth.users
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger trg_handle_new_user
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- Privilege-escalation guard on profiles (belt-and-braces alongside RLS)
-- ============================================================================

create or replace function public.prevent_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
begin
  if new.role is distinct from old.role or new.status is distinct from old.status then
    select role into v_actor_role from public.profiles where id = auth.uid();
    if v_actor_role is null or v_actor_role not in ('staff', 'admin') then
      raise exception 'Only staff or admin may change role/status';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_prevent_privilege_escalation
  before update on public.profiles
  for each row execute function public.prevent_privilege_escalation();

-- ============================================================================
-- Credit ledger → cached balance on memberships
-- ============================================================================

create or replace function public.sync_membership_credit_cache()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.memberships
  set credits_remaining = (
    select coalesce(sum(amount), 0) from public.credit_ledger where membership_id = coalesce(new.membership_id, old.membership_id)
  )
  where id = coalesce(new.membership_id, old.membership_id);
  return coalesce(new, old);
end;
$$;

create trigger trg_sync_membership_credit_cache
  after insert on public.credit_ledger
  for each row execute function public.sync_membership_credit_cache();

-- ============================================================================
-- Availability view — read-only, display only. Never the source of truth
-- for whether a booking succeeds (book_class() re-checks under lock).
-- ============================================================================

create or replace view public.class_sessions_availability as
select
  s.id as session_id,
  s.session_date,
  s.start_time,
  s.end_time,
  s.capacity,
  s.status,
  count(b.id) filter (where b.status in ('held', 'confirmed')) as booked_count,
  s.capacity - count(b.id) filter (where b.status in ('held', 'confirmed')) as available_slots
from public.class_sessions s
left join public.bookings b on b.session_id = s.id
group by s.id;

-- Explicit, rather than assuming Supabase's default schema privileges cover
-- a newly created VIEW the same way they reliably cover newly created
-- TABLEs. Aggregate counts only (booked_count/available_slots) — exposes no
-- individual booking rows or identities, so this is intentionally readable
-- by anyone regardless of the RLS on the underlying bookings table.
grant select on public.class_sessions_availability to anon, authenticated;
