-- ============================================================================
-- DPDP foundation: privacy notice, consent records, privacy requests,
-- personal-data export, retention rules (inert), push-consent propagation.
-- Requires 0016–0027 (and, for the security fixes, 0028–0029). One transaction;
-- safe to run more than once. PROPOSAL: not applied to any database by this file.
-- ============================================================================
--
-- What this adds (and nothing else):
--   1. privacy_config            who the club is and who to contact (owner-supplied; empty by default)
--   2. consent_purposes          the purposes a member can be asked about
--   3. privacy_notice_versions   a versioned notice; a DRAFT is seeded, never published here
--   4. consent_events            append-only record of grants, withdrawals and notice acknowledgements,
--                                written only by record_consent() with the SERVER's time and the CALLER's id
--   5. privacy_requests (+ _events)   access / correction / erasure / consent-withdrawal / grievance / nomination
--   6. export_my_data(), admin_export_member_data()   a member's own data, as JSON (audited)
--   7. retention_rules           configurable, UNAPPROVED by default; a preview only — it deletes nothing
--   8. register_push_device() now refuses a phone whose owner withdrew phone-alert consent
--
-- Not changed: bookings, credits, memberships, payments, orders, attendance, prices, or any existing
-- row. Existing members are NOT recorded as having consented to anything.
--
-- Commencement (official Gazette G.S.R. 846(E), 13 Nov 2025): the Rules' notice, security, breach, rights
-- and grievance provisions (Rules 3, 5–16) start 18 months after publication; Rule 4 after 12 months.
-- This migration builds the technical foundation ahead of that date. It is not legal advice.

begin;

-- ─── 1. Club details and policy switches (owner-supplied) ───────────────────
create table if not exists public.privacy_config (
  key text primary key,
  value text,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  constraint privacy_config_key check (key in (
    'legal_entity_name', 'registered_address', 'privacy_contact_email', 'privacy_contact_phone',
    'grievance_officer_name', 'grievance_officer_email', 'grievance_officer_phone', 'dpo_designation',
    'retention_summary', 'children_policy_text', 'data_location_statement', 'response_target_days',
    'erasure_finalisation_enabled', 'erasure_hold_days'))
);
insert into public.privacy_config (key) values
  ('legal_entity_name'), ('registered_address'), ('privacy_contact_email'), ('privacy_contact_phone'),
  ('grievance_officer_name'), ('grievance_officer_email'), ('grievance_officer_phone'), ('dpo_designation'),
  ('retention_summary'), ('children_policy_text'), ('data_location_statement'), ('response_target_days'),
  ('erasure_finalisation_enabled'), ('erasure_hold_days')
on conflict (key) do nothing;
-- Switches default to OFF / unset: erasure finalisation stays blocked until the owner decides.
update public.privacy_config set value = 'false' where key = 'erasure_finalisation_enabled' and value is null;

-- ─── 2. Purposes ────────────────────────────────────────────────────────────
create table if not exists public.consent_purposes (
  code text primary key,
  title text not null,
  description text not null,
  -- true: needed to provide the account/membership at all (acknowledged, not a free choice).
  is_mandatory boolean not null,
  is_active boolean not null default true,
  sort_order int not null default 0
);
insert into public.consent_purposes (code, title, description, is_mandatory, is_active, sort_order) values
  ('membership_service', 'Your account, membership and classes',
   'Creating and running your account, memberships, class bookings, attendance, credits, orders and payments.', true, true, 1),
  ('push_notifications', 'Phone alerts',
   'Sending booking, reminder, membership and order alerts to the phone you use the app on. Optional; you can switch it off at any time.', false, true, 2),
  ('marketing_communications', 'News and offers from the club',
   'Optional messages about offers and club news. Not offered until the club starts sending them.', false, false, 3)
on conflict (code) do nothing;

-- ─── 3. Versioned privacy notice ────────────────────────────────────────────
create table if not exists public.privacy_notice_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  language text not null default 'en',
  status text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  title text not null,
  body_md text not null,
  -- The text exactly as members saw it: placeholders filled in when the notice was published.
  rendered_body text,
  effective_date date,
  published_at timestamptz,
  published_by uuid references public.profiles(id),
  -- SHA-256 of the exact text that was published (evidence of what members were shown).
  published_sha256 text,
  created_at timestamptz not null default now(),
  constraint uq_notice_version unique (version, language)
);
create unique index if not exists uq_notice_one_published
  on public.privacy_notice_versions (language) where status = 'published';

create or replace function public._trg_notice_frozen()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status in ('published', 'retired') and (new.body_md is distinct from old.body_md or new.title is distinct from old.title or new.version is distinct from old.version or new.rendered_body is distinct from old.rendered_body) then
    raise exception 'NOTICE_FROZEN' using detail = 'A published notice cannot be edited. Save a new version instead.';
  end if;
  return new;
end $$;
drop trigger if exists trg_notice_frozen on public.privacy_notice_versions;
create trigger trg_notice_frozen before update on public.privacy_notice_versions
  for each row execute function public._trg_notice_frozen();

