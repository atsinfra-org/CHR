-- ============================================================================
-- PROPOSAL — NOT APPLIED. Part of Phase 2 of the database redesign.
-- Do not run this against the live project until explicitly approved.
-- ============================================================================
-- RLS for every table created in 0002_riding_club_core.sql.
-- Default-deny: RLS is enabled on every table, and only what's explicitly
-- granted below is permitted. Nothing here touches public.enquiries directly
-- — that's a separate, optional statement at the bottom, clearly marked.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper functions, reused across policies below.
-- ----------------------------------------------------------------------------

create or replace function public.is_staff_or_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('staff', 'admin')
  );
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ----------------------------------------------------------------------------
-- profiles
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;

create policy "Members read own profile" on public.profiles
  for select to authenticated using (id = auth.uid());

create policy "Staff/admin read all profiles" on public.profiles
  for select to authenticated using (public.is_staff_or_admin());

create policy "Members update own profile" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
  -- role/status changes on this row are additionally blocked by the
  -- prevent_privilege_escalation() trigger regardless of this policy.

create policy "Admin updates any profile" on public.profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- membership_plans — public catalog
-- ----------------------------------------------------------------------------
alter table public.membership_plans enable row level security;

create policy "Anyone reads active plans" on public.membership_plans
  for select to anon, authenticated using (is_active = true);

create policy "Staff/admin read all plans" on public.membership_plans
  for select to authenticated using (public.is_staff_or_admin());

create policy "Admin manages plans" on public.membership_plans
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- memberships — no direct client INSERT anywhere; created via RPC/webhook only
-- ----------------------------------------------------------------------------
alter table public.memberships enable row level security;

create policy "Members read own memberships" on public.memberships
  for select to authenticated using (user_id = auth.uid());

create policy "Staff/admin read all memberships" on public.memberships
  for select to authenticated using (public.is_staff_or_admin());

create policy "Staff/admin update memberships" on public.memberships
  for update to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());
  -- Intended for status/date changes (suspend/extend/cancel). Credit changes
  -- should still go through admin_adjust_credits() to keep the ledger
  -- authoritative, even though this policy would technically permit a direct
  -- UPDATE of credits_remaining — documented expectation, not DB-enforced,
  -- because credits_remaining is a cache column recomputed from the ledger
  -- on every credit_ledger insert regardless of what a direct UPDATE sets it to.

-- ----------------------------------------------------------------------------
-- payments — no client INSERT/UPDATE policy at all. Only service_role
-- (the webhook Edge Function) writes here, and service_role bypasses RLS.
-- ----------------------------------------------------------------------------
alter table public.payments enable row level security;

create policy "Members read own payments" on public.payments
  for select to authenticated using (user_id = auth.uid());

create policy "Staff/admin read all payments" on public.payments
  for select to authenticated using (public.is_staff_or_admin());

-- ----------------------------------------------------------------------------
-- credit_ledger — read-only for everyone via RLS; all writes via
-- SECURITY DEFINER RPCs (book_class, cancel_booking, activate_membership,
-- admin_adjust_credits), never a direct client INSERT.
-- ----------------------------------------------------------------------------
alter table public.credit_ledger enable row level security;

create policy "Members read own credit ledger" on public.credit_ledger
  for select to authenticated using (user_id = auth.uid());

create policy "Staff/admin read all credit ledger" on public.credit_ledger
  for select to authenticated using (public.is_staff_or_admin());

-- ----------------------------------------------------------------------------
-- horses
-- ----------------------------------------------------------------------------
alter table public.horses enable row level security;

create policy "Anyone reads active horses" on public.horses
  for select to anon, authenticated using (is_active = true);

create policy "Staff/admin read all horses" on public.horses
  for select to authenticated using (public.is_staff_or_admin());

create policy "Admin manages horses" on public.horses
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "Staff updates horse status" on public.horses
  for update to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());

-- ----------------------------------------------------------------------------
-- schedule_templates — staff/admin only, members don't need direct access
-- ----------------------------------------------------------------------------
alter table public.schedule_templates enable row level security;

create policy "Staff/admin read schedule templates" on public.schedule_templates
  for select to authenticated using (public.is_staff_or_admin());

create policy "Admin manages schedule templates" on public.schedule_templates
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- class_sessions — readable for browsing/booking; writes via admin RPCs/policy
-- ----------------------------------------------------------------------------
alter table public.class_sessions enable row level security;

create policy "Anyone reads sessions" on public.class_sessions
  for select to anon, authenticated using (true);

create policy "Staff/admin manage sessions" on public.class_sessions
  for all to authenticated using (public.is_staff_or_admin()) with check (public.is_staff_or_admin());

-- ----------------------------------------------------------------------------
-- bookings — no client INSERT/UPDATE policy for members. book_class() and
-- cancel_booking() are SECURITY DEFINER and bypass RLS internally after
-- doing their own auth.uid() checks. Admin manual actions go through their
-- own privileged RPCs (admin_create_booking, admin_reassign_horse) for the
-- same capacity-safety reason — not a raw table policy.
-- ----------------------------------------------------------------------------
alter table public.bookings enable row level security;

create policy "Members read own bookings" on public.bookings
  for select to authenticated using (user_id = auth.uid());

create policy "Staff/admin read all bookings" on public.bookings
  for select to authenticated using (public.is_staff_or_admin());

create policy "Staff/admin update bookings" on public.bookings
  for update to authenticated
  using (public.is_staff_or_admin())
  with check (public.is_staff_or_admin());
  -- Covers reschedule / horse (re)assignment / status correction by staff.
  -- Does NOT cover creating new bookings (no INSERT policy here on purpose).

-- ----------------------------------------------------------------------------
-- attendance
-- ----------------------------------------------------------------------------
alter table public.attendance enable row level security;

create policy "Members read own attendance" on public.attendance
  for select to authenticated
  using (exists (select 1 from public.bookings b where b.id = booking_id and b.user_id = auth.uid()));

create policy "Staff/admin manage attendance" on public.attendance
  for all to authenticated using (public.is_staff_or_admin()) with check (public.is_staff_or_admin());

-- ----------------------------------------------------------------------------
-- system_settings
-- ----------------------------------------------------------------------------
alter table public.system_settings enable row level security;

create policy "Anyone reads settings" on public.system_settings
  for select to anon, authenticated using (true);

create policy "Admin updates settings" on public.system_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- audit_logs — admin read only; written exclusively by SECURITY DEFINER code
-- ----------------------------------------------------------------------------
alter table public.audit_logs enable row level security;

create policy "Admin reads audit logs" on public.audit_logs
  for select to authenticated using (public.is_admin());

-- ============================================================================
-- APPROVED — existing public.enquiries policy tightening.
-- Policy REPLACE only — does not touch any existing row of enquiry data.
-- Confirmed scope: admin only (not staff) may read/delete enquiries.
-- ============================================================================

drop policy if exists "Authenticated users can read enquiries" on public.enquiries;
create policy "Admin reads enquiries" on public.enquiries
  for select to authenticated using (public.is_admin());

drop policy if exists "Authenticated users can delete enquiries" on public.enquiries;
create policy "Admin deletes enquiries" on public.enquiries
  for delete to authenticated using (public.is_admin());
