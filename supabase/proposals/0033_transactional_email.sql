-- Transactional email, digital receipts and payment recovery.
-- Requires 0016–0032. Runs in one transaction; safe to run more than once.
-- NOT APPLIED: review, then run in the Supabase SQL editor. Nothing here sends an email until
-- the email-send Edge Function is deployed and the Vault secrets at the end of this file exist.
--
-- Design (mirrors the push-alert design in 0026):
--  * The authoritative business events are the member notifications the existing functions already
--    write INSIDE the same transaction as the payment / activation / booking / reschedule:
--      payment_success -> payment_received (+ order_confirmation when the order has shop items)
--      membership_activated, booking_confirmed, reschedule_confirmed
--    A rolled-back operation never writes its notification, so it never produces an email.
--  * An AFTER INSERT trigger turns each of those into ONE durable email_outbox row. The row's
--    dedupe_key is derived from the business record (order / membership / booking id), and is UNIQUE,
--    so webhook retries, sync+webhook double processing and job retries cannot create a second email.
--  * email-send claims jobs (FOR UPDATE SKIP LOCKED), renders from email_job_context() (database
--    records, never client input), sends through Resend and records the outcome. Transient failures
--    back off and retry up to max_attempts; permanent ones are recorded and stop.
--  * Email state is independent of the in-app notification and of push: nothing in this file edits,
--    deletes or gates a notification, a payment, a membership, a credit or a booking.
--  * Every trigger step runs in its own sub-transaction with an exception handler: a failure to
--    enqueue an email can never fail or roll back the booking / payment around it.
--
-- Not stored: the recipient's email address. It is read from profiles at send time, so an address
-- change is honoured and an erased account (placeholder *.invalid address) is skipped. Only a masked
-- hint is kept for staff.

begin;

-- ─── 1. Settings the receipts/emails read (blank = not configured = not shown) ──
insert into public.system_settings (key, value, description) values
  ('receipt_contact_email',  '""'::jsonb, 'Club contact email shown on receipts and emails. Blank hides it.'),
  ('receipt_contact_phone',  '""'::jsonb, 'Club contact phone shown on receipts and emails. Blank hides it.'),
  ('receipt_gstin',          '""'::jsonb, 'The club''s GSTIN, shown on receipts ONLY when filled in. Receipts are never labelled tax invoices by the system.'),
  ('email_arrival_info',     '""'::jsonb, 'Arrival information added to class confirmation emails (for example where to report and how early). Blank hides it.'),
  ('email_collection_info',  '""'::jsonb, 'Collection instructions added to shop order emails. Blank hides it.')
on conflict (key) do nothing;

