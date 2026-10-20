-- Rolls back 0032_privacy_hardening.sql: restores the exact function definitions from 0030 and 0031,
-- removes what 0032 added, and leaves everything else alone. One transaction; safe to run more than once.
--
-- What is NOT undone, on purpose:
--   * privacy_requests.identity_verified_at / identity_verified_by / identity_method stay. They are the record
--     of who checked a requester and how; dropping them would destroy that evidence. If you really want them
--     gone:  alter table public.privacy_requests drop column identity_verified_at, drop column identity_verified_by,
--            drop column identity_method;
--   * Any row 0032 caused to be deleted by admin_run_retention. Nothing is deleted by 0032 itself, and the
--     executor only runs when an administrator calls it with p_dry_run => false after approving a period.
--   * Audit entries written by the new functions.
-- After this rollback an erasure no longer needs an identity check and admin_finish_erasure trusts its caller
-- again (the weakness 0032 fixed). Do not leave it rolled back on a live system.

begin;

-- 1. Remove what 0032 added.
drop function if exists public.admin_run_retention(text, boolean);
drop function if exists public.admin_member_consents(uuid, int, int);
drop function if exists public.admin_verify_requester_identity(uuid, text, text);
drop function if exists public._login_disabled(uuid);
drop function if exists public.admin_list_privacy_requests(text, int, int);
drop function if exists public.admin_privacy_audit(int, int);
drop index if exists public.uq_privacy_one_open_per_type;

-- The six categories 0032 added, only if nobody has approved a period for them.
delete from public.retention_rules
  where category in ('member_profiles', 'auth_records', 'memberships_credits', 'bookings_attendance', 'push_deliveries', 'uploaded_documents')
    and status = 'unapproved';

delete from public.privacy_config where key = 'retention_cleanup_enabled';
alter table public.privacy_config drop constraint if exists privacy_config_key;
alter table public.privacy_config add constraint privacy_config_key check (key in (
  'legal_entity_name', 'registered_address', 'privacy_contact_email', 'privacy_contact_phone',
  'grievance_officer_name', 'grievance_officer_email', 'grievance_officer_phone', 'dpo_designation',
  'retention_summary', 'children_policy_text', 'data_location_statement', 'response_target_days',
  'erasure_finalisation_enabled', 'erasure_hold_days'));

-- 2. Restore the original definitions (copied from 0030 and 0031).
create or replace function public.submit_privacy_request(p_type text, p_subject text default null, p_details text default null)
returns public.privacy_requests language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_req public.privacy_requests;
  v_days int;
  v_label text;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_type not in ('access', 'correction', 'erasure', 'consent_withdrawal', 'grievance', 'nomination', 'other') then raise exception 'INVALID_TYPE'; end if;
  if char_length(coalesce(p_subject, '')) > 120 or char_length(coalesce(p_details, '')) > 2000 then raise exception 'TEXT_TOO_LONG'; end if;
  if p_type in ('grievance', 'correction', 'nomination', 'other') and nullif(btrim(coalesce(p_details, '')), '') is null then
    raise exception 'DETAILS_REQUIRED' using detail = 'Please tell us what this is about.';
  end if;

  select role into v_role from public.profiles where id = v_uid;
  if p_type = 'erasure' and v_role in ('staff', 'admin') then
    raise exception 'PRIVILEGED_ACCOUNT' using detail = 'Staff and admin accounts are closed by the club administrator.';
  end if;
  if (select count(*) from public.privacy_requests where user_id = v_uid and status in ('submitted', 'in_progress', 'awaiting_requester')) >= 10 then
    raise exception 'TOO_MANY_OPEN_REQUESTS';
  end if;
  if p_type = 'erasure' and exists (select 1 from public.privacy_requests where user_id = v_uid and request_type = 'erasure' and status in ('submitted', 'in_progress', 'awaiting_requester')) then
    raise exception 'ALREADY_REQUESTED' using detail = 'You already have an open request to close your account.';
  end if;

  v_days := nullif(public._privacy_cfg('response_target_days'), '')::int;
  insert into public.privacy_requests (user_id, request_type, subject, details, due_at)
  values (v_uid, p_type, nullif(btrim(p_subject), ''), nullif(btrim(p_details), ''), case when v_days is not null then now() + make_interval(days => v_days) end)
  returning * into v_req;

  insert into public.privacy_request_events (request_id, actor_id, actor_role, event, to_status) values (v_req.id, v_uid, 'member', 'submitted', 'submitted');
  perform public._audit('privacy_requests', v_req.id, 'PRIVACY_REQUEST_SUBMITTED', null, jsonb_build_object('type', p_type));
  v_label := case p_type when 'access' then 'a copy of their data' when 'correction' then 'a correction' when 'erasure' then 'account closure' when 'consent_withdrawal' then 'a consent withdrawal' when 'grievance' then 'a complaint' when 'nomination' then 'a nomination' else 'a privacy question' end;
  perform public._notify_admins('privacy_request', 'New privacy request', 'A member asked for ' || v_label || '.', jsonb_build_object('request_id', v_req.id));
  perform public._notify_user(v_uid, 'privacy_request_update', 'We received your request', 'We will keep you updated in Privacy settings.', jsonb_build_object('request_id', v_req.id));
  return v_req;
