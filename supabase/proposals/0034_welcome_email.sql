-- 0034_welcome_email.sql  (Apply in the Supabase SQL Editor after 0033. Safe to run twice.)
--
-- !! NEVER RE-RUN 0033 AFTER THIS FILE. 0033 recreates email_job_context() WITHOUT the 'welcome' branch, so every
-- !! welcome job would be skipped as 'unknown_template'. If 0033 ever has to be re-run, re-run this file straight after.
--
-- Welcome email for a genuinely NEW account, through the existing transactional-email outbox (0033).
--
-- WHEN A WELCOME EMAIL IS QUEUED
--   Exactly when an auth.users row first becomes a confirmed address, and only for accounts created on or after the
--   date the club switches this on:
--     * a row INSERTed already confirmed        (Google sign-in; or email sign-up while confirmation is off), or
--     * a row UPDATEd from unconfirmed to confirmed (email sign-up, when the member clicks the confirmation link).
--   Never on: a login, a session refresh, a repeated OAuth callback, a profile edit/sync, an email change, a password
--   reset, or an existing user (their email_confirmed_at is already set, so neither trigger can fire).
-- ONCE ONLY
--   dedupe_key = 'welcome:<user id>' is UNIQUE in email_outbox, so even if both triggers fired, or the same
--   confirmation were replayed, a second job cannot exist. A retry of the job reuses the same job id.
-- OFF UNTIL SWITCHED ON, NO BACKFILL
--   system_settings.welcome_email_start is blank, so nothing is queued. To switch on (once the template is ready):
--       update public.system_settings set value = to_jsonb(to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
--         updated_at = now() where key = 'welcome_email_start';
--   The value must be an explicit timestamp WITH a zone: 2026-10-21T09:30:00Z, 2026-10-21 15:00:00+05:30, 2026-10-21T05:30:00-04:00.
--   Anything else (blank, date only, no offset, a bad date, 'now', 'epoch', 'infinity', text) keeps the feature OFF.
--   Only accounts created at or after that moment are welcomed. Nobody who already has an account is ever emailed.
--   To switch off: set the value back to '""'.
-- NEVER BLOCKS SIGN-UP
--   Both triggers swallow every error, exactly like the other email hooks.
--
-- Nothing here changes handle_new_user(), a policy, a grant, or any payment / membership / booking function.

begin;

-- ─── 1. The outbox may hold welcome jobs about a user ───────────────────────
alter table public.email_outbox drop constraint if exists email_outbox_template_check;
alter table public.email_outbox add constraint email_outbox_template_check check (template in
  ('payment_received', 'membership_activated', 'booking_confirmed', 'reschedule_confirmed',
   'order_confirmation', 'payment_pending', 'welcome'));
alter table public.email_outbox drop constraint if exists email_outbox_related_type_check;
alter table public.email_outbox add constraint email_outbox_related_type_check check (related_type in
  ('payment', 'order', 'membership', 'booking', 'user'));

-- Fail LOUDLY (and roll everything back) if any other CHECK still restricts template or related_type, for example
-- one that kept an unexpected name. Otherwise sign-up would succeed while every welcome job was silently refused.
do $$
declare
  v_tpl smallint := (select attnum from pg_attribute where attrelid = 'public.email_outbox'::regclass and attname = 'template');
  v_rel smallint := (select attnum from pg_attribute where attrelid = 'public.email_outbox'::regclass and attname = 'related_type');
  r record;
begin
  for r in
    select conname, pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = 'public.email_outbox'::regclass and contype = 'c'
      and (conkey @> array[v_tpl] or conkey @> array[v_rel])
      and conname not in ('email_outbox_template_check', 'email_outbox_related_type_check')
  loop
    raise exception '0034: unexpected CHECK % on email_outbox (%) would refuse welcome jobs; drop or rename it and re-run', r.conname, r.def;
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'public.email_outbox'::regclass and conname = 'email_outbox_template_check'
                 and convalidated and pg_get_constraintdef(oid) like '%''welcome''%') then
    raise exception '0034: email_outbox_template_check does not allow ''welcome''';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.email_outbox'::regclass and conname = 'email_outbox_related_type_check'
                 and convalidated and pg_get_constraintdef(oid) like '%''user''%') then
    raise exception '0034: email_outbox_related_type_check does not allow ''user''';
  end if;