insert into public.privacy_notice_versions (version, language, status, title, body_md) values ('1.0', 'en', 'draft', 'Privacy Notice', $notice$
## Who we are
{{legal_entity_name}} ("the club", "we") runs Colonel Horse Riding, including this website and the club's mobile app. We decide why and how the personal data described below is used.
- Address: {{registered_address}}
- Privacy contact: {{privacy_contact_email}}
- Phone: {{privacy_contact_phone}}

## What personal data we handle
- Your account: name, email address, phone number (optional) and date of birth (only if you give it), and the role of your account.
- Your sign-in: your password is handled by our sign-in provider and is not readable by us. If you choose Google sign-in, Google confirms who you are to us.
- Your membership: the plan you bought, its dates, class credits, and how many reschedules you have used.
- Your classes: the sessions you book, move or cancel, your attendance (present, absent, excused) and any waitlist or weekly-schedule choices.
- Your payments and orders: amounts, status, dates and the payment references we are given. Card, UPI and bank details are entered with our payment provider; they do not reach the club's database.
- Your alerts: in-app notifications and, if you turn them on, a code that lets us send alerts to your phone, with the phone's type and the app version.
- Referrals: if you use or share a referral code, we record that the two members are connected, and any reward.
- Enquiries: if you use the contact form without an account, your name, age, email, phone number and topic.
- Staff records: when club staff act on your account (for example record attendance or adjust credits), we keep a record of who did what and when.

## Why we use it
- To create and run your account and membership, take payment, and let you book classes.
- To keep attendance, credit and payment records accurate, and to resolve disputes.
- To send you the alerts and notices that go with your bookings, memberships and orders.
- To keep the service secure and to prevent misuse.
- To answer your enquiries and your privacy requests.
- To meet our legal, tax and accounting duties.

## Which parts are required, and which are your choice
- Your account, membership, bookings and payments need the data above. Without it we cannot run them.
- Phone alerts are optional. You can turn them off at any time in the app or on the website, and we will stop registering your phone.
- We do not require you to agree to marketing in order to register or buy a membership. If the club offers marketing in future, it will be asked for separately.

## Who receives your data
We use service providers to run the service. They process data for us under their own terms:
- Supabase: hosting, the database and sign-in.
- Razorpay: card, UPI and bank payments.
- Resend: emails to club staff about new enquiries.
- Expo: delivery of phone alerts.
- Google: only if you choose Google sign-in.
- Our web hosting provider: serving this website.
{{data_location_statement}}

## Your rights
You can ask us to give you a copy of your personal data, to correct or update it, to erase it where the law allows, and to withdraw a consent you gave. You can also make a complaint about how we handle your data, nominate another person to exercise your rights for you, and complain to the Data Protection Board of India.
- Use "Privacy" in your account on the website or in the app, or write to {{privacy_contact_email}}.
- We aim to answer within {{response_target_days}} days.
- To protect you, we confirm that a request comes from the account holder before acting on it.

## Withdrawing consent, and what carries on
- Turning off phone alerts stops new alerts and removes the phone's alert code from our systems.
- Withdrawing a consent does not delete your account. Closing your account is a separate request.
- Some records have to stay even after you ask us to erase your data, for example payment and order records for tax and accounting, security records, and booking and attendance history needed to resolve disputes.

## How long we keep it
{{retention_summary}}

## Erasing your account
When you ask us to erase your account we first check whether you have an active membership, future bookings or an unpaid order, and we will tell you what needs to happen first. After that we remove your name, contact details and date of birth from your profile and stop your sign-in. Records we must keep stay, without the details that identify you where we can remove them. This is not instant, and we will tell you when it is finished.

## Children
{{children_policy_text}}

## How we protect it
Members can see only their own records, and staff access is limited by role. Connections to the website and app are encrypted in transit. We keep records of important staff actions. No system is perfectly secure; if there is a breach that affects you we will tell you, as the law requires.

## Who to contact with a complaint
- Name: {{grievance_officer_name}}
- Role: {{dpo_designation}}
- Email: {{grievance_officer_email}}
- Phone: {{grievance_officer_phone}}

## Changes to this notice
This notice has a version number and a date. If we change how we use your data we will publish a new version and tell you.
$notice$) on conflict (version, language) do nothing;

-- ─── 4. Consent record (append-only) ────────────────────────────────────────
create table if not exists public.consent_events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  user_id uuid not null references public.profiles(id),
  purpose text not null references public.consent_purposes(code),
  action text not null check (action in ('granted', 'withdrawn', 'notice_acknowledged')),
  notice_version text,
  source text not null default 'web' check (source in ('web', 'mobile')),
  created_at timestamptz not null default now()
);
create index if not exists idx_consent_events_user on public.consent_events (user_id, purpose, seq desc);

create or replace function public._trg_consent_immutable()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'CONSENT_IMMUTABLE' using detail = 'Consent records are append-only.';
end $$;
drop trigger if exists trg_consent_immutable on public.consent_events;
create trigger trg_consent_immutable before update or delete on public.consent_events
  for each row execute function public._trg_consent_immutable();

-- ─── 5. Privacy requests ────────────────────────────────────────────────────
create table if not exists public.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  request_type text not null check (request_type in ('access', 'correction', 'erasure', 'consent_withdrawal', 'grievance', 'nomination', 'other')),
  status text not null default 'submitted' check (status in ('submitted', 'in_progress', 'awaiting_requester', 'completed', 'rejected', 'cancelled')),
  subject text check (char_length(subject) <= 120),
  details text check (char_length(details) <= 2000),
  assigned_to uuid references public.profiles(id),
  submitted_at timestamptz not null default now(),
  -- An INTERNAL service target (submitted_at + response_target_days when the owner sets one).
  -- Not a statutory deadline; the Rules' 90-day outer limit (Rule 14(3)) is not enforced here.
  due_at timestamptz,
  resolved_at timestamptz,
  resolution_note text check (char_length(resolution_note) <= 2000),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_privacy_one_active_erasure
  on public.privacy_requests (user_id) where request_type = 'erasure' and status in ('submitted', 'in_progress', 'awaiting_requester');
