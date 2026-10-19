-- Phone alerts (push notifications) for the CHR mobile app.
-- Requires 0016–0025. Runs in one transaction; safe to run more than once.
--
--  1. push_devices: one row per phone (Expo push token), owned by the member
--     signed in on it. Members can only read their own; they add and remove
--     them only through register_push_device / unregister_push_device, which
--     take the owner from the session, never from the request.
--  2. push_deliveries: one row per (notification, phone). The unique pair is
--     what stops a notification being pushed twice to the same phone, however
--     often delivery is retried. Server-only (no policies).
--  3. Every member notification written by the existing functions
--     (_notify_user, send_lifecycle_notifications) is handed to the push-send
--     Edge Function by an AFTER INSERT trigger. pg_net only sends the request
--     once the transaction commits, so a booking, payment or activation that
--     rolls back never produces an alert. Nothing about bookings, credits,
--     memberships or payments changes.
--  4. A pg_cron sweep every 5 minutes retries missed or transient sends and
--     checks Expo receipts (removing phones Expo reports as unregistered).
--
-- Push is off until two Vault secrets exist (see the end of this file); until
-- then the trigger does nothing and notifications work exactly as before.
-- A failure to reach push-send never fails the business operation.

begin;

-- pg_net is a Supabase-provided extension (Database > Extensions). Skipped, not failed, if unavailable.
do $$
begin
  create extension if not exists pg_net with schema extensions;
exception when others then
  raise notice 'pg_net unavailable (%); enable it in Database > Extensions and re-run this file.', sqlerrm;
end $$;

-- ─── 1. Devices ─────────────────────────────────────────────────────────────
create table if not exists public.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token text not null unique
    check (token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,}\]$'),
  platform text not null check (platform in ('android', 'ios')),
  app_version text check (char_length(app_version) <= 32),
  -- When this member started owning the token: older notifications are never pushed to it.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_reason text
);
create index if not exists idx_push_devices_user on public.push_devices (user_id) where disabled_at is null;

-- ─── 2. Deliveries ──────────────────────────────────────────────────────────
create table if not exists public.push_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  device_id uuid not null references public.push_devices(id) on delete cascade,
  -- claimed: being sent now · retry: Expo unreachable, will be retried · sent: Expo issued a ticket
  -- receipt_ok: Expo handed it to FCM/APNs (not proof the phone showed it) · failed: gave up, see error
  status text not null default 'claimed' check (status in ('claimed', 'retry', 'sent', 'receipt_ok', 'failed')),
  ticket_id text,
  error text,
  attempts int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_deliveries_once unique (notification_id, device_id)
);
create index if not exists idx_push_deliveries_pending on public.push_deliveries (status, updated_at)
  where status in ('claimed', 'retry', 'sent');

alter table public.push_devices enable row level security;
alter table public.push_deliveries enable row level security;

drop policy if exists "Members read own push devices" on public.push_devices;
create policy "Members read own push devices" on public.push_devices
  for select to authenticated using (user_id = auth.uid());
-- No insert/update/delete policies: writes go through the functions below (and push-send, as service role).
-- push_deliveries has no policies at all: members and staff never read it through the API.

revoke all on public.push_devices from anon;
revoke all on public.push_deliveries from anon, authenticated;
revoke insert, update, delete, truncate on public.push_devices from authenticated;

-- ─── 3. Member functions ────────────────────────────────────────────────────
create or replace function public.register_push_device(p_token text, p_platform text, p_app_version text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_token is null or p_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,}\]$' then raise exception 'INVALID_TOKEN'; end if;
  if p_platform not in ('android', 'ios') then raise exception 'INVALID_PLATFORM'; end if;

  insert into public.push_devices (user_id, token, platform, app_version)
  values (v_uid, p_token, p_platform, left(p_app_version, 32))
  on conflict (token) do update set
    -- A phone belongs to whoever is signed in on it now; a new owner gets none of the previous owner's alerts.
    created_at = case when push_devices.user_id = excluded.user_id then push_devices.created_at else now() end,
    user_id = excluded.user_id,
    platform = excluded.platform,
    app_version = excluded.app_version,
    updated_at = now(),
    disabled_at = null,
    disabled_reason = null;

  -- At most 10 active phones per member: the least recently seen are switched off.
  update public.push_devices set disabled_at = now(), disabled_reason = 'device_limit'
  where id in (
    select id from public.push_devices
    where user_id = v_uid and disabled_at is null
    order by updated_at desc
    offset 10
  );
end;
$$;

create or replace function public.unregister_push_device(p_token text)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_count int;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  delete from public.push_devices where token = p_token and user_id = auth.uid();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.register_push_device(text, text, text) from public, anon;
revoke execute on function public.unregister_push_device(text) from public, anon;
grant execute on function public.register_push_device(text, text, text) to authenticated;
grant execute on function public.unregister_push_device(text) to authenticated;

-- ─── 4. Hand-off to push-send ───────────────────────────────────────────────
-- p_notification_id null = sweep (retries and receipts). Reads the endpoint and
-- shared secret from Vault; does nothing until both exist. Never raises.
create or replace function public._push_dispatch(p_notification_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_url text;
  v_secret text;
begin
  begin
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'push_send_url';
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_send_secret';
    if v_url is null or v_secret is null then return; end if;

    perform net.http_post(
      url := v_url,
      body := case when p_notification_id is null then jsonb_build_object('sweep', true)
                   else jsonb_build_object('notification_id', p_notification_id) end,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret),
      timeout_milliseconds := 10000
    );
  exception when others then
    -- Push is best-effort: the notification (and the booking/payment around it) must still commit.
    raise warning 'push dispatch skipped: %', sqlerrm;
  end;
end;
$$;

create or replace function public._trg_notification_push()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.audience = 'user' then
    perform public._push_dispatch(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_notification_push on public.notifications;
create trigger trg_notification_push after insert on public.notifications
  for each row when (new.audience = 'user') execute function public._trg_notification_push();

revoke execute on function public._push_dispatch(uuid) from public, anon, authenticated;
revoke execute on function public._trg_notification_push() from public, anon, authenticated;

-- ─── 5. Sweep (UTC). Skipped, not failed, if pg_cron is unavailable. ────────
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron unavailable (%); enable it in Database > Extensions and re-run this block.', sqlerrm;
    return;
  end;
  perform cron.schedule('csf-push-sweep', '*/5 * * * *', 'select public._push_dispatch(null)');
end $$;

notify pgrst, 'reload schema';

commit;

-- ─── To switch push on (after deploying push-send), run once — not part of this file: ──
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/push-send', 'push_send_url');
--   select vault.create_secret('<the same random value as the PUSH_SEND_SECRET function secret>', 'push_send_secret');
-- To switch it off again: delete those two rows from vault.secrets.