end $$;

create or replace function public.admin_export_member_data(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.privacy_requests;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  select * into r from public.privacy_requests where id = p_request_id;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if r.request_type <> 'access' or r.status not in ('submitted', 'in_progress', 'awaiting_requester') then
    raise exception 'NOT_AN_OPEN_ACCESS_REQUEST' using detail = 'A copy can only be produced for an open request to access data.';
  end if;
  insert into public.privacy_request_events (request_id, actor_id, actor_role, event) values (r.id, auth.uid(), 'admin', 'export_generated');
  perform public._audit('privacy_requests', r.id, 'PRIVACY_EXPORT_GENERATED', null, jsonb_build_object('by', 'admin'));
  return public._member_data_export(r.user_id);
end $$;

create or replace function public.admin_list_privacy_requests(p_status text default null, p_limit int default 100)
returns table (id uuid, user_id uuid, member_name text, member_email text, request_type text, status text, subject text, details text,
  assigned_to uuid, assigned_name text, submitted_at timestamptz, due_at timestamptz, resolved_at timestamptz, resolution_note text, overdue boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  return query
    select r.id, r.user_id, p.full_name, p.email, r.request_type, r.status, r.subject, r.details, r.assigned_to, a.full_name,
           r.submitted_at, r.due_at, r.resolved_at, r.resolution_note,
           (r.due_at is not null and r.due_at < now() and r.status in ('submitted', 'in_progress', 'awaiting_requester'))
    from public.privacy_requests r
    join public.profiles p on p.id = r.user_id
    left join public.profiles a on a.id = r.assigned_to
    where p_status is null or r.status = p_status
    order by (r.status in ('submitted', 'in_progress', 'awaiting_requester')) desc, r.submitted_at desc
    limit least(greatest(p_limit, 1), 500);
end $$;

create or replace function public.admin_privacy_audit(p_limit int default 100)
returns table (created_at timestamptz, action text, actor_name text, table_name text, detail jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  return query select a.created_at, a.action, p.full_name, a.table_name, a.new_values
    from public.audit_logs a left join public.profiles p on p.id = a.performed_by
    where a.action like 'PRIVACY\_%' or a.action like 'CONSENT\_%' or a.action like 'NOTICE\_%' or a.action like 'ERASURE\_%'
    order by a.created_at desc limit least(greatest(p_limit, 1), 500);
end $$;

create or replace function public.admin_set_privacy_config(p_key text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v text := nullif(btrim(p_value), '');
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.privacy_config where key = p_key) then raise exception 'UNKNOWN_KEY'; end if;
  if char_length(coalesce(v, '')) > 2000 then raise exception 'TEXT_TOO_LONG'; end if;
  if p_key in ('response_target_days', 'erasure_hold_days') and v is not null and v !~ '^[0-9]{1,4}$' then raise exception 'INVALID_VALUE' using detail = 'Use a whole number of days.'; end if;
  if p_key = 'erasure_finalisation_enabled' and v is not null and v not in ('true', 'false') then raise exception 'INVALID_VALUE' using detail = 'Use true or false.'; end if;
  update public.privacy_config set value = v, updated_by = auth.uid(), updated_at = now() where key = p_key;
  -- The log records which setting changed, not its value.
  perform public._audit('privacy_config', gen_random_uuid(), 'PRIVACY_CONFIG_UPDATED', null, jsonb_build_object('key', p_key, 'is_set', v is not null));
end $$;

create or replace function public.admin_retention_preview()
returns table (category text, status text, retention_days int, rows_past_period bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  return query
    select r.category, r.status, r.retention_days,
      case when r.status <> 'approved' or r.legal_hold then null else case r.category
        when 'notifications' then (select count(*) from public.notifications where created_at < now() - make_interval(days => r.retention_days))
        when 'payment_webhook_events' then (select count(*) from public.payment_webhook_events where created_at < now() - make_interval(days => r.retention_days))
        when 'audit_logs' then (select count(*) from public.audit_logs where created_at < now() - make_interval(days => r.retention_days))
        when 'push_devices_disabled' then (select count(*) from public.push_devices where disabled_at is not null and disabled_at < now() - make_interval(days => r.retention_days))
        when 'enquiries' then (select count(*) from public.enquiries where created_at < now() - make_interval(days => r.retention_days))
        when 'attendance_notes' then (select count(*) from public.attendance where notes is not null and marked_at < now() - make_interval(days => r.retention_days))
        when 'payments_orders' then (select count(*) from public.payments where created_at < now() - make_interval(days => r.retention_days))
        when 'privacy_requests' then (select count(*) from public.privacy_requests pr where pr.status in ('completed', 'rejected', 'cancelled') and pr.submitted_at < now() - make_interval(days => r.retention_days))
        else null end end
    from public.retention_rules r order by r.category;
end $$;

create or replace function public.admin_erasure_preflight(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.privacy_requests;
  p public.profiles;
  v_blockers jsonb;
  v_enabled boolean := coalesce(public._privacy_cfg('erasure_finalisation_enabled'), 'false') = 'true';
  v_hold int := nullif(public._privacy_cfg('erasure_hold_days'), '')::int;
  v_hold_until timestamptz;
  v_open boolean;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  select * into r from public.privacy_requests where id = p_request_id;
  if not found or r.request_type <> 'erasure' then raise exception 'REQUEST_NOT_FOUND'; end if;
  select * into p from public.profiles where id = r.user_id;
  v_blockers := public._erasure_blockers(r.user_id);
  v_hold_until := case when v_hold is not null then r.submitted_at + make_interval(days => v_hold) end;
  v_open := r.status in ('submitted', 'in_progress', 'awaiting_requester');

  insert into public.privacy_request_events (request_id, actor_id, actor_role, event) values (r.id, auth.uid(), 'admin', 'erasure_preflight');
  perform public._audit('privacy_requests', r.id, 'ERASURE_PREFLIGHT', null, jsonb_build_object('blockers', jsonb_array_length(v_blockers)));

  return jsonb_build_object(
    'request_id', r.id, 'request_status', r.status, 'already_erased', p.erased_at is not null,
    'finalisation_enabled', v_enabled, 'hold_until', v_hold_until,
    'hold_elapsed', v_hold_until is null or now() >= v_hold_until,
    'blockers', v_blockers,
    'can_execute', v_open and v_enabled and p.erased_at is null and jsonb_array_length(v_blockers) = 0 and (v_hold_until is null or now() >= v_hold_until),
    'will_remove', jsonb_build_array('name, email, phone, date of birth, photo link on the profile', 'phone-alert codes', 'waitlist entries', 'weekly schedules', 'in-app notifications', 'referral code', 'the login (disabled)'),
    'will_keep', jsonb_build_object(
      'payments', (select count(*) from public.payments where user_id = r.user_id),
      'orders', (select count(*) from public.orders where user_id = r.user_id),
      'memberships', (select count(*) from public.memberships where user_id = r.user_id),
      'credit_ledger_rows', (select count(*) from public.credit_ledger where user_id = r.user_id),
      'bookings', (select count(*) from public.bookings where user_id = r.user_id),
      'consent_records', (select count(*) from public.consent_events where user_id = r.user_id)),
    'not_handled_here', jsonb_build_array(
      'Enquiries sent with this email address (' || (select count(*) from public.enquiries where p.email is not null and lower(email) = lower(p.email)) || ' found) are not linked to the account.',
      'Copies inside staff audit-log snapshots are kept by design.',
      'Data held by service providers (payments, email, phone alerts, sign-in) is outside this database.'));
end $$;

create or replace function public.admin_execute_erasure(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.privacy_requests;
  p public.profiles;
  v_hold int := nullif(public._privacy_cfg('erasure_hold_days'), '')::int;
  v_blockers jsonb;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if coalesce(public._privacy_cfg('erasure_finalisation_enabled'), 'false') <> 'true' then
    raise exception 'ERASURE_DISABLED' using detail = 'Account erasure is switched off until the club approves the rules for it.';
  end if;
  select * into r from public.privacy_requests where id = p_request_id for update;
  if not found or r.request_type <> 'erasure' then raise exception 'REQUEST_NOT_FOUND'; end if;
  if r.status <> 'in_progress' then raise exception 'REQUEST_NOT_IN_PROGRESS' using detail = 'Review the request and move it to "in progress" first.'; end if;
  select * into p from public.profiles where id = r.user_id for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;

  -- Already done (a retry after the login step failed): report, do nothing twice.
  if p.erased_at is not null then
    return jsonb_build_object('user_id', r.user_id, 'database_step', 'already_done');
  end if;

  if v_hold is not null and now() < r.submitted_at + make_interval(days => v_hold) then
    raise exception 'ERASURE_ON_HOLD' using detail = 'The waiting period for erasure has not passed yet.';
  end if;
  v_blockers := public._erasure_blockers(r.user_id);
  if jsonb_array_length(v_blockers) > 0 then
    raise exception 'ERASURE_BLOCKED' using detail = (select string_agg(b ->> 'code', ', ') from jsonb_array_elements(v_blockers) b);
  end if;

  -- What has no record-keeping value is deleted.
  delete from public.push_devices where user_id = r.user_id;            -- push_deliveries go with them
  delete from public.waitlist_entries where user_id = r.user_id;
  delete from public.recurring_occurrences where user_id = r.user_id;
  delete from public.recurring_schedules where user_id = r.user_id;      -- slots go with them
  delete from public.notifications where user_id = r.user_id;
  delete from public.referral_codes where user_id = r.user_id;

  -- The profile row stays (every ledger links to it); only the identifying columns are blanked.
  update public.profiles set full_name = 'Deleted member', phone = null, email = null, date_of_birth = null,
    avatar_url = null, status = 'suspended', erased_at = now() where id = r.user_id;

  insert into public.privacy_request_events (request_id, actor_id, actor_role, event) values (r.id, auth.uid(), 'admin', 'erasure_database_done');
  perform public._audit('profiles', r.user_id, 'ERASURE_DATABASE_DONE', null, jsonb_build_object('request_id', r.id));
  return jsonb_build_object('user_id', r.user_id, 'database_step', 'done');
end $$;

create or replace function public.admin_finish_erasure(p_request_id uuid, p_login_disabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.privacy_requests;
  p public.profiles;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  select * into r from public.privacy_requests where id = p_request_id for update;
  if not found or r.request_type <> 'erasure' then raise exception 'REQUEST_NOT_FOUND'; end if;
  select * into p from public.profiles where id = r.user_id;
  if p.erased_at is null then raise exception 'DATABASE_STEP_NOT_DONE'; end if;

  if p_login_disabled is not true then
    insert into public.privacy_request_events (request_id, actor_id, actor_role, event, note) values (r.id, auth.uid(), 'admin', 'erasure_login_step_failed', 'The login could not be disabled; run the step again.');
    perform public._audit('privacy_requests', r.id, 'ERASURE_LOGIN_STEP_FAILED', null, jsonb_build_object('request_id', r.id));
    return jsonb_build_object('completed', false, 'reason', 'login_step_failed');
  end if;
  if r.status = 'completed' then return jsonb_build_object('completed', true, 'already', true); end if;

  update public.privacy_requests set status = 'completed', resolved_at = now(), updated_at = now(),
    resolution_note = 'Account closed: identifying details removed and sign-in disabled. Records the club must keep were retained.' where id = r.id;
  insert into public.privacy_request_events (request_id, actor_id, actor_role, event, from_status, to_status) values (r.id, auth.uid(), 'admin', 'erasure_completed', r.status, 'completed');
  perform public._audit('privacy_requests', r.id, 'ERASURE_COMPLETED', null, jsonb_build_object('request_id', r.id));
  return jsonb_build_object('completed', true);
end $$;

-- 3. Permissions, as they were.
revoke execute on function public.submit_privacy_request(text, text, text), public.admin_export_member_data(uuid),
  public.admin_list_privacy_requests(text, int), public.admin_privacy_audit(int), public.admin_set_privacy_config(text, text),
  public.admin_retention_preview(), public.admin_erasure_preflight(uuid), public.admin_execute_erasure(uuid),
  public.admin_finish_erasure(uuid, boolean) from public, anon;
grant execute on function public.submit_privacy_request(text, text, text), public.admin_export_member_data(uuid),
  public.admin_list_privacy_requests(text, int), public.admin_privacy_audit(int), public.admin_set_privacy_config(text, text),
  public.admin_retention_preview(), public.admin_erasure_preflight(uuid), public.admin_execute_erasure(uuid),
  public.admin_finish_erasure(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';

commit;