end $$;

-- ─── 2. The switch (blank = off) ────────────────────────────────────────────
insert into public.system_settings (key, value, description) values
  ('welcome_email_start', '""'::jsonb,
   'Blank = no welcome emails. Set to a timestamp to welcome only accounts created at or after it (see 0034). Never back-fills.')
on conflict (key) do nothing;

-- ─── 3. Queue the welcome email for one user (idempotent) ───────────────────
-- The activation time, or NULL (= OFF). Accepts ONLY an explicit ISO-style timestamp that carries a zone: Z, +05:30,
-- -04:00, +0530 or +05. Blank, date-only, no offset, an impossible date, and Postgres special words such as epoch, now,
-- tomorrow, infinity and -infinity all return NULL, so they can never switch the feature on.
create or replace function public._welcome_start()
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare
  v text := public._email_cfg('welcome_email_start');
begin
  if v is null or v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
    return null;
  end if;
  begin
    return v::timestamptz;                           -- rejects impossible dates and times
  exception when others then
    return null;
  end;
end;
$$;
revoke execute on function public._welcome_start() from public, anon, authenticated;

create or replace function public._queue_welcome_email(p_user uuid, p_created timestamptz)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_start timestamptz;
begin
  begin
    v_start := public._welcome_start();
  exception when others then
    return false;                                   -- unreadable setting: stay off
  end;
  if v_start is null or p_created is null or p_created < v_start then return false; end if;
  return public._enqueue_email('welcome', 'welcome:' || p_user, p_user, 'user', p_user, null);
end;
$$;
revoke execute on function public._queue_welcome_email(uuid, timestamptz) from public, anon, authenticated;

create or replace function public._trg_welcome_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    perform public._queue_welcome_email(new.id, new.created_at);
  exception when others then
    raise warning 'welcome email enqueue skipped: %', sqlerrm;   -- sign-up must still succeed
  end;
  return new;
end;
$$;
revoke execute on function public._trg_welcome_email() from public, anon, authenticated;

-- Named so that it fires AFTER trg_handle_new_user (same event, alphabetical order): the profile row must exist.
drop trigger if exists trg_z_welcome_email_insert on auth.users;
create trigger trg_z_welcome_email_insert after insert on auth.users
  for each row when (new.email_confirmed_at is not null)
  execute function public._trg_welcome_email();

drop trigger if exists trg_z_welcome_email_confirmed on auth.users;
create trigger trg_z_welcome_email_confirmed after update of email_confirmed_at on auth.users
  for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public._trg_welcome_email();

