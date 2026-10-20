-- Reverts 0030_privacy_foundation.sql.
-- WARNING: this DROPS the consent record, privacy requests and notice versions (they are new data created
-- after 0030). Export them first if any exist. Bookings, credits, memberships, payments and orders are untouched.
begin;

-- Restore register_push_device to its 0026 body (no consent check).
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
    created_at = case when push_devices.user_id = excluded.user_id then push_devices.created_at else now() end,
    user_id = excluded.user_id, platform = excluded.platform, app_version = excluded.app_version,
    updated_at = now(), disabled_at = null, disabled_reason = null;
  update public.push_devices set disabled_at = now(), disabled_reason = 'device_limit'
  where id in (select id from public.push_devices where user_id = v_uid and disabled_at is null order by updated_at desc offset 10);
end;
$$;

drop function if exists public.admin_retention_preview();
drop function if exists public.admin_set_retention_rule(text, int, text, boolean);
drop function if exists public.admin_retention_rules();
drop function if exists public.admin_privacy_audit(int);
drop function if exists public.admin_privacy_overview();
drop function if exists public.admin_list_notices();
drop function if exists public.admin_publish_privacy_notice(text, boolean, date);
drop function if exists public.admin_save_notice_draft(text, text, text, text);
drop function if exists public.admin_set_privacy_config(text, text);
drop function if exists public.admin_privacy_config();
drop function if exists public.admin_update_privacy_request(uuid, text, uuid, text);
drop function if exists public.admin_privacy_request_events(uuid);
drop function if exists public.admin_list_privacy_requests(text, int);
drop function if exists public.admin_export_member_data(uuid);
drop function if exists public.export_my_data();
drop function if exists public._member_data_export(uuid);
drop function if exists public.cancel_my_privacy_request(uuid);
drop function if exists public.my_privacy_requests();
drop function if exists public.submit_privacy_request(text, text, text);
drop function if exists public.my_consents();
drop function if exists public.record_consent(text, text, text, text);
drop function if exists public.current_privacy_notice(text);
drop function if exists public.public_privacy_config();
drop function if exists public._render_notice(text);
drop function if exists public._privacy_missing_keys();
drop function if exists public._latest_consent_action(uuid, text);
drop function if exists public._privacy_cfg(text);
drop table if exists public.retention_rules;
drop table if exists public.privacy_request_events;
drop table if exists public.privacy_requests;
drop table if exists public.consent_events;
drop function if exists public._trg_consent_immutable();
drop table if exists public.privacy_notice_versions;
drop function if exists public._trg_notice_frozen();
drop table if exists public.consent_purposes;
drop table if exists public.privacy_config;

notify pgrst, 'reload schema';
commit;
