-- Phase 18 test: processing the same captured payment again changes NOTHING. Requires 0016-0033.
-- Ends in ROLLBACK and uses isolated test members only (@example.invalid / example.org). It drives the REAL
-- process_payment_webhook / fulfill_order and the real email outbox, never a copy.
--
-- DO NOT RUN ON PRODUCTION. It disables a profile trigger for a moment (inside its transaction), exactly like
-- phases 13 to 17. Run it on a replica or a disposable clone. It never touches an existing payment.
--
-- What it proves, for ONE captured payment that is then delivered again in every way the system can see it:
--   one payment record (and it is not rewritten), one membership, one credit grant, one receipt, one
--   payment_received email, one membership_activated email, one in-app notice of each kind, and no new audit entry.
-- Prints "ALL PHASE 18 CHECKS PASSED" on success.

begin;

create function pg_temp.must(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL: %', p_msg; end if; end $$;

-- Everything a duplicate must NOT change, as one comparable string. The webhook-event ledger is deliberately
-- NOT in here: a NEW event id is recorded (that is its job) without changing any business record.
create function pg_temp.snap(p_order uuid, p_user uuid) returns text language sql as $$
  select concat_ws(E'\n',
    'payments=' || (select count(*) from public.payments where order_id = p_order),
    'payment=' || coalesce((select concat_ws('|', id, status, paid_at, gateway_payment_id, amount, currency, metadata::text) from public.payments where order_id = p_order), ''),
    'order=' || coalesce((select concat_ws('|', status, paid_at) from public.orders where id = p_order), ''),
    'memberships=' || (select count(*) from public.memberships m join public.order_items oi on oi.id = m.order_item_id where oi.order_id = p_order),
    'membership=' || coalesce((select string_agg(concat_ws('|', m.id, m.status, m.start_date, m.end_date, m.total_credits, m.credits_remaining), ';' order by m.id)
                               from public.memberships m join public.order_items oi on oi.id = m.order_item_id where oi.order_id = p_order), ''),
    'ledger=' || (select count(*) || ':' || coalesce(sum(amount), 0) from public.credit_ledger where user_id = p_user),
    'receipts=' || (select count(*) from public.payment_receipts where order_id = p_order),
    'receipt=' || coalesce((select string_agg(concat_ws('|', id, receipt_number, amount, paid_at), ';' order by id) from public.payment_receipts where order_id = p_order), ''),
    'outbox=' || coalesce((select string_agg(concat_ws('|', template, dedupe_key, status, attempts), ';' order by template, dedupe_key) from public.email_outbox where user_id = p_user), ''),
    'notices=' || coalesce((select string_agg(type || ':' || n, ',' order by type) from (select type, count(*) n from public.notifications where user_id = p_user and audience = 'user' group by type) t), ''),
    'audit=' || (select count(*) from public.audit_logs where action in ('PAYMENT_VERIFIED', 'MEMBERSHIP_ACTIVATED', 'AMOUNT_MISMATCH_FLAGGED', 'PAYMENT_FOR_CLOSED_ORDER')
                   and (new_values ->> 'order_id' = p_order::text or record_id = p_order or new_values ->> 'user_id' = p_user::text)));
$$;

do $$
declare
  a uuid := gen_random_uuid();                       -- the member who pays
  v_prod uuid; v_amount numeric; v_order uuid; v_pay uuid; v_oid text := 'order_p18_main';
  v_before text; v_after text; v_events_before bigint; v_events_after bigint; v_seq_before bigint;
  v_failed_stage boolean := false; r record; n int; v_job uuid; v_cnt bigint;
  v_order2 uuid; v_pay2 uuid; v_before2 text;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  values (a, 'p18-' || left(a::text, 8) || '@example.invalid', '{"full_name":"Dup Test"}', 'authenticated', 'authenticated');
  alter table public.profiles disable trigger trg_prevent_privilege_escalation;
  update public.profiles set email = 'dup-' || left(a::text, 8) || '@example.org', date_of_birth = '1990-01-01', full_name = 'Dup Test' where id = a;
  alter table public.profiles enable trigger trg_prevent_privilege_escalation;

  select sp.id into v_prod from public.store_products sp join public.membership_plans pl on pl.id = sp.plan_id
  where sp.category = 'membership' and sp.is_active and pl.is_active and pl.price is not null
    and (pl.min_age is null or pl.min_age <= 35) and (pl.max_age is null or pl.max_age >= 35) order by pl.price limit 1;
  perform pg_temp.must(v_prod is not null, 'fixture: an adult membership product exists');

  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  select order_id, payment_id into v_order, v_pay from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)));
  perform set_config('request.jwt.claims', '', true);
  update public.payments set gateway_order_id = v_oid where id = v_pay;
  select amount into v_amount from public.payments where id = v_pay;

  -- ═══ A. A failed delivery leaves no trace, so Razorpay's retry is processed normally ═══
  begin
    perform public.process_payment_webhook('evt_p18_first', 'payment.captured', v_oid, 'pay_p18_1', 'success', v_amount, 'INR', '{"method":"card"}');
    raise exception 'simulate a crash after the work but before the HTTP reply';
  exception when others then
    if sqlerrm not like 'simulate a crash%' then raise; end if;
    v_failed_stage := true;
  end;
  perform pg_temp.must(v_failed_stage, 'the crash was simulated');
  perform pg_temp.must((select status from public.payments where id = v_pay) = 'created', 'A: a rolled-back delivery leaves the payment unpaid');
  perform pg_temp.must(not exists (select 1 from public.payment_webhook_events where event_id = 'evt_p18_first'), 'A: and the event is NOT recorded as handled, so the retry is not skipped');
  perform pg_temp.must((select count(*) from public.email_outbox where user_id = a) = 0 and (select count(*) from public.payment_receipts where user_id = a) = 0, 'A: no email and no receipt came from the rolled-back attempt');

  -- ═══ B. The one real delivery ═══
  perform public.process_payment_webhook('evt_p18_first', 'payment.captured', v_oid, 'pay_p18_1', 'success', v_amount, 'INR', '{"method":"card"}');
  v_before := pg_temp.snap(v_order, a);
  perform pg_temp.must((select count(*) from public.payments where order_id = v_order) = 1, 'B: one payment record');
  perform pg_temp.must((select status = 'success' and paid_at is not null and gateway_payment_id = 'pay_p18_1' and amount = v_amount from public.payments where order_id = v_order), 'B: it is settled with the gateway reference and the verified amount');
  perform pg_temp.must((select count(*) from public.memberships m join public.order_items oi on oi.id = m.order_item_id where oi.order_id = v_order) = 1, 'B: one membership');
  perform pg_temp.must((select count(*) from public.credit_ledger where user_id = a and transaction_type = 'membership_purchase') = 1, 'B: one credit grant');
  perform pg_temp.must((select count(*) from public.payment_receipts where order_id = v_order) = 1, 'B: one receipt');
  perform pg_temp.must((select count(*) from public.email_outbox where user_id = a and template = 'payment_received') = 1, 'B: one payment_received email');
  perform pg_temp.must((select count(*) from public.email_outbox where user_id = a and template = 'membership_activated') = 1, 'B: one membership_activated email');
  perform pg_temp.must((select count(*) from public.email_outbox where user_id = a) = 2, 'B: and no other email');
  perform pg_temp.must((select count(*) from public.notifications where user_id = a and type = 'payment_success') = 1 and (select count(*) from public.notifications where user_id = a and type = 'membership_activated') = 1, 'B: one in-app notice of each kind');
  select count(*) into v_events_before from public.payment_webhook_events where gateway_order_id = v_oid;
  select last_value into v_seq_before from public.payment_receipt_seq;

  -- ═══ C. The same payment arrives again, every way it can: nothing changes ═══
  for n in 1..5 loop   -- the same Razorpay delivery, retried (same event id)
    perform public.process_payment_webhook('evt_p18_first', 'payment.captured', v_oid, 'pay_p18_1', 'success', v_amount, 'INR', '{"method":"card"}');
  end loop;
  for n in 1..5 loop   -- Razorpay's own re-delivery under a NEW event id
    perform public.process_payment_webhook('evt_p18_redelivery_' || n, 'payment.captured', v_oid, 'pay_p18_1', 'success', v_amount, 'INR', '{"method":"card"}');
  end loop;
  perform public.process_payment_webhook('sync:pay_p18_1', 'payment.captured (sync)', v_oid, 'pay_p18_1', 'success', v_amount, 'INR', '{"source":"sync-verify"}');          -- the app's verify call
  perform public.process_payment_webhook('reconcile:pay_p18_1', 'payment.captured (reconcile)', v_oid, 'pay_p18_1', 'success', v_amount, 'INR', '{"source":"reconcile"}'); -- the recovery job
  perform public.process_payment_webhook('reconcile:pay_p18_1', 'payment.captured (reconcile)', v_oid, 'pay_p18_1', 'success', v_amount, 'INR', '{"source":"reconcile"}'); -- ... run again 10 minutes later
  v_after := pg_temp.snap(v_order, a);
  perform pg_temp.must(v_after = v_before, 'C: every business record is identical after 14 duplicate deliveries:' || E'\nBEFORE\n' || v_before || E'\nAFTER\n' || v_after);
  perform pg_temp.must((select count(*) from public.payments where order_id = v_order) = 1, 'C: still exactly one payment record');
  perform pg_temp.must((select metadata ->> 'source' from public.payments where order_id = v_order) is null and (select metadata ->> 'method' from public.payments where order_id = v_order) = 'card', 'C: a duplicate does not rewrite the stored payment details');
  perform pg_temp.must((select last_value from public.payment_receipt_seq) = v_seq_before, 'C: no receipt number was consumed by a duplicate');
  select count(*) into v_events_after from public.payment_webhook_events where gateway_order_id = v_oid;
  -- 5 re-deliveries + 1 sync + 1 reconcile = 7 new ids. The same id repeated (5 retries, and reconcile run twice) adds none.
  perform pg_temp.must(v_events_after = v_events_before + 7, 'C: the event ledger records each NEW event id once (and a repeated id not at all): ' || v_events_before || ' -> ' || v_events_after);

  -- ═══ D. Duplicates after the emails were already sent: no second send ═══
  for r in select * from public.claim_email_jobs(10, null) loop
    perform public.complete_email_job(r.id, 'sent', 'msg_p18_' || left(r.id::text, 8), null);
  end loop;
  perform pg_temp.must((select count(*) from public.email_outbox where user_id = a and status = 'sent') = 2, 'D: both emails are recorded as sent');
  v_before := pg_temp.snap(v_order, a);
  perform public.process_payment_webhook('evt_p18_after_send', 'payment.captured', v_oid, 'pay_p18_1', 'success', v_amount, 'INR', '{}');
  perform public.process_payment_webhook('sync:pay_p18_1', 'payment.captured (sync)', v_oid, 'pay_p18_1', 'success', v_amount, 'INR', '{}');
  perform pg_temp.must(pg_temp.snap(v_order, a) = v_before, 'D: a duplicate after the send changes nothing');
  perform pg_temp.must((select count(*) from public.claim_email_jobs(10, null)) = 0, 'D: and there is nothing left to send');
  perform pg_temp.must(public._enqueue_email('payment_received', 'payment.succeeded:' || v_order, a, 'order', v_order, null) = false, 'D: asking for the same email again returns "already exists"');
  perform pg_temp.must((select count(*) from public.email_outbox where user_id = a) = 2, 'D: the outbox still has two rows');

  -- ═══ E. Different shapes of the "same" payment ═══
  v_before := pg_temp.snap(v_order, a);
  perform public.process_payment_webhook('evt_p18_late_fail', 'payment.failed', v_oid, 'pay_p18_1', 'failed', null, null, '{"error_code":"late"}');
  perform pg_temp.must(pg_temp.snap(v_order, a) = v_before, 'E: a late "failed" event after success changes nothing (the order is not failed)');
  perform pg_temp.must((select count(*) from public.notifications where user_id = a and type = 'payment_failed') = 0, 'E: and the member is not told the payment failed');
  perform public.process_payment_webhook('evt_p18_badamt', 'payment.captured', v_oid, 'pay_p18_1', 'success', 1.00, 'INR', '{}');
  perform pg_temp.must(pg_temp.snap(v_order, a) = v_before, 'E: a duplicate carrying a different amount changes nothing');
  -- A second, DIFFERENT gateway payment captured for the same order (the customer paid twice).
  perform public.process_payment_webhook('evt_p18_second_payment', 'payment.captured', v_oid, 'pay_p18_2', 'success', v_amount, 'INR', '{}');
  perform pg_temp.must(pg_temp.snap(v_order, a) = v_before, 'E: a second gateway payment for an already-paid order grants no second membership, credit, receipt or email');
  raise notice 'FINDING (not asserted as desired behaviour): the second payment is ignored silently. Nothing flags it for a refund; the settled payment keeps the first gateway reference. See the report.';

  -- ═══ F. The lowest-level guards still hold if a caller bypassed the rest ═══
  begin
    insert into public.email_outbox (dedupe_key, template, user_id, related_type, related_id) values ('payment.succeeded:' || v_order, 'payment_received', a, 'order', v_order);
    raise exception 'FAIL: the database accepted a duplicate email job';
  exception when unique_violation then null; end;
  begin
    insert into public.payment_receipts (receipt_number, payment_id, order_id, user_id, amount, currency, paid_at) values ('CHR-R-X-1', v_pay, v_order, a, v_amount, 'INR', now());
    raise exception 'FAIL: the database accepted a second receipt for the same payment';
  exception when unique_violation then null; end;
  perform pg_temp.must(public._issue_receipt(v_order) = (select id from public.payment_receipts where order_id = v_order), 'F: issuing the receipt again returns the existing one');
  begin
    insert into public.memberships (user_id, plan_id, status, start_date, end_date, payment_id, total_credits, reschedules_allowed, reschedules_used, order_item_id)
    select a, m.plan_id, 'active', current_date, current_date + 29, m.payment_id, 1, 0, 0, m.order_item_id from public.memberships m join public.order_items oi on oi.id = m.order_item_id where oi.order_id = v_order limit 1;
    raise exception 'FAIL: the database accepted a second membership for the same order line';
  exception when unique_violation then null; end;
  perform pg_temp.must(pg_temp.snap(v_order, a) = v_before, 'F: all of the above left the records unchanged');

  -- ═══ G. A duplicate for an order that was never paid is not treated as paid ═══
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  -- the member already holds an active membership, so a second membership order is refused by design; use a shop item
  select sp.id into v_prod from public.store_products sp where sp.category = 'tack' and sp.is_active and sp.price is not null limit 1;
  if v_prod is not null then
    select order_id, payment_id into v_order2, v_pay2 from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)));
    perform set_config('request.jwt.claims', '', true);
    update public.payments set gateway_order_id = 'order_p18_other' where id = v_pay2;
    v_before2 := pg_temp.snap(v_order2, a);
    perform public.process_payment_webhook('evt_p18_other_ok', 'payment.captured', 'order_p18_other', 'pay_p18_other', 'success', (select amount from public.payments where id = v_pay2), 'INR', '{}');
    perform public.process_payment_webhook('evt_p18_other_ok', 'payment.captured', 'order_p18_other', 'pay_p18_other', 'success', (select amount from public.payments where id = v_pay2), 'INR', '{}');
    perform pg_temp.must((select count(*) from public.payment_receipts where order_id = v_order2) = 1, 'G: a second order is receipted once, however often its payment arrives');
    perform pg_temp.must((select count(*) from public.email_outbox where user_id = a and template = 'payment_received') = 2 and (select count(*) from public.email_outbox where user_id = a and template = 'membership_activated') = 1, 'G: one payment email per order, and the first order''s membership email is not repeated');
    -- (the full snapshot is member-wide, so it legitimately gains the second order's own email; check the first order's own records)
    perform pg_temp.must((select count(*) from public.payments where order_id = v_order) = 1
      and (select status from public.payments where order_id = v_order) = 'success'
      and (select gateway_payment_id from public.payments where order_id = v_order) = 'pay_p18_1'
      and (select count(*) from public.payment_receipts where order_id = v_order) = 1
      and (select count(*) from public.email_outbox where related_id = v_order and template = 'payment_received') = 1
      and (select count(*) from public.memberships m join public.order_items oi on oi.id = m.order_item_id where oi.order_id = v_order) = 1
      and (select count(*) from public.credit_ledger where user_id = a and transaction_type = 'membership_purchase') = 1, 'G: the first order''s own records are untouched by the second order''s payment');
  end if;

  raise notice 'ALL PHASE 18 CHECKS PASSED';
end $$;

rollback;
