-- ============================================================================
-- DPDP hardening (follows 0030 and 0031). PROPOSAL: not applied to any database by this file.
-- Requires 0030, 0031 (and 0025 for enquiries.status, 0026 for push_deliveries).
-- One transaction; safe to run more than once. Additive except where a function is REPLACED
-- (the originals are restored by 0032_privacy_hardening.down.sql).
-- ============================================================================
--
-- Found while auditing the live implementation (19 Oct 2026):
--
--   1. admin_finish_erasure() trusted a boolean from its caller. Any admin could mark an erasure
--      COMPLETED without the login having been disabled. It now reads the real state of the login
--      (auth.users.deleted_at / banned_until) and ignores the boolean's claim.
--   2. Nothing required the requester's identity to be checked before an erasure or before an
--      administrator produced someone's data export. Both now need a recorded identity check, made by
--      an administrator OTHER than the requester (admin_verify_requester_identity).
--   3. A member could file any number of identical open access / consent-withdrawal / nomination
--      requests. At most one open request of each of those types per member is now allowed
--      (a unique index, so two simultaneous submissions cannot both succeed).
--   4. The retention framework covered nine categories and could only PREVIEW. It now covers every
--      category the policy lists, and has an executor (admin_run_retention) that:
--        - is a DRY RUN unless called with p_dry_run => false,
--        - refuses unless the rule is APPROVED, not under legal hold, and the switch
--          privacy_config.retention_cleanup_enabled is 'true' (off by default),
--        - only ever touches five low-risk categories (notifications, switched-off phone-alert codes,
--          delivery logs, answered enquiries, staff attendance notes); payments, audit logs, privacy
--          requests and consent evidence are NEVER deleted automatically,
--        - works in batches of 5000 and is safe to run again (it only matches rows past the period),
--        - writes an audit entry.
--      NOTHING SCHEDULES IT. No cron job is added. Until the owner approves periods and switches it
--      on, no row anywhere is deleted by this file.
--   5. The administrator lists had a row limit but no way to page; they now take an offset. A member's
--      consent history can be read by an administrator (audited).
--
-- Not changed: bookings, credits, memberships, payments, orders, prices, any existing row.
-- The security fixes in 0028 and 0029 are not touched.

begin;

-- ─── 1. Identity check on a privacy request ─────────────────────────────────
alter table public.privacy_requests
  add column if not exists identity_verified_at timestamptz,
  add column if not exists identity_verified_by uuid references public.profiles(id),
  add column if not exists identity_method text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'privacy_requests_identity_method_check') then
    alter table public.privacy_requests add constraint privacy_requests_identity_method_check
      check (identity_method is null or identity_method in ('phone_callback', 'email_confirmation', 'in_person', 'other'));
  end if;
end $$;

-- At most one OPEN request of these types per member (erasure already has its own index in 0030).
create unique index if not exists uq_privacy_one_open_per_type
  on public.privacy_requests (user_id, request_type)
  where request_type in ('access', 'consent_withdrawal', 'nomination')
    and status in ('submitted', 'in_progress', 'awaiting_requester');