create index if not exists idx_privacy_requests_user on public.privacy_requests (user_id, submitted_at desc);
create index if not exists idx_privacy_requests_open on public.privacy_requests (status, submitted_at) where status in ('submitted', 'in_progress', 'awaiting_requester');

create table if not exists public.privacy_request_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.privacy_requests(id),
  actor_id uuid references public.profiles(id),
  actor_role text not null check (actor_role in ('member', 'admin', 'system')),
  event text not null,
  from_status text,
  to_status text,
  -- Minimal handling notes only; never a copy of a member's data.
  note text check (char_length(note) <= 1000),
  created_at timestamptz not null default now()
);
create index if not exists idx_privacy_events_request on public.privacy_request_events (request_id, created_at);

-- ─── 6. Retention rules (configuration only) ────────────────────────────────
create table if not exists public.retention_rules (
  category text primary key,
  description text not null,
  retention_days int check (retention_days is null or retention_days > 0),
  basis text,
  status text not null default 'unapproved' check (status in ('unapproved', 'approved', 'suspended')),
  legal_hold boolean not null default false,
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  constraint retention_approved_has_days check (status <> 'approved' or retention_days is not null)
);
insert into public.retention_rules (category, description) values
  ('payments_orders', 'Payments, orders and order items (accounting and dispute evidence)'),
  ('payment_webhook_events', 'Raw payment-provider webhook payloads kept for idempotency'),
  ('audit_logs', 'Staff-action audit trail (accountability and security investigation)'),
  ('attendance_notes', 'Free-text notes staff attach to an attendance record'),
  ('notifications', 'In-app and push notification content'),
  ('push_devices_disabled', 'Phone-alert codes that are switched off'),
  ('enquiries', 'Contact-form enquiries from non-members'),
  ('privacy_requests', 'Privacy requests and their handling events'),
  ('consent_events', 'Consent and notice-acknowledgement records')
on conflict (category) do nothing;

-- ─── Row-level security ─────────────────────────────────────────────────────
alter table public.privacy_config enable row level security;
alter table public.consent_purposes enable row level security;
alter table public.privacy_notice_versions enable row level security;
alter table public.consent_events enable row level security;
alter table public.privacy_requests enable row level security;
alter table public.privacy_request_events enable row level security;
alter table public.retention_rules enable row level security;

drop policy if exists "Anyone reads active purposes" on public.consent_purposes;
create policy "Anyone reads active purposes" on public.consent_purposes for select to anon, authenticated using (is_active);
drop policy if exists "Anyone reads published notices" on public.privacy_notice_versions;
create policy "Anyone reads published notices" on public.privacy_notice_versions for select to anon, authenticated using (status = 'published');
drop policy if exists "Admin reads all notices" on public.privacy_notice_versions;
create policy "Admin reads all notices" on public.privacy_notice_versions for select to authenticated using (public.is_admin());
drop policy if exists "Members read own consent" on public.consent_events;
create policy "Members read own consent" on public.consent_events for select to authenticated using (user_id = auth.uid());
drop policy if exists "Admin reads consent" on public.consent_events;
create policy "Admin reads consent" on public.consent_events for select to authenticated using (public.is_admin());
drop policy if exists "Members read own privacy requests" on public.privacy_requests;
create policy "Members read own privacy requests" on public.privacy_requests for select to authenticated using (user_id = auth.uid());
drop policy if exists "Admin reads privacy requests" on public.privacy_requests;
create policy "Admin reads privacy requests" on public.privacy_requests for select to authenticated using (public.is_admin());
drop policy if exists "Admin reads privacy events" on public.privacy_request_events;
create policy "Admin reads privacy events" on public.privacy_request_events for select to authenticated using (public.is_admin());
drop policy if exists "Admin reads retention rules" on public.retention_rules;
create policy "Admin reads retention rules" on public.retention_rules for select to authenticated using (public.is_admin());
-- privacy_config has no policy: only the SECURITY DEFINER functions below can read or change it.
-- No table has an insert/update/delete policy: every write goes through a function.

revoke all on public.privacy_config, public.consent_purposes, public.privacy_notice_versions, public.consent_events,
  public.privacy_requests, public.privacy_request_events, public.retention_rules from anon;
revoke insert, update, delete, truncate on public.privacy_config, public.consent_purposes, public.privacy_notice_versions,
  public.consent_events, public.privacy_requests, public.privacy_request_events, public.retention_rules from authenticated;
grant select on public.consent_purposes, public.privacy_notice_versions to anon;

-- ─── Internal helpers ───────────────────────────────────────────────────────
create or replace function public._privacy_cfg(p_key text)
returns text language sql stable security definer set search_path = public as $$
  select nullif(btrim(value), '') from public.privacy_config where key = p_key
$$;

create or replace function public._latest_consent_action(p_user uuid, p_purpose text)
returns text language sql stable security definer set search_path = public as $$
  select action from public.consent_events where user_id = p_user and purpose = p_purpose order by seq desc limit 1
$$;

-- Keys the notice needs before it may be published.
create or replace function public._privacy_missing_keys()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(k order by k), '{}') from unnest(array[
    'legal_entity_name', 'registered_address', 'privacy_contact_email', 'grievance_officer_name',
    'grievance_officer_email', 'retention_summary', 'children_policy_text', 'data_location_statement']) k
  where public._privacy_cfg(k) is null
$$;

