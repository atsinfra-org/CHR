-- Switches phone alerts ON, after 0026_push_devices.sql has run and push-send is deployed.
-- TEMPLATE: replace <PUSH_SEND_SECRET value> with the exact value of the PUSH_SEND_SECRET
-- function secret, in the SQL Editor only. Never save the filled-in copy in this repo.
--
-- Changes: creates (or replaces) two Vault secrets read by public._push_dispatch():
--   push_send_url    – where the database posts new member notifications
--   push_send_secret – sent as the x-push-secret header; push-send rejects anything else
-- No tables, functions, policies or business data change.
--
-- Switch off again:  delete from vault.secrets where name in ('push_send_url', 'push_send_secret');

do $$
declare
  v_url constant text := 'https://scmisanphmmtemfaqzqa.supabase.co/functions/v1/push-send';
  v_secret constant text := '<PUSH_SEND_SECRET value>';
  v_id uuid;
begin
  if v_secret like '<%' or length(v_secret) < 32 then
    raise exception 'Fill in the PUSH_SEND_SECRET value first (at least 32 characters).';
  end if;

  select id into v_id from vault.secrets where name = 'push_send_url';
  if v_id is null then perform vault.create_secret(v_url, 'push_send_url');
  else perform vault.update_secret(v_id, v_url); end if;

  v_id := null;
  select id into v_id from vault.secrets where name = 'push_send_secret';
  if v_id is null then perform vault.create_secret(v_secret, 'push_send_secret');
  else perform vault.update_secret(v_id, v_secret); end if;
end $$;

-- Check (shows names only, never values):
select name, updated_at from vault.secrets where name in ('push_send_url', 'push_send_secret');
