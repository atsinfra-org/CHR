-- ============================================================================
-- DPDP Phase 1 — Supabase security audit finding P3-01 (lint hygiene).
-- PROPOSAL ONLY. NOT applied to the remote database by this change.
-- ============================================================================
--
-- Finding (Supabase advisor, WARN, function_search_path_mutable):
-- public._int_in_range(jsonb, int, int) has no `set search_path`, unlike
-- every other function in this project. It is a pure, argument-only
-- predicate (no schema-qualified table access beyond none at all), so the
-- practical risk is minimal — but there is no reason for it to be the one
-- exception to the project's own established convention, and closing it
-- costs nothing.
--
-- No behaviour change: identical body, `set search_path = public` added.
--
-- Verification after applying:
--   select p.proname, p.proconfig from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = '_int_in_range';
--   -- expect proconfig to include 'search_path=public'
--
-- Rollback: supabase/proposals/0029_search_path_hardening.down.sql.
-- ============================================================================

create or replace function public._int_in_range(p jsonb, p_lo int, p_hi int)
returns boolean
language sql
immutable
set search_path = public
as $$
  select jsonb_typeof(p) = 'number' and (p #>> '{}') ~ '^[0-9]{1,6}$'
         and (p #>> '{}')::int between p_lo and p_hi;
$$;
