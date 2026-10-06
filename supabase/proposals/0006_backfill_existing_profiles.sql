-- ============================================================================
-- PROPOSAL — NOT APPLIED. Part of Phase 2 of the database redesign.
-- ============================================================================
-- The handle_new_user() trigger (0002) only fires on FUTURE auth.users
-- inserts. Any account that already exists today — in practice, right now
-- that's just the admin account(s) you created manually via the Supabase
-- dashboard for the current AdminLogin flow — has no profiles row yet and
-- needs one backfilled once, here.
--
-- Safe to run multiple times (ON CONFLICT DO NOTHING) — will not duplicate
-- or overwrite an existing profile.
-- ============================================================================

-- 1) Give every existing auth.users row a profile (default role='member').
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- 2) Promote the existing admin account to role='admin'.
update public.profiles
set role = 'admin'
where email = 'harshit@gobt.in';

-- Verify before moving on:
-- select id, email, role from public.profiles where role = 'admin';