create or replace function public.admin_verify_requester_identity(p_request_id uuid, p_method text, p_note text default null)
returns public.privacy_requests language plpgsql security definer set search_path = public as $$
declare
  r public.privacy_requests;
  v_note text := nullif(btrim(p_note), '');
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if p_method is null or p_method not in ('phone_callback', 'email_confirmation', 'in_person', 'other') then raise exception 'INVALID_METHOD'; end if;
  if char_length(coalesce(v_note, '')) > 1000 then raise exception 'TEXT_TOO_LONG'; end if;
  select * into r from public.privacy_requests where id = p_request_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if r.status not in ('submitted', 'in_progress', 'awaiting_requester') then raise exception 'REQUEST_CLOSED'; end if;
  -- Separation of duties: nobody confirms their own request.
  if r.user_id = auth.uid() then raise exception 'CANNOT_VERIFY_OWN_REQUEST'; end if;
  if r.identity_verified_at is not null then return r; end if;  -- already done: nothing changes twice

  update public.privacy_requests set identity_verified_at = now(), identity_verified_by = auth.uid(), identity_method = p_method, updated_at = now()
    where id = p_request_id returning * into r;
  -- The event records HOW it was checked. Do not put identity documents or numbers in the note.
  insert into public.privacy_request_events (request_id, actor_id, actor_role, event, note) values (p_request_id, auth.uid(), 'admin', 'identity_verified', coalesce(v_note, p_method));
  perform public._audit('privacy_requests', p_request_id, 'PRIVACY_IDENTITY_VERIFIED', null, jsonb_build_object('type', r.request_type, 'method', p_method));
  return r;
end $$;

-- ─── 2. The real state of a login (read from the auth schema) ───────────────
-- True when the sign-in cannot be used: the auth row is soft-deleted, banned, or gone.
create or replace function public._login_disabled(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from auth.users u where u.id = p_user)
      or exists (select 1 from auth.users u where u.id = p_user
                 and (u.deleted_at is not null or (u.banned_until is not null and u.banned_until > now())))
$$;

-- ─── 3. Erasure: identity check, and the login is verified, not claimed ─────
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
    'identity_verified', r.identity_verified_at is not null,
    'identity_method', r.identity_method,
    'blockers', v_blockers,
    'can_execute', v_open and v_enabled and p.erased_at is null and r.identity_verified_at is not null
                   and jsonb_array_length(v_blockers) = 0 and (v_hold_until is null or now() >= v_hold_until),
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

  -- Destructive, so the person must have been checked first (by an administrator other than themselves).
  if r.identity_verified_at is null then
    raise exception 'IDENTITY_NOT_VERIFIED' using detail = 'Confirm that the request really comes from the account holder first.';
  end if;
  if v_hold is not null and now() < r.submitted_at + make_interval(days => v_hold) then
    raise exception 'ERASURE_ON_HOLD' using detail = 'The waiting period for erasure has not passed yet.';
  end if;
  v_blockers := public._erasure_blockers(r.user_id);
  if jsonb_array_length(v_blockers) > 0 then
    raise exception 'ERASURE_BLOCKED' using detail = (select string_agg(b ->> 'code', ', ') from jsonb_array_elements(v_blockers) b);
  end if;

  delete from public.push_devices where user_id = r.user_id;
  delete from public.waitlist_entries where user_id = r.user_id;
  delete from public.recurring_occurrences where user_id = r.user_id;
  delete from public.recurring_schedules where user_id = r.user_id;
  delete from public.notifications where user_id = r.user_id;
  delete from public.referral_codes where user_id = r.user_id;

  update public.profiles set full_name = 'Deleted member', phone = null, email = null, date_of_birth = null,
    avatar_url = null, status = 'suspended', erased_at = now() where id = r.user_id;

  insert into public.privacy_request_events (request_id, actor_id, actor_role, event) values (r.id, auth.uid(), 'admin', 'erasure_database_done');
  perform public._audit('profiles', r.user_id, 'ERASURE_DATABASE_DONE', null, jsonb_build_object('request_id', r.id));
  return jsonb_build_object('user_id', r.user_id, 'database_step', 'done');
end $$;

