-- Rollback for 0022. Restores the STRUCTURE only: the deleted horse rows are
-- not kept anywhere, so the list comes back empty and must be re-entered.
begin;

create table if not exists public.horses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  status text not null default 'available'
    check (status in ('available', 'maintenance', 'rest', 'medical', 'retired')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.horses enable row level security;
create policy "Anyone reads active horses" on public.horses for select to anon, authenticated using (is_active = true);
create policy "Staff/admin read all horses" on public.horses for select to authenticated using (public.is_staff_or_admin());
create policy "Admin manages horses" on public.horses for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "Staff updates horse status" on public.horses for update to authenticated using (public.is_staff_or_admin()) with check (public.is_staff_or_admin());

alter table public.bookings add column if not exists horse_id uuid references public.horses (id);
create unique index if not exists uq_bookings_active_horse_per_session
  on public.bookings (session_id, horse_id)
  where horse_id is not null and status in ('held', 'confirmed');

drop function if exists public.admin_set_session_capacity(uuid, integer);

commit;

-- Then re-run these "create or replace function" blocks, in this order, to bring
-- the horse-based behaviour back:
--   0004_riding_club_functions.sql   generate_sessions
--   0014_admin_operations.sql        admin_create_horse, admin_set_horse_status
--   0015_dashboard_aggregations.sql  admin_dashboard_metrics   (drop the 0022 version first)
--   0017_store_credit_functions.sql  session_horse_availability, reschedule_booking, admin_session_roster
--                                    (drop the 0022 versions of the last two first)
--   0018_phase6_operations.sql       generate_future_sessions, send_lifecycle_notifications, admin_update_setting
--   0021_booking_without_horse_choice.sql   (whole file; drop book_class(uuid) first)
