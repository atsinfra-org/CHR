-- Reverses 0034_welcome_email.sql. Run in the Supabase SQL Editor.
--
-- EMAIL HISTORY IS KEPT. No welcome row is deleted. Welcome jobs still waiting (queued / retry) are marked 'skipped'
-- (error category feature_rolled_back) so nothing tries to send them without the welcome code.
-- Constraints: if any welcome row exists, email_outbox keeps ALLOWING the values 'welcome' and 'user'. They are the
-- only way those rows (and their later delivery updates) stay valid: a NOT VALID narrow constraint still rejects any
-- UPDATE of an old welcome row, which would break the Resend delivery webhook for it. No new welcome job can be queued
-- once the triggers are gone. With no welcome rows at all, the original narrow constraints are restored exactly.
begin;
drop trigger if exists trg_z_welcome_email_insert on auth.users;
drop trigger if exists trg_z_welcome_email_confirmed on auth.users;
drop function if exists public._trg_welcome_email();
drop function if exists public._queue_welcome_email(uuid, timestamptz);
drop function if exists public._welcome_start();
delete from public.system_settings where key = 'welcome_email_start';
update public.email_outbox set status = 'skipped', last_error_category = 'feature_rolled_back', locked_until = null, updated_at = now()
  where template = 'welcome' and status in ('queued', 'retry_scheduled', 'processing');

do $$
begin
  if exists (select 1 from public.email_outbox where template = 'welcome') then
    raise notice '0034 down: welcome rows exist, so email_outbox keeps allowing template welcome / related_type user (history preserved).';
  else
    alter table public.email_outbox drop constraint if exists email_outbox_template_check;
    alter table public.email_outbox add constraint email_outbox_template_check check (template in
      ('payment_received', 'membership_activated', 'booking_confirmed', 'reschedule_confirmed',
       'order_confirmation', 'payment_pending'));
    alter table public.email_outbox drop constraint if exists email_outbox_related_type_check;
    alter table public.email_outbox add constraint email_outbox_related_type_check check (related_type in
      ('payment', 'order', 'membership', 'booking'));
  end if;
end $$;

-- email_job_context exactly as 0033 defined it
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

notify pgrst, 'reload schema';
commit;