-- Fills {{placeholders}}. A required value that is not set stays visible as "[not yet provided]";
-- an optional line (phone numbers, target days, role) is left out when it is not set.
create or replace function public._render_notice(p_body text)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v text := p_body;
  k text;
  val text;
  optional text[] := array['privacy_contact_phone', 'grievance_officer_phone', 'dpo_designation', 'response_target_days'];
begin
  foreach k in array array['legal_entity_name', 'registered_address', 'privacy_contact_email', 'privacy_contact_phone',
    'grievance_officer_name', 'grievance_officer_email', 'grievance_officer_phone', 'dpo_designation', 'retention_summary',
    'children_policy_text', 'data_location_statement', 'response_target_days'] loop
    val := public._privacy_cfg(k);
    if val is null and k = any(optional) then
      v := regexp_replace(v, '(^|\n)[^\n]*\{\{' || k || '\}\}[^\n]*', '', 'g');
    else
      v := replace(v, '{{' || k || '}}', coalesce(val, '[not yet provided]'));
    end if;
  end loop;
  return v;
end $$;

-- ─── Public: club contact details and the notice ────────────────────────────
create or replace function public.public_privacy_config()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_missing text[] := public._privacy_missing_keys();
begin
  return jsonb_build_object(
    'legal_entity_name', public._privacy_cfg('legal_entity_name'),
    'registered_address', public._privacy_cfg('registered_address'),
    'privacy_contact_email', public._privacy_cfg('privacy_contact_email'),
    'privacy_contact_phone', public._privacy_cfg('privacy_contact_phone'),
    'grievance_officer_name', public._privacy_cfg('grievance_officer_name'),
    'grievance_officer_email', public._privacy_cfg('grievance_officer_email'),
    'grievance_officer_phone', public._privacy_cfg('grievance_officer_phone'),
    'dpo_designation', public._privacy_cfg('dpo_designation'),
    'complete', coalesce(array_length(v_missing, 1), 0) = 0,
    'missing', to_jsonb(v_missing));
end $$;

-- The published notice, or (clearly marked) the latest draft when none is published.
create or replace function public.current_privacy_notice(p_language text default 'en')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  n public.privacy_notice_versions;
  v_missing text[] := public._privacy_missing_keys();
begin
  select * into n from public.privacy_notice_versions where language = p_language and status = 'published';
  if found then
    return jsonb_build_object('published', true, 'version', n.version, 'language', n.language, 'title', n.title,
      'effective_date', n.effective_date, 'published_at', n.published_at, 'body', n.rendered_body,
      'missing', '[]'::jsonb);
  end if;
  select * into n from public.privacy_notice_versions where language = p_language and status = 'draft' order by created_at desc limit 1;
  if not found then return jsonb_build_object('published', false, 'version', null, 'missing', to_jsonb(v_missing)); end if;
  return jsonb_build_object('published', false, 'version', n.version, 'language', n.language, 'title', n.title,
    'effective_date', null, 'published_at', null, 'body', public._render_notice(n.body_md), 'missing', to_jsonb(v_missing));
end $$;

-- ─── Member: consent ────────────────────────────────────────────────────────
create or replace function public.record_consent(p_purpose text, p_action text, p_notice_version text default null, p_source text default 'web')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_purpose public.consent_purposes;
  v_published public.privacy_notice_versions;
  v_last public.consent_events;
  v_id uuid;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_action not in ('granted', 'withdrawn', 'notice_acknowledged') then raise exception 'INVALID_ACTION'; end if;
  if p_source not in ('web', 'mobile') then raise exception 'INVALID_SOURCE'; end if;

  select * into v_purpose from public.consent_purposes where code = p_purpose and is_active;
  if not found then raise exception 'UNKNOWN_PURPOSE'; end if;

  -- The essential service is not a switch: stopping it means closing the account (a privacy request).
  if v_purpose.is_mandatory and p_action = 'withdrawn' then
    raise exception 'MANDATORY_PURPOSE' using detail = 'This is needed to run your account. To stop it, ask to close your account instead.';
  end if;
  if not v_purpose.is_mandatory and p_action = 'notice_acknowledged' then raise exception 'INVALID_ACTION'; end if;

  -- Acknowledging the essential service is only ever recorded against a notice that is actually published.
  -- An optional choice can be switched back on at any time (it is the member's own act); if a notice is
  -- published, it is recorded against that exact version.
  if p_action in ('granted', 'notice_acknowledged') then
    select * into v_published from public.privacy_notice_versions where status = 'published' and language = 'en';
    if not found then
      if v_purpose.is_mandatory then raise exception 'NOTICE_NOT_PUBLISHED'; end if;
      if p_notice_version is not null then raise exception 'NOTICE_VERSION_MISMATCH'; end if;
    elsif p_notice_version is distinct from v_published.version then
      raise exception 'NOTICE_VERSION_MISMATCH' using detail = 'The notice you saw is no longer the current one.';
    end if;
  end if;

  select * into v_last from public.consent_events where user_id = v_uid and purpose = p_purpose order by seq desc limit 1;
  -- The same answer again changes nothing, so a retry never adds a duplicate record.
  if found then
    if p_action = 'withdrawn' and v_last.action = 'withdrawn' then
      return jsonb_build_object('recorded', false, 'purpose', p_purpose, 'action', p_action);
    end if;
    if p_action <> 'withdrawn' and v_last.action = p_action and v_last.notice_version is not distinct from p_notice_version then
      return jsonb_build_object('recorded', false, 'purpose', p_purpose, 'action', p_action);
    end if;
  end if;

  insert into public.consent_events (user_id, purpose, action, notice_version, source)
  values (v_uid, p_purpose, p_action, case when p_action = 'withdrawn' then (select version from public.privacy_notice_versions where status = 'published' and language = 'en') else p_notice_version end, p_source)
  returning id into v_id;

  -- Withdrawal takes effect now: a phone's alert code is removed, and registering again is refused.
  if p_purpose = 'push_notifications' and p_action = 'withdrawn' then
    delete from public.push_devices where user_id = v_uid;
  end if;

  perform public._audit('consent_events', v_id, case p_action when 'granted' then 'CONSENT_GRANTED' when 'withdrawn' then 'CONSENT_WITHDRAWN' else 'NOTICE_ACKNOWLEDGED' end,
    null, jsonb_build_object('purpose', p_purpose, 'notice_version', p_notice_version, 'source', p_source));
  return jsonb_build_object('recorded', true, 'purpose', p_purpose, 'action', p_action);
end $$;

-- The member's own consent picture, plus whether a newer notice is waiting for acknowledgement.
create or replace function public.my_consents()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_pub text;
  v_ack text;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select version into v_pub from public.privacy_notice_versions where status = 'published' and language = 'en';
  select notice_version into v_ack from public.consent_events
    where user_id = v_uid and purpose = 'membership_service' and action in ('granted', 'notice_acknowledged') order by seq desc limit 1;
  return jsonb_build_object(
    'current_notice_version', v_pub,
    'acknowledged_notice_version', v_ack,
    'needs_acknowledgement', v_pub is not null and v_ack is distinct from v_pub,
    'purposes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'purpose', p.code, 'title', p.title, 'description', p.description, 'is_mandatory', p.is_mandatory,
        'status', case
          when l.action is null then 'none'
          when p.is_mandatory then 'acknowledged'
          else l.action end,
        'notice_version', l.notice_version, 'at', l.created_at) order by p.sort_order)
      from public.consent_purposes p
      left join lateral (select action, notice_version, created_at from public.consent_events c
                         where c.user_id = v_uid and c.purpose = p.code order by c.seq desc limit 1) l on true
      where p.is_active), '[]'::jsonb));
