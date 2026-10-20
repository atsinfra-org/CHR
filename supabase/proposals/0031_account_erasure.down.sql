-- Reverts 0031_account_erasure.sql. It does NOT restore any profile that was already anonymised
-- (erased details cannot be recovered) and it keeps profiles.erased_at as the record of who was erased.
begin;
drop function if exists public.admin_finish_erasure(uuid, boolean);
drop function if exists public.admin_execute_erasure(uuid);
drop function if exists public.admin_erasure_preflight(uuid);
drop function if exists public._erasure_blockers(uuid);
notify pgrst, 'reload schema';
commit;
