-- Phase 17 test: transactional email outbox, receipts, payment recovery (0033). Apply 0016–0033 first.
-- One transaction, ends in ROLLBACK. Uses isolated test users only (@example.invalid): never run this
-- against real members. It drives the REAL process_payment_webhook / fulfill_order / book_class /
-- reschedule_booking, so it proves the email layer against the real business functions.
-- Prints "ALL PHASE 17 CHECKS PASSED" on success.

begin;

create function pg_temp.q_as(p_uid uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute p_sql into v;
  exception when others then
    execute 'reset role';
    return 'ERR:' || sqlerrm;
  end;
  execute 'reset role';
  return v;
end $$;

create function pg_temp.q_anon(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role anon';
  begin
    execute p_sql into v;
  exception when others then
    execute 'reset role';
    return 'ERR:' || sqlerrm;
  end;
  execute 'reset role';
  return v;
end $$;

create function pg_temp.must(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL: %', p_msg; end if; end $$;

create function pg_temp.must_err(p_result text, p_code text, p_msg text) returns void language plpgsql as $$
begin
  if p_result is null or p_result not like ('ERR:' || p_code || '%') then
    raise exception 'FAIL: % (expected %, got %)', p_msg, p_code, coalesce(p_result, 'NULL');
  end if;
end $$;

-- One-line helpers over the outbox.
create function pg_temp.n_mail(p_template text, p_user uuid) returns bigint language sql as $$
  select count(*) from public.email_outbox where template = p_template and user_id = p_user $$;

do $$
declare
  a uuid := gen_random_uuid();     -- member who pays, books, reschedules
  b uuid := gen_random_uuid();     -- another member
  s uuid := gen_random_uuid();     -- staff
  adm uuid := gen_random_uuid();   -- admin
  e uuid := gen_random_uuid();     -- member with no usable email
  v text; v_prod uuid; v_plan_id uuid; v_credits int; r record;
  o1 uuid; p1 uuid; o_fail uuid; p_fail uuid; o_mis uuid; p_mis uuid; o_shop uuid; p_shop uuid; o_pend uuid; p_pend uuid;
  v_mem uuid; v_sess1 uuid; v_sess2 uuid; v_book uuid; v_book2 uuid; job uuid; job2 uuid; j jsonb;
  n_notif_before bigint; n_ledger bigint; n_receipts bigint;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select u, 'p17-' || left(u::text, 8) || '@example.invalid', '{"full_name":"Asha Rao"}', 'authenticated', 'authenticated'
  from unnest(array[a, b, s, adm, e]) u;
  -- The *.invalid placeholder is what erasure uses ("never deliverable"), so give the test members a normal-looking address.
  alter table public.profiles disable trigger trg_prevent_privilege_escalation;
  update public.profiles set email = 'asha-' || left(a::text, 8) || '@example.org', date_of_birth = '1990-01-01', full_name = 'Asha Rao' where id = a;
  update public.profiles set email = 'bela-' || left(b::text, 8) || '@example.org', date_of_birth = '1990-01-01' where id = b;
  update public.profiles set role = 'staff', email = 'staff-' || left(s::text, 8) || '@example.org' where id = s;
  update public.profiles set role = 'admin', email = 'admin-' || left(adm::text, 8) || '@example.org' where id = adm;
  update public.profiles set email = null where id = e;
  alter table public.profiles enable trigger trg_prevent_privilege_escalation;

  select sp.id, pl.id, pl.class_credits into v_prod, v_plan_id, v_credits
  from public.store_products sp join public.membership_plans pl on pl.id = sp.plan_id
  where sp.category = 'membership' and sp.is_active and pl.is_active and pl.price is not null
    and (pl.min_age is null or pl.min_age <= 35) and (pl.max_age is null or pl.max_age >= 35)
  order by pl.price limit 1;
  perform pg_temp.must(v_prod is not null, 'fixture: an adult membership product exists in the seed data');

  -- ── 1. Before any payment: nothing exists, a pending order sends nothing ──
  v := pg_temp.q_as(a, format($q$select (public.create_order(%L::jsonb)).order_id::text$q$, jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1))));
  o1 := v::uuid;
  select id into p1 from public.payments where order_id = o1;
  update public.payments set gateway_order_id = 'order_p17_ok' where id = p1;
  perform pg_temp.must((select count(*) from public.email_outbox where user_id = a) = 0, 'a pending order produces no email');
  perform pg_temp.must((select count(*) from public.payment_receipts where user_id = a) = 0, 'a pending order produces no receipt');
  perform pg_temp.must(public._issue_receipt(o1) is null, 'no receipt can be issued for an unpaid order');
  perform pg_temp.must(public.enqueue_payment_pending_email(p1) is true, 'an open payment can queue the one "still verifying" email');
  perform pg_temp.must(public.enqueue_payment_pending_email(p1) is false, 'but only once per payment');
  perform pg_temp.must((select count(*) from public.email_outbox where template = 'payment_pending' and related_id = p1) = 1, 'exactly one pending email row');
  j := public.email_job_context((select id from public.email_outbox where template = 'payment_pending' and related_id = p1));
  perform pg_temp.must((j ->> 'ok')::boolean and j #>> '{payment,amount}' = (select amount::text from public.payments where id = p1), 'pending email shows the real amount');
  update public.payments set created_at = now() - interval '30 minutes' where id = p1;
  perform pg_temp.must(exists (select 1 from public.payments_needing_reconciliation(10, 50) where payment_id = p1), 'an open Razorpay payment is a reconciliation candidate');

  -- ── 2. A FAILED payment: no success receipt, no payment email ─────────────
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select order_id, payment_id into o_fail, p_fail from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)));
  perform set_config('request.jwt.claims', '', true);
  update public.payments set gateway_order_id = 'order_p17_fail' where id = p_fail;
  perform public.process_payment_webhook('evt_fail_1', 'payment.failed', 'order_p17_fail', 'pay_fail_1', 'failed', null, null, '{}');
  perform pg_temp.must((select status from public.payments where id = p_fail) = 'failed', 'fixture: the payment is failed');
  perform pg_temp.must((select count(*) from public.payment_receipts where user_id = b) = 0, 'failed payment: no receipt');
  perform pg_temp.must((select count(*) from public.email_outbox where user_id = b) = 0, 'failed payment: no success or membership email');
  perform pg_temp.must((select count(*) from public.notifications where user_id = b and type = 'payment_failed') = 1, 'failed payment: the existing in-app notice still appears');

  -- ── 3. AMOUNT MISMATCH: flagged, not fulfilled, no receipt, no email ──────
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select order_id, payment_id into o_mis, p_mis from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)));
  perform set_config('request.jwt.claims', '', true);
  update public.payments set gateway_order_id = 'order_p17_mis' where id = p_mis;
  perform public.process_payment_webhook('evt_mis_1', 'payment.captured', 'order_p17_mis', 'pay_mis_1', 'success', 1.00, 'INR', '{}');
  perform pg_temp.must((select status from public.payments where id = p_mis) <> 'success', 'mismatch: not marked paid');
  perform pg_temp.must((select count(*) from public.payment_receipts where user_id = b) = 0 and (select count(*) from public.email_outbox where user_id = b) = 0, 'mismatch: no receipt and no email');

  -- ── 4. VERIFIED SUCCESS, then duplicates through every path ───────────────
  perform public.process_payment_webhook('evt_ok_1', 'payment.captured', 'order_p17_ok', 'pay_ok_1', 'success', (select amount from public.payments where id = p1), 'INR', '{}');
  select count(*) into n_ledger from public.credit_ledger where user_id = a;
  perform public.process_payment_webhook('evt_ok_1', 'payment.captured', 'order_p17_ok', 'pay_ok_1', 'success', (select amount from public.payments where id = p1), 'INR', '{}');      -- webhook delivered twice
  perform public.process_payment_webhook('sync:pay_ok_1', 'payment.captured (sync)', 'order_p17_ok', 'pay_ok_1', 'success', (select amount from public.payments where id = p1), 'INR', '{}'); -- the app's sync verify
  perform public.process_payment_webhook('reconcile:pay_ok_1', 'payment.captured (reconcile)', 'order_p17_ok', 'pay_ok_1', 'success', (select amount from public.payments where id = p1), 'INR', '{}'); -- recovery job
  perform pg_temp.must((select status from public.payments where id = p1) = 'success', 'payment is success');
  perform pg_temp.must((select count(*) from public.memberships where payment_id = p1) = 1, 'duplicates: exactly one membership');
  perform pg_temp.must((select count(*) from public.credit_ledger where user_id = a) = n_ledger and n_ledger = 1, 'duplicates: credits allocated once');
  perform pg_temp.must((select count(*) from public.payment_receipts where payment_id = p1) = 1, 'duplicates: exactly one receipt');
  perform pg_temp.must(pg_temp.n_mail('payment_received', a) = 1, 'duplicates: exactly one payment email');
  perform pg_temp.must(pg_temp.n_mail('membership_activated', a) = 1, 'duplicates: exactly one membership email');
  perform pg_temp.must(pg_temp.n_mail('order_confirmation', a) = 0, 'a membership-only order sends no shop order confirmation');
  perform pg_temp.must((select count(*) from public.notifications where user_id = a and type = 'payment_success') = 1
                   and (select count(*) from public.notifications where user_id = a and type = 'membership_activated') = 1, 'in-app notifications are unchanged: one each');
  perform pg_temp.must((select receipt_number from public.payment_receipts where payment_id = p1) ~ '^CHR-R-\d{4}-\d{6}$', 'receipt number format');

  -- Receipt = the authoritative transaction record.
  select * into r from public.payment_receipts where payment_id = p1;
  perform pg_temp.must(r.amount = (select amount from public.payments where id = p1) and r.currency = 'INR' and r.gateway_payment_id = 'pay_ok_1'
                       and r.paid_at = (select paid_at from public.payments where id = p1), 'receipt amount/currency/reference/date match the payment row');
  perform pg_temp.must(public._receipt_json(r.id) ->> 'document_type' = 'payment_receipt' and not (public._receipt_json(r.id) ? 'tax'), 'receipt is a payment receipt, with no tax fields invented');
  perform pg_temp.must((public._receipt_json(r.id) #>> '{business,gstin}') is null, 'GSTIN is absent unless configured');
  update public.system_settings set value = '"27ABCDE1234F1Z5"'::jsonb where key = 'receipt_gstin';
  perform pg_temp.must((public._receipt_json(r.id) #>> '{business,gstin}') = '27ABCDE1234F1Z5', 'a configured GSTIN is shown');
  update public.system_settings set value = '""'::jsonb where key = 'receipt_gstin';

  -- Contexts (what the email will say) come from the real records.
  job := (select id from public.email_outbox where template = 'payment_received' and user_id = a);
  j := public.email_job_context(job);
  perform pg_temp.must((j ->> 'ok')::boolean and j ->> 'to' = (select email from public.profiles where id = a) and j ->> 'member_name' = 'Asha Rao', 'payment context: recipient is the account address, name from the profile');
  perform pg_temp.must((j #>> '{receipt,amount}')::numeric = r.amount and j #>> '{receipt,order_reference}' = public._order_ref(o1), 'payment context: amount and order reference');
  j := public.email_job_context((select id from public.email_outbox where template = 'membership_activated' and user_id = a));
  select id into v_mem from public.memberships where payment_id = p1;
  perform pg_temp.must((j #>> '{membership,credits}')::int = (select total_credits from public.memberships where id = v_mem)
                   and (j #>> '{membership,credits}')::int = v_credits, 'membership context: credits are the granted credits');
  perform pg_temp.must((j #>> '{membership,start_date}')::date = (select start_date from public.memberships where id = v_mem)
                   and (j #>> '{membership,end_date}')::date = (select end_date from public.memberships where id = v_mem), 'membership context: real validity dates');
  perform pg_temp.must((j #>> '{membership,reschedules_allowed}')::int = (select reschedules_allowed from public.memberships where id = v_mem), 'membership context: reschedule allowance');
  -- The pending notice is now stale: the payment resolved, so it must NOT be sent.
  j := public.email_job_context((select id from public.email_outbox where template = 'payment_pending' and related_id = p1));
  perform pg_temp.must(not (j ->> 'ok')::boolean and j ->> 'skip_reason' = 'payment_resolved', 'a "still verifying" email is skipped once the payment resolved');
  perform pg_temp.must(public.enqueue_payment_pending_email(p1) is false, 'no pending email for a succeeded payment');
  perform pg_temp.must(not exists (select 1 from public.payments_needing_reconciliation(10, 50) where payment_id = p1), 'a succeeded payment is no longer a reconciliation candidate');

  -- A membership that is not active must not be announced.
  update public.memberships set status = 'suspended' where id = v_mem;
  j := public.email_job_context((select id from public.email_outbox where template = 'membership_activated' and user_id = a));
  perform pg_temp.must(not (j ->> 'ok')::boolean and j ->> 'skip_reason' = 'membership_not_active', 'no false activation email when the membership is not active');
  update public.memberships set status = 'active' where id = v_mem;

  -- ── 5. SHOP ORDER: order confirmation reflects the real payment ───────────
  select sp.id into v_prod from public.store_products sp where sp.category = 'tack' and sp.is_active and sp.price is not null limit 1;
  if v_prod is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
    select order_id, payment_id into o_shop, p_shop from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 2)));
    perform set_config('request.jwt.claims', '', true);
    update public.payments set gateway_order_id = 'order_p17_shop' where id = p_shop;
    perform pg_temp.must(pg_temp.n_mail('order_confirmation', a) = 0, 'unpaid shop order: no confirmation email');
    perform public.process_payment_webhook('evt_shop_1', 'payment.captured', 'order_p17_shop', 'pay_shop_1', 'success', (select amount from public.payments where id = p_shop), 'INR', '{}');
    perform public.process_payment_webhook('evt_shop_1', 'payment.captured', 'order_p17_shop', 'pay_shop_1', 'success', (select amount from public.payments where id = p_shop), 'INR', '{}');
    perform pg_temp.must(pg_temp.n_mail('order_confirmation', a) = 1 and pg_temp.n_mail('payment_received', a) = 2, 'paid shop order: one confirmation, one more payment email, none duplicated');
    j := public.email_job_context((select id from public.email_outbox where template = 'order_confirmation' and related_id = o_shop));
    perform pg_temp.must(j #>> '{order,payment_status}' = 'success' and (j #>> '{order,total}')::numeric = (select total_amount from public.orders where id = o_shop)
                     and jsonb_array_length(j #> '{order,items}') = 1 and (j #>> '{order,items,0,quantity}')::int = 2, 'order context: real status, total, items and quantities');
  end if;

  -- ── 6. BOOKING and RESCHEDULE, through the real functions ─────────────────
  select id into v_sess1 from public.class_sessions where status = 'open' and session_date > current_date + 3 order by session_date, start_time limit 1;
  select id into v_sess2 from public.class_sessions where status = 'open' and session_date > (select session_date from public.class_sessions where id = v_sess1) + 8 order by session_date, start_time limit 1;
  v := pg_temp.q_as(a, format($q$select (public.book_class(%L)).id::text$q$, v_sess1));
  perform pg_temp.must(v !~ '^ERR', 'fixture: booking succeeds (' || v || ')');
  v_book := v::uuid;
  perform pg_temp.must(pg_temp.n_mail('booking_confirmed', a) = 1, 'booking: one confirmation email');
  perform pg_temp.must(pg_temp.q_as(a, format($q$select (public.book_class(%L))::text$q$, v_sess1)) like 'ERR:%', 'a duplicate booking attempt fails');
  perform pg_temp.must(pg_temp.n_mail('booking_confirmed', a) = 1, 'failed booking: no extra confirmation');
  perform pg_temp.must((select count(*) from public.notifications where user_id = a and type = 'booking_confirmed') = 1, 'booking: in-app notification unchanged');
  j := public.email_job_context((select id from public.email_outbox where template = 'booking_confirmed' and related_id = v_book));
  perform pg_temp.must((j ->> 'ok')::boolean and (j #>> '{booking,date}')::date = (select session_date from public.class_sessions where id = v_sess1)
                   and j #>> '{booking,start_time}' = (select to_char(start_time, 'HH24:MI') from public.class_sessions where id = v_sess1)
                   and j #>> '{booking,reference}' = upper(left(replace(v_book::text, '-', ''), 8)) and j #>> '{booking,status}' = 'confirmed', 'booking context: real date, time, reference, status');

  -- A booking that is cancelled before the email is sent must not be "confirmed".
  begin
    update public.bookings set status = 'cancelled' where id = v_book;
    j := public.email_job_context((select id from public.email_outbox where template = 'booking_confirmed' and related_id = v_book));
    perform pg_temp.must(not (j ->> 'ok')::boolean and j ->> 'skip_reason' = 'booking_not_active', 'no confirmation for a booking that is no longer active');
    raise exception 'P17_ROLLBACK';
  exception when others then
    if sqlerrm <> 'P17_ROLLBACK' then raise; end if;
  end;

  if v_sess2 is not null then
    v := pg_temp.q_as(a, format($q$select (public.reschedule_booking(%L, %L)).id::text$q$, v_book, v_sess2));
    perform pg_temp.must(v !~ '^ERR', 'fixture: reschedule succeeds (' || v || ')');
    v_book2 := v::uuid;
    perform pg_temp.must(pg_temp.n_mail('reschedule_confirmed', a) = 1, 'reschedule: one email');
    j := public.email_job_context((select id from public.email_outbox where template = 'reschedule_confirmed' and related_id = v_book2));
    perform pg_temp.must((j ->> 'ok')::boolean
                     and (j #>> '{booking,original,date}')::date = (select session_date from public.class_sessions where id = v_sess1)
                     and (j #>> '{booking,date}')::date = (select session_date from public.class_sessions where id = v_sess2), 'reschedule context: old and new class');
    -- Rescheduling the already-replaced (cancelled) booking fails, and sends nothing.
    perform pg_temp.must(pg_temp.q_as(a, format($q$select (public.reschedule_booking(%L, %L))::text$q$, v_book, v_sess2)) like 'ERR:%', 'a failed reschedule errors');
    perform pg_temp.must(pg_temp.n_mail('reschedule_confirmed', a) = 1, 'failed reschedule: no confirmation');
  end if;

  -- ── 7. Email problems never reverse or block the business operation ───────
  select count(*) into n_notif_before from public.notifications where user_id = b and type = 'booking_confirmed';
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  -- Give member B a plan directly so the booking path can run, then make every outbox insert fail.
  insert into public.memberships (user_id, plan_id, status, start_date, end_date, total_credits, reschedules_allowed, reschedules_used)
    values (b, v_plan_id, 'active', current_date, current_date + 29, 8, 2, 0) returning id into v_mem;
  insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description) values (b, v_mem, 8, 'membership_purchase', 'p17');
  perform set_config('request.jwt.claims', '', true);
  alter table public.email_outbox add constraint p17_always_fails check (false) not valid;
  v := pg_temp.q_as(b, format($q$select (public.book_class(%L)).id::text$q$, v_sess1));
  alter table public.email_outbox drop constraint p17_always_fails;
  perform pg_temp.must(v !~ '^ERR', 'an outbox failure does not fail the booking (' || v || ')');
  perform pg_temp.must((select count(*) from public.bookings where user_id = b and status = 'confirmed') = 1, 'the booking is committed');
  perform pg_temp.must((select count(*) from public.notifications where user_id = b and type = 'booking_confirmed') = n_notif_before + 1, 'the in-app notification is still created');
  perform pg_temp.must(pg_temp.n_mail('booking_confirmed', b) = 0, 'and no email job exists for it');
  -- No usable address: business unaffected, no job, notification kept.
  perform public._notify_user(e, 'booking_confirmed', 'Booking confirmed', 'x', jsonb_build_object('booking_id', v_book));
  perform pg_temp.must((select count(*) from public.email_outbox where user_id = e) = 0, 'no address: no email job');
  perform pg_temp.must((select count(*) from public.notifications where user_id = e) >= 1, 'no address: in-app notification still there');

  -- ── 8. Delivery tracking and retries ──────────────────────────────────────
  job := (select id from public.email_outbox where template = 'payment_received' and related_id = o1);
  perform pg_temp.must((select status from public.email_outbox where id = job) = 'queued' and (select attempts from public.email_outbox where id = job) = 0, 'a new job is queued with no attempts');
  perform pg_temp.must((select count(*) from public.claim_email_jobs(10, job)) = 1, 'a due job is claimed');
  perform pg_temp.must((select status from public.email_outbox where id = job) = 'processing' and (select attempts from public.email_outbox where id = job) = 1
                   and (select last_attempt_at from public.email_outbox where id = job) is not null, 'claim: processing, attempt counted, time recorded');
  perform pg_temp.must((select count(*) from public.claim_email_jobs(10, job)) = 0, 'a job being processed cannot be claimed by a second worker');
  perform pg_temp.must(public.complete_email_job(job, 'transient', null, 'provider_unavailable') = 'retry_scheduled', 'transient failure schedules a retry');
  perform pg_temp.must((select next_attempt_at from public.email_outbox where id = job) > now() + interval '1 minute' and (select last_error_category from public.email_outbox where id = job) = 'provider_unavailable', 'backoff in the future, error category recorded');
  perform pg_temp.must((select count(*) from public.claim_email_jobs(10, job)) = 0, 'a retry is not claimed before its time');
  perform pg_temp.must(public.complete_email_job(job, 'sent', 'x', null) = 'retry_scheduled', 'a job that is not processing cannot be completed');
  update public.email_outbox set next_attempt_at = now() where id = job;
  perform pg_temp.must((select count(*) from public.claim_email_jobs(10, job)) = 1, 'the retry is claimed when due');
  perform pg_temp.must((select attempts from public.email_outbox where id = job) = 2, 'and counted as attempt 2');
  perform pg_temp.must(public.complete_email_job(job, 'sent', 'resend_msg_p17', null) = 'sent', 'success is recorded');
  perform pg_temp.must((select status from public.email_outbox where id = job) = 'sent' and (select provider_message_id from public.email_outbox where id = job) = 'resend_msg_p17'
                   and (select delivery_status from public.email_outbox where id = job) = 'accepted' and (select delivered_at from public.email_outbox where id = job) is null
                   and (select last_error_category from public.email_outbox where id = job) is null, 'accepted by the provider is NOT delivered');
  perform pg_temp.must(public.complete_email_job(job, 'permanent', null, 'x') = 'sent', 'a sent job cannot be turned into a failure');
  perform pg_temp.must((select count(*) from public.claim_email_jobs(10, job)) = 0, 'a sent job is never claimed again (no second email)');
  -- Provider events.
  perform pg_temp.must(public.record_email_provider_event('resend_msg_p17', 'email.delivered') is true, 'delivered event matched the message');
  perform pg_temp.must((select delivery_status from public.email_outbox where id = job) = 'delivered' and (select delivered_at from public.email_outbox where id = job) is not null, 'delivered is recorded with a time');
  perform public.record_email_provider_event('resend_msg_p17', 'email.delivery_delayed');
  perform pg_temp.must((select delivery_status from public.email_outbox where id = job) = 'delivered', 'a late "delayed" event does not undo "delivered"');
  perform pg_temp.must(public.record_email_provider_event('nope', 'email.delivered') is false and public.record_email_provider_event('resend_msg_p17', 'email.unknown') is false, 'unknown message or event is ignored');
  -- Permanent failure.
  job2 := (select id from public.email_outbox where template = 'membership_activated' and user_id = a);
  perform public.claim_email_jobs(10, job2);
  perform pg_temp.must(public.complete_email_job(job2, 'permanent', null, 'invalid_request') = 'failed', 'permanent failure ends the job');
  perform pg_temp.must((select last_error_category from public.email_outbox where id = job2) = 'invalid_request', 'its error category is recorded');
  perform pg_temp.must((select count(*) from public.claim_email_jobs(10, job2)) = 0, 'a failed job is not retried automatically');
  -- Bounded retries.
  update public.email_outbox set status = 'retry_scheduled', attempts = 4, next_attempt_at = now() where id = job2;
  perform public.claim_email_jobs(10, job2);
  perform pg_temp.must((select attempts from public.email_outbox where id = job2) = 5 and public.complete_email_job(job2, 'transient', null, 'rate_limited') = 'failed', 'transient failures stop after max_attempts');
  -- A crashed worker: lock expires, job is taken again; out of attempts it fails instead.
  update public.email_outbox set status = 'processing', attempts = 2, locked_until = now() - interval '1 minute' where id = job2;
  perform pg_temp.must((select count(*) from public.claim_email_jobs(10, job2)) = 1, 'an abandoned job is picked up again');
  perform pg_temp.must((select attempts from public.email_outbox where id = job2) = 3, 'with the attempt counted');
  update public.email_outbox set status = 'processing', attempts = 5, locked_until = now() - interval '1 minute' where id = job2;
  perform pg_temp.must((select count(*) from public.claim_email_jobs(10, job2)) = 0, 'an abandoned job with no attempts left is not retried');
  perform pg_temp.must((select status from public.email_outbox where id = job2) = 'failed' and (select last_error_category from public.email_outbox where id = job2) = 'worker_timeout', 'it is marked failed (worker_timeout)');
  perform pg_temp.must(public.complete_email_job(gen_random_uuid(), 'sent', null, null) = 'not_found', 'completing an unknown job is harmless');
  begin perform public.complete_email_job(job, 'bogus'); raise exception 'FAIL: bad outcome accepted'; exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;

  -- ── 9. Access control ─────────────────────────────────────────────────────
  -- Receipts: the owner and staff only. Others get the same answer as "no receipt".
  perform pg_temp.must(pg_temp.q_as(a, format($q$select public.my_receipt(%L) ->> 'receipt_number'$q$, o1)) = r.receipt_number, 'owner can open own receipt');
  perform pg_temp.must_err(pg_temp.q_as(b, format($q$select public.my_receipt(%L)::text$q$, o1)), 'RECEIPT_NOT_FOUND', 'another member cannot open it');
  perform pg_temp.must_err(pg_temp.q_as(b, format($q$select public.my_receipt(%L)::text$q$, gen_random_uuid())), 'RECEIPT_NOT_FOUND', 'same answer for an order that does not exist (no probing)');
  perform pg_temp.must(pg_temp.q_as(s, format($q$select public.my_receipt(%L) ->> 'receipt_number'$q$, o1)) = r.receipt_number, 'staff can open a receipt');
  perform pg_temp.must(pg_temp.q_anon(format($q$select public.my_receipt(%L)::text$q$, o1)) like 'ERR:%', 'anonymous callers cannot call my_receipt');
  perform pg_temp.must(pg_temp.q_as(a, 'select count(*)::text from public.payment_receipts') = '2' or pg_temp.q_as(a, 'select count(*)::text from public.payment_receipts') = '1', 'a member sees only own receipts via the table');
  perform pg_temp.must(pg_temp.q_as(b, 'select count(*)::text from public.payment_receipts') = '0', 'another member sees none of them via the table');
  perform pg_temp.must(pg_temp.q_as(a, format($q$update public.payment_receipts set amount = 1 where id = %L returning 'x'$q$, r.id)) is null or pg_temp.q_as(a, format($q$update public.payment_receipts set amount = 1 where id = %L returning 'x'$q$, r.id)) like 'ERR:%', 'a member cannot edit a receipt');
  perform pg_temp.must((select amount from public.payment_receipts where id = r.id) = r.amount, 'receipt amount unchanged');
  -- Outbox and worker functions are not reachable by members at all.
  perform pg_temp.must(pg_temp.q_as(a, 'select count(*)::text from public.email_outbox') like 'ERR:%permission denied%', 'members cannot read the outbox');
  perform pg_temp.must(pg_temp.q_as(s, 'select count(*)::text from public.email_outbox') like 'ERR:%permission denied%', 'staff cannot read the outbox table directly either');
  foreach v in array array[
    'select * from public.claim_email_jobs(5, null)',
    format('select public.complete_email_job(%L, ''sent'', ''x'', null)', job),
    format('select public.email_job_context(%L)::text', job),
    format('select public.enqueue_payment_pending_email(%L)::text', p1),
    'select count(*) from public.payments_needing_reconciliation(0, 5)',
    'select public.record_email_provider_event(''m'', ''email.delivered'')::text',
    format('select public._issue_receipt(%L)::text', o1)] loop
    perform pg_temp.must(pg_temp.q_as(a, v) like 'ERR:%permission denied%', 'a member cannot run: ' || left(v, 40));
    perform pg_temp.must(pg_temp.q_as(adm, v) like 'ERR:%permission denied%', 'not even an admin can run (service role only): ' || left(v, 40));
  end loop;
  perform pg_temp.must(pg_temp.q_as(a, format($q$insert into public.email_outbox (dedupe_key, template, user_id, related_type, related_id) values ('forged', 'payment_received', %L, 'order', %L)$q$, a, o1)) like 'ERR:%permission denied%', 'a member cannot forge an email job');
  perform pg_temp.must(pg_temp.q_as(a, format($q$insert into public.payment_receipts (receipt_number, payment_id, order_id, user_id, amount, currency, paid_at) values ('FAKE', %L, %L, %L, 1, 'INR', now())$q$, p_fail, o_fail, a)) like 'ERR:%permission denied%', 'a member cannot forge a receipt');
  -- Staff view and retry.
  perform pg_temp.must_err(pg_temp.q_as(a, 'select count(*)::text from public.admin_email_deliveries()'), 'FORBIDDEN', 'members cannot use the staff delivery view');
  perform pg_temp.must((pg_temp.q_as(s, 'select count(*)::text from public.admin_email_deliveries()'))::int >= 3, 'staff can see deliveries');
  v := pg_temp.q_as(s, 'select string_agg(recipient_hint, '','') from public.admin_email_deliveries()');
  perform pg_temp.must(v !~ 'asha-' and v ~ '@example\.org', 'staff see only a masked address');
  perform pg_temp.must_err(pg_temp.q_as(s, format($q$select public.admin_retry_email(%L)$q$, job2)), 'FORBIDDEN', 'staff cannot retry');
  perform pg_temp.must_err(pg_temp.q_as(a, format($q$select public.admin_retry_email(%L)$q$, job2)), 'FORBIDDEN', 'members cannot retry');
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select public.admin_retry_email(%L)$q$, job)), 'NOT_RETRYABLE', 'an already-sent email cannot be re-sent');
  select count(*) into n_ledger from public.credit_ledger;
  select count(*) into n_receipts from public.payment_receipts;
  perform pg_temp.must(pg_temp.q_as(adm, format($q$select public.admin_retry_email(%L)$q$, job2)) = 'queued', 'an administrator can retry a failed email');
  perform pg_temp.must((select status from public.email_outbox where id = job2) = 'queued' and (select attempts from public.email_outbox where id = job2) = 0, 'the job is queued again');
  perform pg_temp.must((select count(*) from public.email_outbox where template = 'membership_activated' and user_id = a) = 1, 'retry reuses the same job: no second email row');
  perform pg_temp.must((select count(*) from public.credit_ledger) = n_ledger and (select count(*) from public.payment_receipts) = n_receipts
                   and (select count(*) from public.memberships where payment_id = p1) = 1 and (select status from public.payments where id = p1) = 'success', 'retrying an email changes no payment, credit, receipt or membership');
  perform pg_temp.must(exists (select 1 from public.audit_logs where table_name = 'email_outbox' and record_id = job2 and action = 'EMAIL_RETRY_REQUESTED'), 'the retry is audited');
  -- A bounced address is not retryable.
  perform public.complete_email_job(job2, 'sent', 'resend_msg_p17b', null);
  update public.email_outbox set status = 'failed', delivery_status = 'bounced' where id = job2;
  perform pg_temp.must_err(pg_temp.q_as(adm, format($q$select public.admin_retry_email(%L)$q$, job2)), 'NOT_RETRYABLE', 'a bounced address is not retried');
  perform pg_temp.must((select can_retry from public.admin_email_deliveries('failed', 10) where id = job2) is false, 'the staff view shows it is not retryable');

  -- ── 9b. Erasure leaves no address trace in the email log ─────────────────
  perform pg_temp.must((select count(*) from public.email_outbox where user_id = a and recipient_hint is not null) > 0, 'fixture: the log has a masked hint for the member');
  alter table public.profiles disable trigger trg_prevent_privilege_escalation;
  update public.profiles set email = 'erased-' || a || '@erased.invalid' where id = a;
  alter table public.profiles enable trigger trg_prevent_privilege_escalation;
  perform pg_temp.must((select count(*) from public.email_outbox where user_id = a and recipient_hint is not null) = 0, 'erased account: the masked hint is cleared');
  j := public.email_job_context((select id from public.email_outbox where template = 'booking_confirmed' and user_id = a));
  perform pg_temp.must(not (j ->> 'ok')::boolean and j ->> 'skip_reason' = 'no_recipient', 'erased account: queued emails are skipped, never sent to the placeholder');

  -- ── 10. Push is untouched: a notification still queues a push dispatch path ─
  perform pg_temp.must(exists (select 1 from pg_trigger where tgname = 'trg_notification_push') and exists (select 1 from pg_trigger where tgname = 'trg_notification_email'), 'both the push and email triggers exist side by side');

  raise notice 'ALL PHASE 17 CHECKS PASSED';
end $$;

rollback;