end $$;

-- ─── Member: privacy requests ───────────────────────────────────────────────
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

create or replace function public.my_privacy_requests()
returns table (id uuid, request_type text, status text, subject text, submitted_at timestamptz, due_at timestamptz, resolved_at timestamptz, resolution_note text)
language sql stable security definer set search_path = public as $$
  select r.id, r.request_type, r.status, r.subject, r.submitted_at, r.due_at, r.resolved_at, r.resolution_note
  from public.privacy_requests r where r.user_id = auth.uid() order by r.submitted_at desc limit 50
$$;

create or replace function public.cancel_my_privacy_request(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r public.privacy_requests;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into r from public.privacy_requests where id = p_id and user_id = auth.uid() for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if r.status not in ('submitted', 'awaiting_requester') then raise exception 'NOT_CANCELLABLE' using detail = 'This request is already being handled or is closed.'; end if;
  update public.privacy_requests set status = 'cancelled', resolved_at = now(), updated_at = now() where id = p_id;
  insert into public.privacy_request_events (request_id, actor_id, actor_role, event, from_status, to_status) values (p_id, auth.uid(), 'member', 'cancelled_by_member', r.status, 'cancelled');
  perform public._audit('privacy_requests', p_id, 'PRIVACY_REQUEST_CANCELLED', null, jsonb_build_object('type', r.request_type));
end $$;

-- ─── Personal-data export ───────────────────────────────────────────────────
-- Excludes: staff free-text notes, the security audit trail, payment-provider internals
-- (payments.metadata) and data held by service providers — see docs/privacy/DPDP_DATA_AUDIT.md.
create or replace function public._member_data_export(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'generated_at', now(),
    'about_this_file', 'A copy of the personal data the club holds about you in its member system. It leaves out staff notes, security logs, and data held by our service providers (payments, email, alerts).',
    'profile', (select jsonb_build_object('full_name', full_name, 'email', email, 'phone', phone, 'date_of_birth', date_of_birth, 'role', role, 'status', status, 'created_at', created_at) from public.profiles where id = p_user),
    'consents', coalesce((select jsonb_agg(jsonb_build_object('purpose', purpose, 'action', action, 'notice_version', notice_version, 'source', source, 'at', created_at) order by seq) from public.consent_events where user_id = p_user), '[]'::jsonb),
    'privacy_requests', coalesce((select jsonb_agg(jsonb_build_object('type', request_type, 'status', status, 'submitted_at', submitted_at, 'resolved_at', resolved_at) order by submitted_at) from public.privacy_requests where user_id = p_user), '[]'::jsonb),
    'memberships', coalesce((select jsonb_agg(jsonb_build_object('plan', mp.name, 'status', m.status, 'start_date', m.start_date, 'end_date', m.end_date, 'total_credits', m.total_credits, 'credits_remaining', m.credits_remaining, 'reschedules_used', m.reschedules_used, 'created_at', m.created_at) order by m.created_at)
      from public.memberships m join public.membership_plans mp on mp.id = m.plan_id where m.user_id = p_user), '[]'::jsonb),
    'credit_ledger', coalesce((select jsonb_agg(jsonb_build_object('amount', amount, 'type', transaction_type, 'description', description, 'at', created_at) order by created_at) from public.credit_ledger where user_id = p_user), '[]'::jsonb),
    'bookings', coalesce((select jsonb_agg(jsonb_build_object('date', cs.session_date, 'start', cs.start_time, 'end', cs.end_time, 'status', b.status, 'booked_at', b.booked_at, 'cancelled_at', b.cancelled_at, 'cancellation_reason', b.cancellation_reason, 'attendance', a.status, 'attendance_marked_at', a.marked_at) order by cs.session_date, cs.start_time)
      from public.bookings b join public.class_sessions cs on cs.id = b.session_id left join public.attendance a on a.booking_id = b.id where b.user_id = p_user), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('amount', amount, 'currency', currency, 'status', status, 'paid_at', paid_at, 'gateway', gateway, 'gateway_order_id', gateway_order_id, 'gateway_payment_id', gateway_payment_id, 'created_at', created_at) order by created_at) from public.payments where user_id = p_user), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('status', o.status, 'total_amount', o.total_amount, 'wallet_applied', o.wallet_applied, 'paid_at', o.paid_at, 'collected_at', o.collected_at, 'created_at', o.created_at,
      'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'quantity', i.quantity, 'unit_price', i.unit_price)) from public.order_items i where i.order_id = o.id), '[]'::jsonb)) order by o.created_at)
      from public.orders o where o.user_id = p_user), '[]'::jsonb),
    'wallet', coalesce((select jsonb_agg(jsonb_build_object('amount', amount, 'kind', kind, 'description', description, 'at', created_at) order by created_at) from public.wallet_ledger where user_id = p_user), '[]'::jsonb),
    'referral', jsonb_build_object(
      'your_code', (select code from public.referral_codes where user_id = p_user),
      'you_referred', (select count(*) from public.referrals where referrer_id = p_user),
      'you_were_referred', exists (select 1 from public.referrals where referred_id = p_user)),
    'notifications', coalesce((select jsonb_agg(jsonb_build_object('type', type, 'title', title, 'body', body, 'read_at', read_at, 'at', created_at) order by created_at desc) from (select * from public.notifications where user_id = p_user and audience = 'user' order by created_at desc limit 500) n), '[]'::jsonb),
    'phone_alert_devices', coalesce((select jsonb_agg(jsonb_build_object('platform', platform, 'app_version', app_version, 'registered_at', created_at, 'switched_off_at', disabled_at)) from public.push_devices where user_id = p_user), '[]'::jsonb),
    'weekly_schedules', coalesce((select jsonb_agg(jsonb_build_object('status', s.status, 'created_at', s.created_at, 'slots', coalesce((select jsonb_agg(jsonb_build_object('day_of_week', sl.day_of_week, 'start', sl.start_time, 'end', sl.end_time)) from public.recurring_schedule_slots sl where sl.schedule_id = s.id), '[]'::jsonb)) order by s.created_at) from public.recurring_schedules s where s.user_id = p_user), '[]'::jsonb)
  )