create or replace function public._email_cfg(p_key text)
returns text language sql stable security definer set search_path = public as $$
  select nullif(trim(value #>> '{}'), '') from public.system_settings where key = p_key;
$$;
revoke execute on function public._email_cfg(text) from public, anon, authenticated;

create or replace function public._order_ref(p_order uuid)
returns text language sql immutable set search_path = public as $$
  select 'CHR-' || upper(left(replace(p_order::text, '-', ''), 8));
$$;
create or replace function public._booking_ref(p_booking uuid)
returns text language sql immutable set search_path = public as $$
  -- Same short reference the app shows (shortRef in the mobile app's schedule-format.ts).
  select upper(left(replace(p_booking::text, '-', ''), 8));
$$;
revoke execute on function public._order_ref(uuid), public._booking_ref(uuid) from public, anon, authenticated;

-- ─── 2. Receipts ────────────────────────────────────────────────────────────
-- One per successful payment (unique). A PAYMENT RECEIPT, never a tax invoice: no tax amounts or
-- invoice numbers are computed or invented. Amount/currency are copied from the verified payment row.
create sequence if not exists public.payment_receipt_seq;

create table if not exists public.payment_receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_number text not null unique,
  payment_id uuid not null unique references public.payments(id),
  order_id uuid not null references public.orders(id),
  user_id uuid not null references public.profiles(id),
  amount numeric(10,2) not null check (amount > 0),
  currency text not null,
  paid_at timestamptz not null,
  gateway_payment_id text,
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_payment_receipts_user on public.payment_receipts (user_id, paid_at desc);

alter table public.payment_receipts enable row level security;
drop policy if exists "Members read own receipts" on public.payment_receipts;
create policy "Members read own receipts" on public.payment_receipts
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "Staff read all receipts" on public.payment_receipts;
create policy "Staff read all receipts" on public.payment_receipts
  for select to authenticated using (public.is_staff_or_admin());
revoke all on public.payment_receipts from anon;
revoke insert, update, delete, truncate on public.payment_receipts from authenticated;

-- Idempotent: returns the existing receipt on every later call. Only for a payment the existing
-- webhook flow has already marked 'success'; anything else returns null.
create or replace function public._issue_receipt(p_order_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_pay public.payments;
  v_id uuid;
begin
  select * into v_pay from public.payments where order_id = p_order_id and status = 'success';
  if not found or v_pay.paid_at is null then return null; end if;

  select id into v_id from public.payment_receipts where payment_id = v_pay.id;
  if v_id is not null then return v_id; end if;

  insert into public.payment_receipts
    (receipt_number, payment_id, order_id, user_id, amount, currency, paid_at, gateway_payment_id, items)
  values (
    'CHR-R-' || to_char(v_pay.paid_at at time zone 'Asia/Kolkata', 'YYYY') || '-' || lpad(nextval('public.payment_receipt_seq')::text, 6, '0'),
    v_pay.id, p_order_id, v_pay.user_id, v_pay.amount, v_pay.currency, v_pay.paid_at, v_pay.gateway_payment_id,
    coalesce((select jsonb_agg(jsonb_build_object('name', name, 'quantity', quantity, 'unit_price', unit_price) order by created_at, id)
              from public.order_items where order_id = p_order_id), '[]'::jsonb))
  on conflict (payment_id) do nothing
  returning id into v_id;

  if v_id is null then select id into v_id from public.payment_receipts where payment_id = v_pay.id; end if;
  return v_id;
end;
$$;
revoke execute on function public._issue_receipt(uuid) from public, anon, authenticated;

create or replace function public._receipt_json(p_receipt uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'document_type', 'payment_receipt',            -- never 'tax_invoice'
    'receipt_number', r.receipt_number,
    'status', 'paid',
    'paid_at', r.paid_at,
    'amount', r.amount,
    'currency', r.currency,
    'payment_reference', r.gateway_payment_id,
    'order_reference', public._order_ref(r.order_id),
    'order_id', r.order_id,
    'member_name', public._display_name(r.user_id),
    'items', r.items,
    'business', jsonb_build_object(
      'name', public._privacy_cfg('legal_entity_name'),
      'address', public._privacy_cfg('registered_address'),
      'gstin', public._email_cfg('receipt_gstin'),
      'contact_email', public._email_cfg('receipt_contact_email'),
      'contact_phone', public._email_cfg('receipt_contact_phone')))
  from public.payment_receipts r where r.id = p_receipt;
$$;
revoke execute on function public._receipt_json(uuid) from public, anon, authenticated;

-- A member's own receipt for an order (staff can read any). Anyone else gets the same "not found"
-- answer as for an order that has no receipt, so ids cannot be probed.
create or replace function public.my_receipt(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_r public.payment_receipts;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_r from public.payment_receipts where order_id = p_order_id;
  if not found or (v_r.user_id <> auth.uid() and not public.is_staff_or_admin()) then
    raise exception 'RECEIPT_NOT_FOUND';
  end if;
  return public._receipt_json(v_r.id);
end;
$$;
revoke execute on function public.my_receipt(uuid) from public, anon;
grant execute on function public.my_receipt(uuid) to authenticated;

-- ─── 3. Outbox ──────────────────────────────────────────────────────────────
create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  -- One email per business event. Derived from the business record, never random.
  dedupe_key text not null unique,
  template text not null check (template in
    ('payment_received', 'membership_activated', 'booking_confirmed', 'reschedule_confirmed',
     'order_confirmation', 'payment_pending')),
  user_id uuid not null references public.profiles(id) on delete cascade,
  recipient_hint text,                                  -- masked, for staff; the address itself is read at send time
  related_type text not null check (related_type in ('payment', 'order', 'membership', 'booking')),
  related_id uuid not null,
  notification_id uuid references public.notifications(id) on delete set null,
  -- queued -> processing -> sent | retry_scheduled -> processing ... | failed | skipped
  status text not null default 'queued' check (status in ('queued', 'processing', 'sent', 'retry_scheduled', 'failed', 'skipped')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  provider_message_id text,
  -- What the provider reported AFTER accepting the message. 'accepted' is NOT 'delivered'.
  delivery_status text check (delivery_status in ('accepted', 'delayed', 'delivered', 'bounced', 'complained', 'rejected')),
  last_attempt_at timestamptz,
  last_error_category text,                              -- e.g. provider_unavailable, rate_limited, invalid_recipient, not_configured
  sent_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_email_outbox_due on public.email_outbox (next_attempt_at)
  where status in ('queued', 'retry_scheduled', 'processing');
create index if not exists idx_email_outbox_related on public.email_outbox (related_type, related_id);
create unique index if not exists uq_email_outbox_provider_msg on public.email_outbox (provider_message_id) where provider_message_id is not null;

alter table public.email_outbox enable row level security;
-- No policies: members and staff never read it through the API. Staff use admin_email_deliveries().
revoke all on public.email_outbox from anon, authenticated;

create or replace function public._mask_email(p_email text)
returns text language sql immutable set search_path = public as $$
  select case when p_email is null or position('@' in p_email) < 2 then null
              else left(p_email, 1) || '***' || substr(p_email, position('@' in p_email)) end;
$$;
revoke execute on function public._mask_email(text) from public, anon, authenticated;

-- Never raises. Returns true when a new job was created, false when the event already has one.
create or replace function public._enqueue_email(
  p_template text, p_dedupe text, p_user uuid, p_related_type text, p_related_id uuid, p_notification uuid default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_id uuid;
begin
  select email into v_email from public.profiles where id = p_user;
  -- No usable address (or an erased account): no job. The in-app notification is unaffected.
  if v_email is null or v_email like '%.invalid' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return false;
  end if;
  insert into public.email_outbox (dedupe_key, template, user_id, recipient_hint, related_type, related_id, notification_id)
  values (p_dedupe, p_template, p_user, public._mask_email(v_email), p_related_type, p_related_id, p_notification)
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id is not null;
end;
$$;
revoke execute on function public._enqueue_email(text, text, uuid, text, uuid, uuid) from public, anon, authenticated;

-- Erasure (0031) replaces the profile email with a never-deliverable *.invalid placeholder and keeps the
-- profile row. When that happens, the masked hint kept for staff is cleared too, and queued emails are
-- skipped (email_job_context returns no_recipient), so no trace of the address stays in the email log.
create or replace function public._trg_profile_email_erased()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.email_outbox set recipient_hint = null where user_id = new.id and recipient_hint is not null;
  return new;
end;
$$;
revoke execute on function public._trg_profile_email_erased() from public, anon, authenticated;
drop trigger if exists trg_profile_email_erased on public.profiles;
create trigger trg_profile_email_erased after update of email on public.profiles
  for each row when (new.email like '%.invalid' and old.email is distinct from new.email)
  execute function public._trg_profile_email_erased();

-- ─── 4. Event hook: authoritative notification -> email job (+ receipt) ─────
create or replace function public._trg_notification_email()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ref uuid;
begin
  begin
    v_ref := nullif(new.data ->> case new.type
        when 'payment_success' then 'order_id'
        when 'membership_activated' then 'membership_id'
        else 'booking_id' end, '')::uuid;
    if v_ref is null then return new; end if;

    if new.type = 'payment_success' then
      -- fulfill_order() writes this only after process_payment_webhook() marked the payment 'success'.
      perform public._issue_receipt(v_ref);
      perform public._enqueue_email('payment_received', 'payment.succeeded:' || v_ref, new.user_id, 'order', v_ref, new.id);
      if exists (select 1 from public.order_items where order_id = v_ref and category in ('tack', 'cafe')) then
        perform public._enqueue_email('order_confirmation', 'order.confirmed:' || v_ref, new.user_id, 'order', v_ref, new.id);
      end if;
    elsif new.type = 'membership_activated' then
      perform public._enqueue_email('membership_activated', 'membership.activated:' || v_ref, new.user_id, 'membership', v_ref, new.id);
    elsif new.type = 'booking_confirmed' then
      perform public._enqueue_email('booking_confirmed', 'booking.created:' || v_ref, new.user_id, 'booking', v_ref, new.id);
    elsif new.type = 'reschedule_confirmed' then
      perform public._enqueue_email('reschedule_confirmed', 'booking.rescheduled:' || v_ref, new.user_id, 'booking', v_ref, new.id);
    end if;
  exception when others then
    -- Email is best-effort: the booking / payment / activation must still commit.
    raise warning 'email enqueue skipped: %', sqlerrm;
  end;
  return new;
end;
$$;
revoke execute on function public._trg_notification_email() from public, anon, authenticated;

drop trigger if exists trg_notification_email on public.notifications;
create trigger trg_notification_email after insert on public.notifications
  for each row when (new.audience = 'user'
                     and new.type in ('payment_success', 'membership_activated', 'booking_confirmed', 'reschedule_confirmed'))
  execute function public._trg_notification_email();

-- ─── 5. Hand-off to email-send (same pattern as _push_dispatch) ─────────────
-- pg_net sends only after the surrounding transaction commits. Does nothing until the Vault secrets
-- exist. Never raises.
create or replace function public._email_dispatch(p_job uuid default null, p_kind text default 'email')
returns void language plpgsql security definer set search_path = public as $$
declare
  v_url text;
  v_secret text;
begin
  begin
    select decrypted_secret into v_url from vault.decrypted_secrets
      where name = case p_kind when 'reconcile' then 'payment_reconcile_url' else 'email_send_url' end;
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'email_send_secret';
    if v_url is null or v_secret is null then return; end if;
    perform net.http_post(
      url := v_url,
      body := case when p_job is null then jsonb_build_object('sweep', true) else jsonb_build_object('job_id', p_job) end,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-email-secret', v_secret),
      timeout_milliseconds := 10000);
  exception when others then
    raise warning 'email dispatch skipped: %', sqlerrm;
  end;
end;
$$;
revoke execute on function public._email_dispatch(uuid, text) from public, anon, authenticated;

create or replace function public._trg_email_outbox_dispatch()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public._email_dispatch(new.id);
  return new;
end;
$$;
revoke execute on function public._trg_email_outbox_dispatch() from public, anon, authenticated;
drop trigger if exists trg_email_outbox_dispatch on public.email_outbox;
create trigger trg_email_outbox_dispatch after insert on public.email_outbox
  for each row when (new.status = 'queued') execute function public._trg_email_outbox_dispatch();

-- ─── 6. Worker functions (service role only) ────────────────────────────────
-- Claims due jobs. FOR UPDATE SKIP LOCKED means two workers never take the same job. A job whose
-- worker died (lock expired) is taken again, unless it is out of attempts, in which case it fails.
create or replace function public.claim_email_jobs(p_limit int default 10, p_job uuid default null)
returns setof public.email_outbox language plpgsql security definer set search_path = public as $$
begin
  update public.email_outbox
  set status = 'failed', last_error_category = 'worker_timeout', locked_until = null
  where status = 'processing' and locked_until < now() and attempts >= max_attempts
    and (p_job is null or id = p_job);

  return query
  with due as (
    select id from public.email_outbox
    where (p_job is null or id = p_job)
      and ((status in ('queued', 'retry_scheduled') and next_attempt_at <= now())
           or (status = 'processing' and locked_until < now()))
    order by next_attempt_at
    limit greatest(1, least(coalesce(p_limit, 10), 50))
    for update skip locked)
  update public.email_outbox o
  set status = 'processing', attempts = o.attempts + 1, locked_until = now() + interval '5 minutes',
      last_attempt_at = now(), updated_at = now()
  from due where o.id = due.id
  returning o.*;
end;
$$;

-- Records the outcome of ONE claimed attempt. Only a 'processing' job can be completed, so a late or
-- duplicate report cannot undo a 'sent'.
--   sent       provider accepted it
--   transient  try again later (backoff 4, 8, 16, 32 minutes), failed once max_attempts is used
--   permanent  will never succeed as it stands (bad address, rejected by the provider, bad config)
--   skipped    the business record no longer justifies the email (never send a false confirmation)
create or replace function public.complete_email_job(
  p_id uuid, p_outcome text, p_message_id text default null, p_error_category text default null
) returns text language plpgsql security definer set search_path = public as $$
declare
  v_job public.email_outbox;
begin
  if p_outcome not in ('sent', 'transient', 'permanent', 'skipped') then raise exception 'INVALID_OUTCOME'; end if;
  select * into v_job from public.email_outbox where id = p_id for update;
  if not found or v_job.status <> 'processing' then return coalesce(v_job.status, 'not_found'); end if;

  if p_outcome = 'sent' then
    update public.email_outbox set status = 'sent', sent_at = now(), provider_message_id = p_message_id,
      delivery_status = 'accepted', last_error_category = null, locked_until = null, updated_at = now() where id = p_id;
    return 'sent';
  elsif p_outcome = 'skipped' then
    update public.email_outbox set status = 'skipped', last_error_category = left(p_error_category, 60), locked_until = null, updated_at = now() where id = p_id;
    return 'skipped';
  elsif p_outcome = 'transient' and v_job.attempts < v_job.max_attempts then
    update public.email_outbox set status = 'retry_scheduled', last_error_category = left(p_error_category, 60), locked_until = null,
      next_attempt_at = now() + make_interval(mins => least(power(2, v_job.attempts + 1)::int, 360)), updated_at = now() where id = p_id;
    return 'retry_scheduled';
  else
    update public.email_outbox set status = 'failed', last_error_category = left(coalesce(p_error_category, p_outcome), 60),
      locked_until = null, updated_at = now() where id = p_id;
    return 'failed';
  end if;
end;
$$;

-- Provider delivery events (Resend webhook). Tracks what happened AFTER acceptance. Never moves a
-- job's send status and never downgrades 'delivered'.
create or replace function public.record_email_provider_event(p_message_id text, p_event text)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_ds text := case p_event
    when 'email.delivered' then 'delivered' when 'email.delivery_delayed' then 'delayed'
    when 'email.bounced' then 'bounced' when 'email.complained' then 'complained'
    when 'email.failed' then 'rejected' when 'email.suppressed' then 'rejected' end;
begin
  if v_ds is null or p_message_id is null then return false; end if;
  update public.email_outbox
  set delivery_status = v_ds,
      delivered_at = case when v_ds = 'delivered' then coalesce(delivered_at, now()) else delivered_at end,
      last_error_category = case when v_ds in ('bounced', 'complained', 'rejected') then v_ds else last_error_category end,
      updated_at = now()
  where provider_message_id = p_message_id
    and not (delivery_status = 'delivered' and v_ds = 'delayed');
  return found;
end;
$$;

-- Everything an email shows, read from the database records for one job. Returns
--   {ok:false, skip_reason}  when the record no longer justifies this email, or
--   {ok:true, ...fields}     otherwise.
-- The client never supplies any of it. Also returns the member's CURRENT address for the sender.
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
  end if;
  return jsonb_build_object('ok', false, 'skip_reason', 'unknown_template');
end;
$$;

-- ─── 7. Payment recovery (service role only; used by payment-reconcile) ─────
-- Payments the gateway may have taken money for but the database still shows as open.
-- Only ones that have a Razorpay order, are older than p_min_age_minutes, and are younger than 7 days.
create or replace function public.payments_needing_reconciliation(p_min_age_minutes int default 10, p_limit int default 50)
returns table (payment_id uuid, order_id uuid, gateway_order_id text, amount numeric, currency text, status text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.order_id, p.gateway_order_id, p.amount, p.currency, p.status, p.created_at
  from public.payments p
  where p.gateway = 'razorpay' and p.gateway_order_id is not null
    and p.status in ('created', 'pending', 'processing')
    and p.created_at < now() - make_interval(mins => greatest(p_min_age_minutes, 1))
    and p.created_at > now() - interval '7 days'
  order by p.created_at
  limit least(coalesce(p_limit, 50), 200);
$$;

-- At most one "still verifying" email per payment (dedupe key). Only while the payment is unresolved.
create or replace function public.enqueue_payment_pending_email(p_payment_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  p public.payments;
begin
  select * into p from public.payments where id = p_payment_id;
  if not found or p.status not in ('created', 'pending', 'processing') then return false; end if;
  return public._enqueue_email('payment_pending', 'payment.verification_pending:' || p.id, p.user_id, 'payment', p.id, null);
end;
$$;

-- ─── 8. Staff view and safe retry ───────────────────────────────────────────
create or replace function public.admin_email_deliveries(p_status text default null, p_limit int default 50)
returns table (
  id uuid, template text, related_type text, related_id uuid, recipient_hint text, status text,
  delivery_status text, attempts int, max_attempts int, last_attempt_at timestamptz, last_error_category text,
  next_attempt_at timestamptz, sent_at timestamptz, can_retry boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff_or_admin() then raise exception 'FORBIDDEN'; end if;
  return query
  select e.id, e.template, e.related_type, e.related_id, e.recipient_hint, e.status, e.delivery_status,
         e.attempts, e.max_attempts, e.last_attempt_at, e.last_error_category, e.next_attempt_at, e.sent_at,
         (e.status in ('failed', 'retry_scheduled') and coalesce(e.delivery_status, '') not in ('bounced', 'complained')),
         e.created_at
  from public.email_outbox e
  where (p_status is null or e.status = p_status)
  order by e.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

-- Administrators only. Re-queues the EMAIL job; it touches nothing else: no payment, credit,
-- membership or booking function is called, and the dedupe key is unchanged so no second job exists.
create or replace function public.admin_retry_email(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_job public.email_outbox;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  select * into v_job from public.email_outbox where id = p_id for update;
  if not found then raise exception 'EMAIL_NOT_FOUND'; end if;
  if v_job.status not in ('failed', 'retry_scheduled') or coalesce(v_job.delivery_status, '') in ('bounced', 'complained') then
    raise exception 'NOT_RETRYABLE';
  end if;
  update public.email_outbox set status = 'queued', attempts = 0, next_attempt_at = now(), locked_until = null, updated_at = now()
  where id = p_id;
  perform public._audit('email_outbox', p_id, 'EMAIL_RETRY_REQUESTED',
    jsonb_build_object('status', v_job.status, 'error', v_job.last_error_category), jsonb_build_object('status', 'queued'));
  perform public._email_dispatch(p_id);
  return 'queued';
end;
$$;

-- ─── 9. Grants ──────────────────────────────────────────────────────────────
revoke execute on function public.claim_email_jobs(int, uuid) from public, anon, authenticated;
revoke execute on function public.complete_email_job(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.record_email_provider_event(text, text) from public, anon, authenticated;
revoke execute on function public.email_job_context(uuid) from public, anon, authenticated;
revoke execute on function public.payments_needing_reconciliation(int, int) from public, anon, authenticated;
revoke execute on function public.enqueue_payment_pending_email(uuid) from public, anon, authenticated;
revoke execute on function public.admin_email_deliveries(text, int) from public, anon;
revoke execute on function public.admin_retry_email(uuid) from public, anon;
grant execute on function public.admin_email_deliveries(text, int) to authenticated;
grant execute on function public.admin_retry_email(uuid) to authenticated;

-- ─── 10. Sweeps (UTC). Skipped, not failed, if pg_cron is unavailable. ──────
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron unavailable (%); enable it in Database > Extensions and re-run this block.', sqlerrm;
    return;
  end;
  perform cron.schedule('chr-email-sweep', '*/5 * * * *', 'select public._email_dispatch(null)');
  perform cron.schedule('chr-payment-reconcile', '*/10 * * * *', $c$select public._email_dispatch(null, 'reconcile')$c$);
end $$;

notify pgrst, 'reload schema';

commit;

-- ─── To switch email on (after deploying email-send and payment-reconcile), run once — not part of this file: ──
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/email-send', 'email_send_url');
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/payment-reconcile', 'payment_reconcile_url');
--   select vault.create_secret('<the same random value as the EMAIL_FUNCTION_SECRET function secret>', 'email_send_secret');
-- To switch it off again: delete those rows from vault.secrets. Jobs stay queued and send when it is back on.
