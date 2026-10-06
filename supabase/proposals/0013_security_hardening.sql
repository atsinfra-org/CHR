-- ============================================================================
-- Phase 4.6 — Objective B: production security hardening.
-- Applied to production via Supabase MCP. Every change verified live after.
-- ============================================================================
-- Live audit findings addressed here:
--
--  1. DEFAULT PRIVILEGES footgun (root cause of every recurring "anon
--     regained EXECUTE after CREATE OR REPLACE" incident since Phase 4.3):
--     pg_default_acl shows FOR ROLE postgres IN SCHEMA public granting
--     EXECUTE ON FUNCTIONS to anon + authenticated, plus PostgreSQL's
--     built-in EXECUTE-to-PUBLIC default. Every migration in this project
--     runs as `postgres`, so every new function was auto-exposed. Fixed by
--     revoking those defaults so future functions fail CLOSED — they get
--     no client EXECUTE unless a migration explicitly grants it.
--     (supabase_admin's own default-ACL entry is left alone: migrations
--     never run as supabase_admin, and altering another role's defaults
--     needs to BE that role.)
--
--  2. `class_sessions_availability` — Supabase advisor 0010
--     (security_definer_view, ERROR). The view intentionally bypasses
--     `bookings` RLS to aggregate booked_count across ALL members. Rather
--     than keep a flagged view, its single consumer `available_sessions()`
--     is rebuilt as an explicit SECURITY DEFINER function returning only
--     aggregate columns (no user_id / booking id / identity ever), and the
--     view is dropped. Same behaviour, smaller surface, advisor clears.
--
--  3. `set_updated_at()` — advisor 0011 (function_search_path_mutable).
--     SECURITY INVOKER trigger fn, only calls now(); `SET search_path = ''`
--     (pg_catalog is always implicitly present) removes the object-shadow
--     vector and clears the advisor.
--
--  4. Six SECURITY DEFINER functions executable by anon (advisor 0028):
--       - handle_new_user, prevent_privilege_escalation,
--         sync_membership_credit_cache, rls_auto_enable
--         -> trigger / event-trigger functions ONLY. Direct RPC invocation
--            errors ("record NEW not assigned" / "can only be called as
--            trigger"). Trigger firing is NOT gated by EXECUTE grants
--            (verified empirically in the Phase 4.6 report). Revoked from
--            PUBLIC, anon, authenticated.
--       - is_admin, is_staff_or_admin
--         -> referenced by RLS policies for the `authenticated` role, which
--            DOES need EXECUTE for those policies to evaluate. Revoked from
--            PUBLIC and anon only; `authenticated` retained (verified).
--
--  5. `system_settings` "Anyone reads settings" — nothing anon-facing
--     reads system_settings (only EnquiryModal touches Supabase on the
--     public site, and only to INSERT an enquiry). The row set contains
--     operational policy internals (cancellation cutoff, booking window,
--     block config). Tightened to `authenticated` only; the SECURITY
--     INVOKER helpers that read it (member_current_block_usage,
--     member_booking_eligibility) run as authenticated members.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Fail-closed default privileges for future functions.
--    The schema-scoped REVOKE clears the Supabase-added anon/authenticated
--    grants; the GLOBAL (no-schema) REVOKE FROM PUBLIC is also required
--    because PostgreSQL's built-in "EXECUTE to PUBLIC" default for new
--    functions is global, not schema-scoped. Verified live: a throwaway
--    `CREATE FUNCTION` afterwards has ACL {postgres, service_role} only —
--    has_function_privilege('anon'|'authenticated', ...) = false.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;
alter default privileges for role postgres
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- 2. Replace the SECURITY DEFINER view with a SECURITY DEFINER function
-- ---------------------------------------------------------------------------
drop function if exists public.available_sessions(date);
drop view if exists public.class_sessions_availability;

create function public.available_sessions(p_date date)
returns table (
  session_id uuid,
  session_date date,
  start_time time,
  end_time time,
  capacity int,
  status text,
  booked_count bigint,
  available_slots bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id,
    s.session_date,
    s.start_time,
    s.end_time,
    s.capacity,
    s.status,
    count(b.id) filter (where b.status in ('held', 'confirmed')) as booked_count,
    s.capacity - count(b.id) filter (where b.status in ('held', 'confirmed')) as available_slots
  from public.class_sessions s
  left join public.bookings b on b.session_id = s.id
  where s.session_date = p_date
  group by s.id
  order by s.start_time;
$$;

comment on function public.available_sessions(date) is
  'Public session-availability browse. SECURITY DEFINER so booked_count is a correct total across all members'' bookings; returns ONLY aggregate columns — never user_id, booking id, or any member identity.';

revoke all on function public.available_sessions(date) from public;
grant execute on function public.available_sessions(date) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. set_updated_at search_path
-- ---------------------------------------------------------------------------
alter function public.set_updated_at() set search_path = '';
revoke all on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Least-privilege the trigger / helper functions
-- ---------------------------------------------------------------------------
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.prevent_privilege_escalation() from public, anon, authenticated;
revoke all on function public.sync_membership_credit_cache() from public, anon, authenticated;
revoke all on function public.rls_auto_enable() from public, anon, authenticated;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
revoke all on function public.is_staff_or_admin() from public, anon;
grant execute on function public.is_staff_or_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. system_settings: authenticated-only read
-- ---------------------------------------------------------------------------
drop policy if exists "Anyone reads settings" on public.system_settings;
create policy "Authenticated reads settings" on public.system_settings
  for select to authenticated using (true);