$$;

create or replace function public.export_my_data()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  perform public._audit('profiles', auth.uid(), 'PRIVACY_EXPORT_GENERATED', null, jsonb_build_object('by', 'self'));
  return public._member_data_export(auth.uid());
end $$;

-- An admin can produce the copy only for a member who has an OPEN access request, and it is audited.
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

-- ─── Admin: requests ────────────────────────────────────────────────────────
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

create or replace function public.admin_privacy_request_events(p_id uuid)
returns table (event text, actor_role text, actor_name text, from_status text, to_status text, note text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  return query select e.event, e.actor_role, p.full_name, e.from_status, e.to_status, e.note, e.created_at
    from public.privacy_request_events e left join public.profiles p on p.id = e.actor_id where e.request_id = p_id order by e.created_at;
end $$;

create or replace function public.admin_update_privacy_request(p_id uuid, p_status text default null, p_assigned_to uuid default null, p_note text default null)
returns public.privacy_requests language plpgsql security definer set search_path = public as $$
declare
  r public.privacy_requests;
  v_open text[] := array['submitted', 'in_progress', 'awaiting_requester'];
  v_note text := nullif(btrim(p_note), '');
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  select * into r from public.privacy_requests where id = p_id for update;
  if not found then raise exception 'REQUEST_NOT_FOUND'; end if;
  if r.status not in ('submitted', 'in_progress', 'awaiting_requester') then raise exception 'REQUEST_CLOSED'; end if;
  if char_length(coalesce(v_note, '')) > 1000 then raise exception 'TEXT_TOO_LONG'; end if;

  if p_assigned_to is not null then
    if not exists (select 1 from public.profiles where id = p_assigned_to and role = 'admin') then raise exception 'ASSIGNEE_MUST_BE_ADMIN'; end if;
    update public.privacy_requests set assigned_to = p_assigned_to, updated_at = now() where id = p_id;
    insert into public.privacy_request_events (request_id, actor_id, actor_role, event) values (p_id, auth.uid(), 'admin', 'assigned');
  end if;

  if p_status is not null and p_status <> r.status then
    if p_status not in ('in_progress', 'awaiting_requester', 'completed', 'rejected') then raise exception 'INVALID_STATUS'; end if;
    if p_status in ('completed', 'rejected') and v_note is null then raise exception 'NOTE_REQUIRED' using detail = 'Say what was done, or why the request was declined.'; end if;
    -- Closing an account is done only by the guarded erasure workflow (0031), never by a status click.
    if r.request_type = 'erasure' and p_status = 'completed' then raise exception 'USE_ERASURE_WORKFLOW'; end if;
    update public.privacy_requests set status = p_status, updated_at = now(),
      resolved_at = case when p_status in ('completed', 'rejected') then now() else null end,
      resolution_note = case when p_status in ('completed', 'rejected') then v_note else resolution_note end
    where id = p_id;
    insert into public.privacy_request_events (request_id, actor_id, actor_role, event, from_status, to_status, note) values (p_id, auth.uid(), 'admin', 'status_changed', r.status, p_status, v_note);
    perform public._audit('privacy_requests', p_id, 'PRIVACY_REQUEST_' || upper(p_status), jsonb_build_object('status', r.status), jsonb_build_object('status', p_status, 'type', r.request_type));
    perform public._notify_user(r.user_id, 'privacy_request_update', 'Your privacy request was updated',
      'Status: ' || replace(p_status, '_', ' ') || '. Open Privacy settings for details.', jsonb_build_object('request_id', p_id));
  elsif v_note is not null then
    insert into public.privacy_request_events (request_id, actor_id, actor_role, event, note) values (p_id, auth.uid(), 'admin', 'note', v_note);
  end if;

  select * into r from public.privacy_requests where id = p_id;
  return r;
end $$;

-- ─── Admin: notice, club details, overview, retention ───────────────────────
create or replace function public.admin_privacy_config()
returns table (key text, value text, updated_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  return query select c.key, c.value, c.updated_at from public.privacy_config c order by c.key;
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

create or replace function public.admin_save_notice_draft(p_version text, p_title text, p_body text, p_language text default 'en')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if nullif(btrim(p_version), '') is null or nullif(btrim(p_title), '') is null or nullif(btrim(p_body), '') is null then raise exception 'INVALID_VALUE'; end if;
  if char_length(p_body) > 60000 then raise exception 'TEXT_TOO_LONG'; end if;
  insert into public.privacy_notice_versions (version, language, title, body_md) values (btrim(p_version), p_language, btrim(p_title), p_body)
  on conflict (version, language) do update set title = excluded.title, body_md = excluded.body_md
    where public.privacy_notice_versions.status = 'draft'
  returning id into v_id;
  if v_id is null then raise exception 'NOTICE_FROZEN'; end if;
  perform public._audit('privacy_notice_versions', v_id, 'PRIVACY_NOTICE_DRAFT_SAVED', null, jsonb_build_object('version', btrim(p_version), 'language', p_language));
  return v_id;
end $$;

-- Publishing is the owner's decision: all club details present AND an explicit legal-review confirmation.
create or replace function public.admin_publish_privacy_notice(p_version text, p_legal_review_confirmed boolean, p_effective_date date)
returns void language plpgsql security definer set search_path = public as $$
declare
  n public.privacy_notice_versions;
  v_missing text[] := public._privacy_missing_keys();
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if p_legal_review_confirmed is not true then raise exception 'LEGAL_REVIEW_NOT_CONFIRMED' using detail = 'Confirm that the notice has been reviewed before publishing.'; end if;
  if p_effective_date is null then raise exception 'INVALID_VALUE' using detail = 'Choose an effective date.'; end if;
  if array_length(v_missing, 1) is not null then raise exception 'CLUB_DETAILS_MISSING' using detail = 'Still needed: ' || array_to_string(v_missing, ', '); end if;
  select * into n from public.privacy_notice_versions where version = p_version and language = 'en' for update;
  if not found then raise exception 'NOTICE_NOT_FOUND'; end if;
  if n.status <> 'draft' then raise exception 'NOTICE_FROZEN'; end if;
  update public.privacy_notice_versions set status = 'retired' where language = n.language and status = 'published';
  update public.privacy_notice_versions set status = 'published', published_at = now(), published_by = auth.uid(), effective_date = p_effective_date,
    rendered_body = public._render_notice(n.body_md),
    published_sha256 = encode(sha256(convert_to(public._render_notice(n.body_md), 'UTF8')), 'hex')
  where id = n.id;
  perform public._audit('privacy_notice_versions', n.id, 'PRIVACY_NOTICE_PUBLISHED', null, jsonb_build_object('version', n.version, 'effective_date', p_effective_date));
end $$;

create or replace function public.admin_list_notices()
returns table (version text, language text, status text, title text, effective_date date, published_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  return query select v.version, v.language, v.status, v.title, v.effective_date, v.published_at from public.privacy_notice_versions v order by v.created_at desc;
end $$;

create or replace function public.admin_privacy_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_missing text[] := public._privacy_missing_keys();
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  return jsonb_build_object(
    'requests_open', (select count(*) from public.privacy_requests where status in ('submitted', 'in_progress', 'awaiting_requester')),
    'requests_overdue', (select count(*) from public.privacy_requests where due_at is not null and due_at < now() and status in ('submitted', 'in_progress', 'awaiting_requester')),
    'erasure_open', (select count(*) from public.privacy_requests where request_type = 'erasure' and status in ('submitted', 'in_progress', 'awaiting_requester')),
    'notice_published_version', (select version from public.privacy_notice_versions where status = 'published' and language = 'en'),
    'club_details_missing', to_jsonb(v_missing),
    'retention_rules_unapproved', (select count(*) from public.retention_rules where status <> 'approved'),
    'consent_summary', coalesce((select jsonb_object_agg(purpose, jsonb_build_object('granted', granted, 'withdrawn', withdrawn)) from (
        select e.purpose, count(*) filter (where last_action in ('granted', 'notice_acknowledged')) as granted, count(*) filter (where last_action = 'withdrawn') as withdrawn
        from (select distinct on (user_id, purpose) user_id, purpose, action as last_action from public.consent_events order by user_id, purpose, seq desc) e group by e.purpose) s), '{}'::jsonb),
    -- Members whose date of birth says they are under 18: the Rules require a parent's verifiable consent (Rule 10).
    -- No mechanism exists yet; see docs/privacy/BUSINESS_DECISIONS_REQUIRED.md (LEGAL_REVIEW_REQUIRED).
    'members_under_18', (select count(*) from public.profiles where date_of_birth is not null and date_of_birth > (current_date - interval '18 years')::date and role = 'member'));
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

create or replace function public.admin_retention_rules()
returns table (category text, description text, retention_days int, basis text, status text, legal_hold boolean, approved_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  return query select r.category, r.description, r.retention_days, r.basis, r.status, r.legal_hold, r.approved_at from public.retention_rules r order by r.category;
end $$;

create or replace function public.admin_set_retention_rule(p_category text, p_days int, p_basis text, p_approve boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if not exists (select 1 from public.retention_rules where category = p_category) then raise exception 'UNKNOWN_CATEGORY'; end if;
  if p_days is not null and (p_days < 1 or p_days > 36500) then raise exception 'INVALID_VALUE'; end if;
  if p_approve and (p_days is null or nullif(btrim(coalesce(p_basis, '')), '') is null) then raise exception 'BASIS_REQUIRED' using detail = 'An approved period needs a number of days and the reason for it.'; end if;
  update public.retention_rules set retention_days = p_days, basis = nullif(btrim(p_basis), ''),
    status = case when p_approve then 'approved' else 'unapproved' end,
    approved_by = case when p_approve then auth.uid() end, approved_at = case when p_approve then now() end
  where category = p_category;
  perform public._audit('retention_rules', gen_random_uuid(), 'PRIVACY_RETENTION_RULE_SET', null, jsonb_build_object('category', p_category, 'approved', p_approve, 'days', p_days));
end $$;

-- A COUNT only: how many rows are older than an APPROVED period. It deletes nothing.
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

-- ─── register_push_device: honour a withdrawal of phone-alert consent ───────
-- Identical to the 0026 body except the one added check. A member who never answered the
-- question is unaffected: choosing to allow alerts in the phone's own permission prompt is their act.
create or replace function public.register_push_device(p_token text, p_platform text, p_app_version text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if public._latest_consent_action(v_uid, 'push_notifications') = 'withdrawn' then raise exception 'PUSH_WITHDRAWN'; end if;
  if p_token is null or p_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,}\]$' then raise exception 'INVALID_TOKEN'; end if;
  if p_platform not in ('android', 'ios') then raise exception 'INVALID_PLATFORM'; end if;

  insert into public.push_devices (user_id, token, platform, app_version)
  values (v_uid, p_token, p_platform, left(p_app_version, 32))
  on conflict (token) do update set
    created_at = case when push_devices.user_id = excluded.user_id then push_devices.created_at else now() end,
    user_id = excluded.user_id,
    platform = excluded.platform,
    app_version = excluded.app_version,
    updated_at = now(),
    disabled_at = null,
    disabled_reason = null;

  update public.push_devices set disabled_at = now(), disabled_reason = 'device_limit'
  where id in (
    select id from public.push_devices
    where user_id = v_uid and disabled_at is null
    order by updated_at desc
    offset 10
  );
end;
$$;

-- ─── Permissions ────────────────────────────────────────────────────────────
revoke execute on function public._privacy_cfg(text), public._latest_consent_action(uuid, text), public._privacy_missing_keys(),
  public._render_notice(text), public._member_data_export(uuid), public._trg_notice_frozen(), public._trg_consent_immutable() from public, anon, authenticated;

revoke execute on function public.public_privacy_config(), public.current_privacy_notice(text) from public;
grant execute on function public.public_privacy_config(), public.current_privacy_notice(text) to anon, authenticated;

revoke execute on function public.record_consent(text, text, text, text), public.my_consents(), public.submit_privacy_request(text, text, text),
  public.my_privacy_requests(), public.cancel_my_privacy_request(uuid), public.export_my_data(), public.register_push_device(text, text, text),
  public.admin_export_member_data(uuid), public.admin_list_privacy_requests(text, int), public.admin_privacy_request_events(uuid),
  public.admin_update_privacy_request(uuid, text, uuid, text), public.admin_privacy_config(), public.admin_set_privacy_config(text, text),
  public.admin_save_notice_draft(text, text, text, text), public.admin_publish_privacy_notice(text, boolean, date), public.admin_list_notices(),
  public.admin_privacy_overview(), public.admin_privacy_audit(int), public.admin_retention_rules(), public.admin_set_retention_rule(text, int, text, boolean),
  public.admin_retention_preview() from public, anon;
grant execute on function public.record_consent(text, text, text, text), public.my_consents(), public.submit_privacy_request(text, text, text),
  public.my_privacy_requests(), public.cancel_my_privacy_request(uuid), public.export_my_data(), public.register_push_device(text, text, text),
  public.admin_export_member_data(uuid), public.admin_list_privacy_requests(text, int), public.admin_privacy_request_events(uuid),
  public.admin_update_privacy_request(uuid, text, uuid, text), public.admin_privacy_config(), public.admin_set_privacy_config(text, text),
  public.admin_save_notice_draft(text, text, text, text), public.admin_publish_privacy_notice(text, boolean, date), public.admin_list_notices(),
  public.admin_privacy_overview(), public.admin_privacy_audit(int), public.admin_retention_rules(), public.admin_set_retention_rule(text, int, text, boolean),
  public.admin_retention_preview() to authenticated;

notify pgrst, 'reload schema';

commit;
