-- Rollback for 0029_search_path_hardening.sql. Restores the function
-- without an explicit search_path (reopens the WARN-level lint finding;
-- no functional impact either way).

create or replace function public._int_in_range(p jsonb, p_lo int, p_hi int)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(p) = 'number' and (p #>> '{}') ~ '^[0-9]{1,6}$'
         and (p #>> '{}')::int between p_lo and p_hi;
$$;