-- The second step. The request is closed ONLY when the database itself shows the login is disabled.
-- p_login_disabled is kept so existing callers keep working; it is advice, not proof.
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

  if not public._login_disabled(r.user_id) then
    insert into public.privacy_request_events (request_id, actor_id, actor_role, event, note)
      values (r.id, auth.uid(), 'admin', 'erasure_login_step_failed', 'The sign-in is not disabled yet; run the step again.');
    perform public._audit('privacy_requests', r.id, 'ERASURE_LOGIN_STEP_FAILED', null, jsonb_build_object('request_id', r.id, 'caller_said_disabled', p_login_disabled is true));
    return jsonb_build_object('completed', false, 'reason', 'login_not_disabled');
  end if;
  if r.status = 'completed' then return jsonb_build_object('completed', true, 'already', true); end if;

  update public.privacy_requests set status = 'completed', resolved_at = now(), updated_at = now(),
    resolution_note = 'Account closed: identifying details removed and sign-in disabled. Records the club must keep were retained.' where id = r.id;
  insert into public.privacy_request_events (request_id, actor_id, actor_role, event, from_status, to_status) values (r.id, auth.uid(), 'admin', 'erasure_completed', r.status, 'completed');
  perform public._audit('privacy_requests', r.id, 'ERASURE_COMPLETED', null, jsonb_build_object('request_id', r.id));
  return jsonb_build_object('completed', true);
end $$;

-- A copy of a member's data may only be produced for an open access request whose requester has been checked.
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
  if r.identity_verified_at is null then
    raise exception 'IDENTITY_NOT_VERIFIED' using detail = 'Confirm that the request really comes from the account holder before producing their data.';
  end if;
  insert into public.privacy_request_events (request_id, actor_id, actor_role, event) values (r.id, auth.uid(), 'admin', 'export_generated');
  perform public._audit('privacy_requests', r.id, 'PRIVACY_EXPORT_GENERATED', null, jsonb_build_object('by', 'admin'));
  return public._member_data_export(r.user_id);
end $$;

-- ─── 4. One open request per type, with a clear message ─────────────────────
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
  if p_type in ('erasure', 'access', 'consent_withdrawal', 'nomination') and exists (
       select 1 from public.privacy_requests where user_id = v_uid and request_type = p_type and status in ('submitted', 'in_progress', 'awaiting_requester')) then
    raise exception 'ALREADY_REQUESTED' using detail = 'You already have an open request of this kind. We will update it in Privacy settings.';
  end if;

  v_days := nullif(public._privacy_cfg('response_target_days'), '')::int;
  begin
    insert into public.privacy_requests (user_id, request_type, subject, details, due_at)
    values (v_uid, p_type, nullif(btrim(p_subject), ''), nullif(btrim(p_details), ''), case when v_days is not null then now() + make_interval(days => v_days) end)
    returning * into v_req;
  exception when unique_violation then
    -- Two submissions at the same moment: the second is a duplicate.
    raise exception 'ALREADY_REQUESTED' using detail = 'You already have an open request of this kind. We will update it in Privacy settings.';
  end;

  insert into public.privacy_request_events (request_id, actor_id, actor_role, event, to_status) values (v_req.id, v_uid, 'member', 'submitted', 'submitted');
  perform public._audit('privacy_requests', v_req.id, 'PRIVACY_REQUEST_SUBMITTED', null, jsonb_build_object('type', p_type));
  v_label := case p_type when 'access' then 'a copy of their data' when 'correction' then 'a correction' when 'erasure' then 'account closure' when 'consent_withdrawal' then 'a consent withdrawal' when 'grievance' then 'a complaint' when 'nomination' then 'a nomination' else 'a privacy question' end;
  perform public._notify_admins('privacy_request', 'New privacy request', 'A member asked for ' || v_label || '.', jsonb_build_object('request_id', v_req.id));
  perform public._notify_user(v_uid, 'privacy_request_update', 'We received your request', 'We will keep you updated in Privacy settings.', jsonb_build_object('request_id', v_req.id));
  return v_req;
end $$;

