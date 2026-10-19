-- Rollback for 0028_privilege_escalation_fix.sql.
-- Restores the exact prior trigger body (staff OR admin may change
-- role/status). Only use this if the fix itself causes an unexpected
-- regression in a legitimate admin workflow — it reopens finding P1-01.

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
