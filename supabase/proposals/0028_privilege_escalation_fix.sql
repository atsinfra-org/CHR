-- ============================================================================
-- DPDP Phase 1 — Supabase security audit finding P1-01.
-- PROPOSAL ONLY. NOT applied to the remote database by this change.
-- ============================================================================
--
-- Finding: public.prevent_privilege_escalation() (the BEFORE UPDATE trigger
-- on public.profiles that is supposed to be the only thing stopping a
-- member from granting themselves admin) allows the change whenever the
-- ACTING user's own current role is already 'staff' OR 'admin':
--
--   if v_actor_role is null or v_actor_role not in ('staff', 'admin') then
--     raise exception 'Only staff or admin may change role/status';
--   end if;
--
-- Combined with:
--   - RLS policy "Members update own profile" (`id = auth.uid()`), which
--     places no restriction on which columns may change, and
--   - no column-level GRANT on public.profiles restricting UPDATE to a
--     safe column subset,
-- a 'staff' account can PATCH ITS OWN `role` to 'admin' directly via
-- PostgREST (e.g. `patch /rest/v1/profiles?id=eq.<own id>` with
-- `{"role":"admin"}`), bypassing admin_set_role() entirely — its
-- is_admin()-only check, its REASON_REQUIRED audit trail, and its
-- last-admin-count safeguard never run.
--
-- This is a genuine internal privilege-escalation path (staff -> admin),
-- not merely a UI gap: admin_set_role() (0014_admin_operations.sql) was
-- clearly intended to be the only route to a role change, and already
-- requires is_admin() — this trigger is what's inconsistent with that
-- intent, not the RPC.
--
-- Fix: require the ACTOR to already be 'admin' (not 'staff') before any
-- role/status change is allowed through the trigger at all. This exactly
-- matches admin_set_role()'s own requirement, so every legitimate path
-- (the admin console, calling admin_set_role()) is completely unaffected.
-- The only behaviour removed is the unintended staff-self-promotion path.
--
-- No table, column, booking, payment, or membership logic is touched.
--
-- Verification after applying (expect 0 rows / exception in both cases):
--   -- as a 'staff' JWT, this must now fail with the trigger's exception:
--   update public.profiles set role = 'admin' where id = auth.uid();
--   -- sanity check the function body matches:
--   select prosrc from pg_proc where proname = 'prevent_privilege_escalation';
--
-- Rollback: supabase/proposals/0028_privilege_escalation_fix.down.sql
-- restores the exact previous body (staff OR admin).
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
    -- Only an acting ADMIN may change role/status — matches
    -- admin_set_role()'s own is_admin() requirement exactly, so that RPC
    -- (the only intended path for a role change) is unaffected. A 'staff'
    -- actor no longer qualifies here (see finding P1-01 above).
    if v_actor_role is distinct from 'admin' then
      raise exception 'Only an admin may change role/status';
    end if;
  end if;
  return new;
end;
$$;