-- ─── 5. Lists that can be paged, and a member's consent history ─────────────
drop function if exists public.admin_list_privacy_requests(text, int);
create or replace function public.admin_list_privacy_requests(p_status text default null, p_limit int default 100, p_offset int default 0)
returns table (id uuid, user_id uuid, member_name text, member_email text, request_type text, status text, subject text, details text,
  assigned_to uuid, assigned_name text, submitted_at timestamptz, due_at timestamptz, resolved_at timestamptz, resolution_note text, overdue boolean,
  identity_verified_at timestamptz, identity_method text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  return query
    select r.id, r.user_id, p.full_name, p.email, r.request_type, r.status, r.subject, r.details, r.assigned_to, a.full_name,
           r.submitted_at, r.due_at, r.resolved_at, r.resolution_note,
           (r.due_at is not null and r.due_at < now() and r.status in ('submitted', 'in_progress', 'awaiting_requester')),
           r.identity_verified_at, r.identity_method
    from public.privacy_requests r
    join public.profiles p on p.id = r.user_id
    left join public.profiles a on a.id = r.assigned_to
    where p_status is null or r.status = p_status
    order by (r.status in ('submitted', 'in_progress', 'awaiting_requester')) desc, r.submitted_at desc, r.id
    limit least(greatest(p_limit, 1), 500) offset greatest(p_offset, 0);
end $$;

drop function if exists public.admin_privacy_audit(int);
create or replace function public.admin_privacy_audit(p_limit int default 100, p_offset int default 0)
returns table (created_at timestamptz, action text, actor_name text, table_name text, detail jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  return query select a.created_at, a.action, p.full_name, a.table_name, a.new_values
    from public.audit_logs a left join public.profiles p on p.id = a.performed_by
    where a.action like 'PRIVACY\_%' or a.action like 'CONSENT\_%' or a.action like 'NOTICE\_%' or a.action like 'ERASURE\_%'
    order by a.created_at desc, a.id limit least(greatest(p_limit, 1), 500) offset greatest(p_offset, 0);
end $$;

-- One member's consent history (their own answers and the notice version each refers to). Audited.
create or replace function public.admin_member_consents(p_user uuid, p_limit int default 100, p_offset int default 0)
returns table (purpose text, action text, notice_version text, source text, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'USER_NOT_FOUND'; end if;
  perform public._audit('consent_events', p_user, 'PRIVACY_CONSENT_VIEWED', null, jsonb_build_object('by', 'admin'));
  return query select c.purpose, c.action, c.notice_version, c.source, c.created_at
    from public.consent_events c where c.user_id = p_user order by c.seq desc
    limit least(greatest(p_limit, 1), 500) offset greatest(p_offset, 0);
end $$;

-- ─── 6. Retention: every category, a switch, and a careful executor ─────────
alter table public.privacy_config drop constraint if exists privacy_config_key;
alter table public.privacy_config add constraint privacy_config_key check (key in (
  'legal_entity_name', 'registered_address', 'privacy_contact_email', 'privacy_contact_phone',
  'grievance_officer_name', 'grievance_officer_email', 'grievance_officer_phone', 'dpo_designation',
  'retention_summary', 'children_policy_text', 'data_location_statement', 'response_target_days',
  'erasure_finalisation_enabled', 'erasure_hold_days', 'retention_cleanup_enabled'));
insert into public.privacy_config (key, value) values ('retention_cleanup_enabled', 'false') on conflict (key) do nothing;
update public.privacy_config set value = 'false' where key = 'retention_cleanup_enabled' and value is null;

create or replace function public.admin_set_privacy_config(p_key text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v text := nullif(btrim(p_value), '');
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.privacy_config where key = p_key) then raise exception 'UNKNOWN_KEY'; end if;
  if char_length(coalesce(v, '')) > 2000 then raise exception 'TEXT_TOO_LONG'; end if;
  if p_key in ('response_target_days', 'erasure_hold_days') and v is not null and v !~ '^[0-9]{1,4}$' then raise exception 'INVALID_VALUE' using detail = 'Use a whole number of days.'; end if;
  if p_key in ('erasure_finalisation_enabled', 'retention_cleanup_enabled') and v is not null and v not in ('true', 'false') then raise exception 'INVALID_VALUE' using detail = 'Use true or false.'; end if;
  update public.privacy_config set value = v, updated_by = auth.uid(), updated_at = now() where key = p_key;
  perform public._audit('privacy_config', gen_random_uuid(), 'PRIVACY_CONFIG_UPDATED', null, jsonb_build_object('key', p_key, 'is_set', v is not null));
end $$;

-- Every category the policy lists. All UNAPPROVED with no period: inert until the owner decides.
insert into public.retention_rules (category, description) values
  ('member_profiles', 'Profiles of closed accounts (name and contact details are already removed on erasure) and of long-inactive members'),
  ('auth_records', 'Sign-in records held by the authentication provider (identity, last sign-in); handled by the erasure workflow and the provider'),
  ('memberships_credits', 'Memberships, class-credit ledger and referral-wallet ledger (financial and dispute record)'),
  ('bookings_attendance', 'Bookings, attendance and class history'),
  ('push_deliveries', 'The per-phone delivery log of phone alerts'),
  ('uploaded_documents', 'Documents or photos members upload (none are collected today)')
on conflict (category) do nothing;

-- A COUNT only. Matches exactly what admin_run_retention would act on.
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
        when 'push_deliveries' then (select count(*) from public.push_deliveries where created_at < now() - make_interval(days => r.retention_days))
        when 'enquiries' then (select count(*) from public.enquiries e where e.status = 'answered' and e.created_at < now() - make_interval(days => r.retention_days))
        when 'attendance_notes' then (select count(*) from public.attendance where notes is not null and marked_at < now() - make_interval(days => r.retention_days))
        when 'payments_orders' then (select count(*) from public.payments where created_at < now() - make_interval(days => r.retention_days))
        when 'privacy_requests' then (select count(*) from public.privacy_requests pr where pr.status in ('completed', 'rejected', 'cancelled') and pr.submitted_at < now() - make_interval(days => r.retention_days))
        else null end end
    from public.retention_rules r order by r.category;
end $$;

-- The executor. Dry run unless p_dry_run is explicitly false. See the header for every refusal.
create or replace function public.admin_run_retention(p_category text, p_dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.retention_rules;
  v_cutoff timestamptz;
  v_n bigint := 0;
  v_left bigint := 0;
  v_batch constant int := 5000;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  select * into r from public.retention_rules where category = p_category;
  if not found then raise exception 'UNKNOWN_CATEGORY'; end if;
  if p_category not in ('notifications', 'push_devices_disabled', 'push_deliveries', 'enquiries', 'attendance_notes') then
    raise exception 'NOT_AUTOMATED' using detail = 'This category is never deleted automatically. It needs a reviewed, manual decision.';
  end if;
  if r.status <> 'approved' or r.retention_days is null then raise exception 'RULE_NOT_APPROVED'; end if;
  if r.legal_hold then raise exception 'LEGAL_HOLD'; end if;
  v_cutoff := now() - make_interval(days => r.retention_days);

  if p_dry_run is distinct from false then
    v_n := case p_category
      when 'notifications' then (select count(*) from public.notifications where created_at < v_cutoff)
      when 'push_devices_disabled' then (select count(*) from public.push_devices where disabled_at is not null and disabled_at < v_cutoff)
      when 'push_deliveries' then (select count(*) from public.push_deliveries where created_at < v_cutoff)
      when 'enquiries' then (select count(*) from public.enquiries where status = 'answered' and created_at < v_cutoff)
      when 'attendance_notes' then (select count(*) from public.attendance where notes is not null and marked_at < v_cutoff)
    end;
    return jsonb_build_object('category', p_category, 'dry_run', true, 'would_affect', v_n, 'cutoff', v_cutoff);
  end if;

  if coalesce(public._privacy_cfg('retention_cleanup_enabled'), 'false') <> 'true' then
    raise exception 'RETENTION_CLEANUP_DISABLED' using detail = 'Cleanup is switched off until the club approves the retention policy.';
  end if;

  if p_category = 'notifications' then
    -- push_deliveries rows for these notifications go with them (foreign key cascade).
    with d as (select id from public.notifications where created_at < v_cutoff order by created_at, id limit v_batch for update skip locked)
    delete from public.notifications n using d where n.id = d.id;
    get diagnostics v_n = row_count;
    select count(*) into v_left from public.notifications where created_at < v_cutoff;
  elsif p_category = 'push_devices_disabled' then
    with d as (select id from public.push_devices where disabled_at is not null and disabled_at < v_cutoff order by disabled_at, id limit v_batch for update skip locked)
    delete from public.push_devices x using d where x.id = d.id;
    get diagnostics v_n = row_count;
    select count(*) into v_left from public.push_devices where disabled_at is not null and disabled_at < v_cutoff;
  elsif p_category = 'push_deliveries' then
    with d as (select id from public.push_deliveries where created_at < v_cutoff order by created_at, id limit v_batch for update skip locked)
    delete from public.push_deliveries x using d where x.id = d.id;
    get diagnostics v_n = row_count;
    select count(*) into v_left from public.push_deliveries where created_at < v_cutoff;
  elsif p_category = 'enquiries' then
    -- Only enquiries someone has answered; an unanswered one is never removed by a timer.
    with d as (select id from public.enquiries where status = 'answered' and created_at < v_cutoff order by created_at, id limit v_batch for update skip locked)
    delete from public.enquiries x using d where x.id = d.id;
    get diagnostics v_n = row_count;
    select count(*) into v_left from public.enquiries where status = 'answered' and created_at < v_cutoff;
  elsif p_category = 'attendance_notes' then
    -- The note is blanked; the attendance record itself stays.
    with d as (select id from public.attendance where notes is not null and marked_at < v_cutoff order by marked_at, id limit v_batch for update skip locked)
    update public.attendance x set notes = null from d where x.id = d.id;
    get diagnostics v_n = row_count;
    select count(*) into v_left from public.attendance where notes is not null and marked_at < v_cutoff;
  end if;

  perform public._audit('retention_rules', gen_random_uuid(), 'PRIVACY_RETENTION_RUN', null,
    jsonb_build_object('category', p_category, 'rows', v_n, 'more_remaining', v_left > 0, 'cutoff', v_cutoff));
  return jsonb_build_object('category', p_category, 'dry_run', false, 'affected', v_n, 'more_remaining', v_left > 0, 'cutoff', v_cutoff);
end $$;

-- ─── Permissions ────────────────────────────────────────────────────────────
revoke execute on function public._login_disabled(uuid) from public, anon, authenticated;

revoke execute on function public.admin_verify_requester_identity(uuid, text, text), public.admin_erasure_preflight(uuid),
  public.admin_execute_erasure(uuid), public.admin_finish_erasure(uuid, boolean), public.admin_export_member_data(uuid),
  public.submit_privacy_request(text, text, text), public.admin_list_privacy_requests(text, int, int), public.admin_privacy_audit(int, int),
  public.admin_member_consents(uuid, int, int), public.admin_set_privacy_config(text, text), public.admin_retention_preview(),
  public.admin_run_retention(text, boolean) from public, anon;
grant execute on function public.admin_verify_requester_identity(uuid, text, text), public.admin_erasure_preflight(uuid),
  public.admin_execute_erasure(uuid), public.admin_finish_erasure(uuid, boolean), public.admin_export_member_data(uuid),
  public.submit_privacy_request(text, text, text), public.admin_list_privacy_requests(text, int, int), public.admin_privacy_audit(int, int),
  public.admin_member_consents(uuid, int, int), public.admin_set_privacy_config(text, text), public.admin_retention_preview(),
  public.admin_run_retention(text, boolean) to authenticated;

notify pgrst, 'reload schema';

commit;