-- ─── 4. email_job_context: the 'welcome' branch (everything else is exactly as in 0033) ───
create or replace function public.email_job_context(p_job uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  j public.email_outbox;
  v_email text;
  v_name text;
  v_base jsonb;
  o public.orders; p public.payments; m public.memberships; b public.bookings; ob public.bookings;
  s public.class_sessions; os public.class_sessions;
  v_plan text; v_rid uuid;
begin
  select * into j from public.email_outbox where id = p_job;
  if not found then return jsonb_build_object('ok', false, 'skip_reason', 'job_not_found'); end if;
  select email, public._display_name(id) into v_email, v_name from public.profiles where id = j.user_id;
  if v_email is null or v_email like '%.invalid' then return jsonb_build_object('ok', false, 'skip_reason', 'no_recipient'); end if;

  v_base := jsonb_build_object('ok', true, 'template', j.template, 'to', v_email, 'member_name', v_name,
    'business', jsonb_build_object(
      'name', public._privacy_cfg('legal_entity_name'),
      'address', public._privacy_cfg('registered_address'),
      'contact_email', public._email_cfg('receipt_contact_email'),
      'contact_phone', public._email_cfg('receipt_contact_phone')));

  if j.template = 'payment_received' then
    select * into p from public.payments where order_id = j.related_id;
    if not found or p.status <> 'success' then return jsonb_build_object('ok', false, 'skip_reason', 'payment_not_successful'); end if;
    v_rid := public._issue_receipt(j.related_id);
    if v_rid is null then return jsonb_build_object('ok', false, 'skip_reason', 'no_receipt'); end if;
    return v_base || jsonb_build_object('receipt', public._receipt_json(v_rid));

  elsif j.template = 'order_confirmation' then
    select * into o from public.orders where id = j.related_id;
    select * into p from public.payments where order_id = j.related_id;
    if o.id is null then return jsonb_build_object('ok', false, 'skip_reason', 'order_not_found'); end if;
    return v_base || jsonb_build_object('order', jsonb_build_object(
      'reference', public._order_ref(o.id), 'status', o.status, 'payment_status', coalesce(p.status, 'created'),
      'total', o.total_amount, 'currency', o.currency, 'has_in_store', o.has_in_store,
      'collection_info', public._email_cfg('email_collection_info'),
      'items', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'quantity', quantity, 'unit_price', unit_price) order by created_at, id)
                         from public.order_items where order_id = o.id), '[]'::jsonb)));

  elsif j.template = 'membership_activated' then
    select * into m from public.memberships where id = j.related_id;
    if m.id is null or m.status <> 'active' then return jsonb_build_object('ok', false, 'skip_reason', 'membership_not_active'); end if;
    select name into v_plan from public.membership_plans where id = m.plan_id;
    return v_base || jsonb_build_object('membership', jsonb_build_object(
      'name', v_plan, 'credits', m.total_credits, 'start_date', m.start_date, 'end_date', m.end_date,
      'reschedules_allowed', m.reschedules_allowed));

  elsif j.template = 'booking_confirmed' then
    select * into b from public.bookings where id = j.related_id;
    if b.id is null or b.status not in ('held', 'confirmed', 'completed') then return jsonb_build_object('ok', false, 'skip_reason', 'booking_not_active'); end if;
    select * into s from public.class_sessions where id = b.session_id;
    return v_base || jsonb_build_object('booking', jsonb_build_object(
      'reference', public._booking_ref(b.id), 'status', b.status, 'date', s.session_date,
      'start_time', to_char(s.start_time, 'HH24:MI'), 'end_time', to_char(s.end_time, 'HH24:MI'),
      'arrival_info', public._email_cfg('email_arrival_info')));

  elsif j.template = 'reschedule_confirmed' then
    select * into b from public.bookings where id = j.related_id;
    if b.id is null or b.status not in ('held', 'confirmed', 'completed') then return jsonb_build_object('ok', false, 'skip_reason', 'booking_not_active'); end if;
    select * into ob from public.bookings where id = b.original_booking_id;
    if ob.id is null then return jsonb_build_object('ok', false, 'skip_reason', 'original_booking_missing'); end if;
    select * into s from public.class_sessions where id = b.session_id;
    select * into os from public.class_sessions where id = ob.session_id;
    return v_base || jsonb_build_object('booking', jsonb_build_object(
      'reference', public._booking_ref(b.id), 'status', b.status, 'date', s.session_date,
      'start_time', to_char(s.start_time, 'HH24:MI'), 'end_time', to_char(s.end_time, 'HH24:MI'),
      'arrival_info', public._email_cfg('email_arrival_info'),
      'original', jsonb_build_object('date', os.session_date, 'start_time', to_char(os.start_time, 'HH24:MI'), 'end_time', to_char(os.end_time, 'HH24:MI'))));

  elsif j.template = 'payment_pending' then
    select * into p from public.payments where id = j.related_id;
    -- Say "still verifying" only while it is. If it resolved either way, the resolution has its own message.
    if p.id is null or p.status not in ('created', 'pending', 'processing') then return jsonb_build_object('ok', false, 'skip_reason', 'payment_resolved'); end if;
    return v_base || jsonb_build_object('payment', jsonb_build_object(
      'amount', p.amount, 'currency', p.currency,
      'order_reference', case when p.order_id is null then null else public._order_ref(p.order_id) end,
      'started_at', p.created_at));
  elsif j.template = 'welcome' then
    -- Only the profile's own name. The address is never used as a name (v_name falls back to it, so it is not used here).
    return v_base || jsonb_build_object('welcome', jsonb_build_object(
      'display_name', (select nullif(trim(full_name), '') from public.profiles where id = j.user_id)));
  end if;
  return jsonb_build_object('ok', false, 'skip_reason', 'unknown_template');
end;
$$;

notify pgrst, 'reload schema';

commit;
