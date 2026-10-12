-- Phase 9 test: refer & earn and the wallet. NOT YET RUN.
-- Apply 0024_referral_wallet.sql first, then run in the SQL Editor.
-- One transaction ending in ROLLBACK. Success prints "ALL PHASE 9 CHECKS PASSED".
-- Payments are simulated by calling the same function the server calls after
-- Razorpay confirms one. Role switching is inline (set_config + SET LOCAL ROLE).

begin;

do $$
declare
  v_a uuid := gen_random_uuid();   -- referrer
  v_b uuid := gen_random_uuid();   -- friend, buys a membership
  v_c uuid := gen_random_uuid();   -- tries to refer themselves / claim twice
  v_one uuid;
  v_code text; v_code_again text;
  v_o record; v_o2 record;
  v_bal numeric; v_n int;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select u, 'p9-' || left(u::text, 8) || '@test.invalid', '{"full_name":"Test"}', 'authenticated', 'authenticated' from unnest(array[v_a, v_b, v_c]) u;
  select id into v_one from public.store_products where sku = 'MEM_ONE_TIME_RIDE';

  -- A gets a stable code
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true); set local role authenticated;
  v_code := public.my_referral_code(); v_code_again := public.my_referral_code();
  if v_code is null or v_code <> v_code_again or length(v_code) <> 8 then reset role; raise exception 'FAIL: code should be 8 characters and stable'; end if;
  if public.my_wallet_balance() <> 0 then reset role; raise exception 'FAIL: new wallet should be empty'; end if;
  reset role;

  -- self-referral and unknown codes are refused
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true); set local role authenticated;
  if public.claim_referral(v_code) then reset role; raise exception 'FAIL: a member claimed their own code'; end if;
  if public.claim_referral('NOSUCHCD') then reset role; raise exception 'FAIL: an unknown code was accepted'; end if;
  reset role;

  -- B claims A's code (lower case, spaces tolerated), second claim is refused
  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true); set local role authenticated;
  if not public.claim_referral(' ' || lower(v_code) || ' ') then reset role; raise exception 'FAIL: a first-time customer could not claim a code'; end if;
  if public.claim_referral(v_code) then reset role; raise exception 'FAIL: a person was referred twice'; end if;
  reset role;
  if (select status from public.referrals where referred_id = v_b) <> 'pending' then raise exception 'FAIL: referral should wait for the first paid membership'; end if;
  if (select coalesce(sum(amount), 0) from public.wallet_ledger where user_id = v_a) <> 0 then raise exception 'FAIL: sign-up alone must not pay the referrer'; end if;

  -- B buys; payment confirmed -> A is rewarded Rs 500, once
  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_o from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_one, 'quantity', 1)));
  reset role;
  if v_o.wallet_applied <> 0 or v_o.amount_due <> v_o.total_amount then raise exception 'FAIL: no wallet, no discount'; end if;
  update public.payments set gateway_order_id = 'order_p9_b' where id = v_o.payment_id;
  perform public.process_payment_webhook('evt_p9_b', 'payment.captured', 'order_p9_b', 'pay_p9_b', 'success', v_o.total_amount, 'INR');
  perform public.process_payment_webhook('evt_p9_b2', 'payment.captured', 'order_p9_b', 'pay_p9_b', 'success', v_o.total_amount, 'INR');
  select coalesce(sum(amount), 0) into v_bal from public.wallet_ledger where user_id = v_a;
  if v_bal <> 500 then raise exception 'FAIL: referrer should have Rs 500 once, has %', v_bal; end if;
  if (select status from public.referrals where referred_id = v_b) <> 'rewarded' then raise exception 'FAIL: referral should be rewarded'; end if;
  if (select coalesce(sum(amount), 0) from public.wallet_ledger where user_id = v_b) <> 0 then raise exception 'FAIL: only the referrer is paid'; end if;
  if not exists (select 1 from public.notifications where user_id = v_a and type = 'referral_reward') then raise exception 'FAIL: referrer was not told'; end if;

  -- someone who has already bought cannot be referred afterwards
  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true); set local role authenticated;
  if public.claim_referral(public.my_referral_code()) then reset role; raise exception 'FAIL: self-claim by a buyer'; end if;
  reset role;

  -- A spends the wallet: Rs 2000 ride -> Rs 500 off, Razorpay amount is 1500
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_o2 from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_one, 'quantity', 1)), true);
  reset role;
  if v_o2.wallet_applied <> 500 or v_o2.amount_due <> v_o2.total_amount - 500 then raise exception 'FAIL: wallet should take Rs 500 off'; end if;
  if (select amount from public.payments where id = v_o2.payment_id) <> v_o2.total_amount - 500 then raise exception 'FAIL: the payment must be for the reduced amount'; end if;
  if (select coalesce(sum(amount), 0) from public.wallet_ledger where user_id = v_a) <> 0 then raise exception 'FAIL: wallet should be spent'; end if;

  -- the order is never paid and expires: the money goes back
  update public.orders set created_at = now() - interval '30 days' where id = v_o2.order_id;
  perform public.expire_stale_orders();
  if (select coalesce(sum(amount), 0) from public.wallet_ledger where user_id = v_a) <> 500 then raise exception 'FAIL: an expired order should return the wallet money'; end if;

  -- ...and a late payment reopens it and takes the money again, exactly once
  update public.payments set gateway_order_id = 'order_p9_a' where id = v_o2.payment_id;
  perform public.process_payment_webhook('evt_p9_a', 'payment.captured', 'order_p9_a', 'pay_p9_a', 'success', v_o2.total_amount - 500, 'INR');
  if (select status from public.orders where id = v_o2.order_id) <> 'paid' then raise exception 'FAIL: late payment should pay the order'; end if;
  if (select coalesce(sum(amount), 0) from public.wallet_ledger where user_id = v_a) <> 0 then raise exception 'FAIL: a reopened order should use the wallet again'; end if;

  -- cap: with referral_max_rewards = 0 the next referral is capped, not paid
  update public.system_settings set value = '0'::jsonb where key = 'referral_max_rewards';
  insert into public.referrals (referrer_id, referred_id) values (v_a, v_c);
  perform set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true); set local role authenticated;
  select * into v_o from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_one, 'quantity', 1)));
  reset role;
  update public.payments set gateway_order_id = 'order_p9_c' where id = v_o.payment_id;
  perform public.process_payment_webhook('evt_p9_c', 'payment.captured', 'order_p9_c', 'pay_p9_c', 'success', v_o.total_amount, 'INR');
  if (select status from public.referrals where referred_id = v_c) <> 'capped' then raise exception 'FAIL: reward over the cap should be capped'; end if;

  -- members cannot write to the wallet directly
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true); set local role authenticated;
  begin
    insert into public.wallet_ledger (user_id, amount, kind) values (v_a, 9999, 'referral_reward');
    reset role; raise exception 'FAIL: a member wrote to their own wallet';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  raise notice 'ALL PHASE 9 CHECKS PASSED';
end $$;

rollback;
