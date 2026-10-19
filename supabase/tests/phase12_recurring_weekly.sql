-- Phase 12 test: recurring weekly bookings, credit limits, capacity, admin excuse, replacement, RLS.
-- Apply 0027_recurring_weekly_bookings.sql first, then run this in the SQL Editor.
-- One transaction, ends in ROLLBACK (nothing persists). A failed check aborts with
-- "FAIL: ..."; success prints "ALL PHASE 12 CHECKS PASSED".
--
-- Harness rule: role switching is done inline (set_config + SET LOCAL ROLE / RESET
-- ROLE). No helper functions are called while impersonating.
-- Needs class sessions generated for the next ~30 days (the daily job does this) and three class
-- times that are empty in that period (it picks them itself); it never touches real bookings.

begin;

alter table public.profiles disable trigger trg_prevent_privilege_escalation;

create function pg_temp.mk(p_user uuid, p_plan text, p_credits int, p_start_off int, p_end_off int) returns uuid
language plpgsql as $$
declare v_id uuid; v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  insert into public.memberships (user_id, plan_id, status, start_date, end_date, total_credits, reschedules_allowed, reschedules_used)
  select p_user, p.id, 'active', v_today + p_start_off, v_today + p_end_off, p_credits, p.reschedules_allowed, 0
  from public.membership_plans p where p.plan_code = p_plan returning id into v_id;
  if p_credits > 0 then
    insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description)
    values (p_user, v_id, p_credits, 'membership_purchase', 'test');
  end if;
  return v_id;
end $$;

create function pg_temp.slots(p_start time, p_dows int[]) returns jsonb
language sql as $$
  select jsonb_agg(jsonb_build_object('day_of_week', t.day_of_week, 'start_time', t.start_time, 'end_time', t.end_time) order by t.day_of_week)
  from public.schedule_templates t where t.is_active and t.start_time = p_start and t.day_of_week = any(p_dows)
$$;

create function pg_temp.empty_dows(p_start time) returns int[] language sql as $$
  select array_agg(t.day_of_week order by t.day_of_week) from public.schedule_templates t
  where t.is_active and t.start_time = p_start and not exists (
    select 1 from public.bookings b join public.class_sessions cs on cs.id = b.session_id
    where cs.start_time = p_start and extract(dow from cs.session_date)::int = t.day_of_week
      and cs.session_date between (now() at time zone 'Asia/Kolkata')::date and (now() at time zone 'Asia/Kolkata')::date + 30
      and b.status in ('held', 'confirmed', 'completed', 'no_show'))
$$;

create function pg_temp.bal(p_m uuid) returns int language sql as $$
  select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = p_m $$;

do $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_a uuid := gen_random_uuid();   -- Platinum
  v_c1 uuid := gen_random_uuid(); v_c2 uuid := gen_random_uuid(); v_c3 uuid := gen_random_uuid(); v_c4 uuid := gen_random_uuid();
  v_g uuid := gen_random_uuid();   -- Gold, changes preferences
  v_o uuid := gen_random_uuid();   -- One-Time Ride
  v_e uuid := gen_random_uuid();   -- Gold, expires
  v_x uuid := gen_random_uuid();   -- Gold, no credits
  v_p12 uuid := gen_random_uuid(); -- bought Platinum when it was 12
  v_admin uuid := gen_random_uuid();
  v_ma uuid; v_mg uuid; v_mc4 uuid; v_me uuid; v_p12m uuid; v_mc1 uuid;
  v_dp int[]; v_dc int[]; v_dg int[]; v_tp time; v_tc time; v_tg time; v_tx time; v_t time;
  v_res jsonb; v_n int; v_n2 int; v_m int;
  v_five jsonb; v_dup jsonb; v_s17 jsonb; v_cap_slot jsonb; v_g1 jsonb; v_g2 jsonb; v_g3 jsonb;
  v_ids uuid[]; v_ids_after uuid[];
  v_b1 uuid; v_b2 uuid; v_sess1 uuid; v_repl_sess uuid; v_new uuid;
  v_notif int;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select u, 'p12-' || left(u::text, 8) || '@test.invalid', '{"full_name":"Test Rider"}', 'authenticated', 'authenticated'
  from unnest(array[v_a, v_c1, v_c2, v_c3, v_c4, v_g, v_o, v_e, v_x, v_p12, v_admin]) u;
  update public.profiles set role = 'admin' where id = v_admin;

  -- Pick three different class times whose classes are empty for the next 30 days, so real riders cannot skew the counts.
  for v_t in select distinct start_time from public.schedule_templates where is_active order by 1 loop
    if v_tp is null and coalesce(array_length(pg_temp.empty_dows(v_t), 1), 0) >= 4 then v_tp := v_t; v_dp := pg_temp.empty_dows(v_t);
    elsif v_tc is null and coalesce(array_length(pg_temp.empty_dows(v_t), 1), 0) >= 1 then v_tc := v_t; v_dc := pg_temp.empty_dows(v_t);
    elsif v_tg is null and coalesce(array_length(pg_temp.empty_dows(v_t), 1), 0) >= 2 then v_tg := v_t; v_dg := pg_temp.empty_dows(v_t);
    end if;
  end loop;
  if v_tp is null or v_tc is null or v_tg is null then raise exception 'FAIL: test needs three empty class times (4 weekdays, 1 weekday, 2 weekdays) in the next 30 days'; end if;
  -- Gold needs three weekdays at one time to test the "too many" refusal; reuse the Platinum weekdays at a fourth time if short.
  v_s17 := pg_temp.slots(v_tp, v_dp[1:4]);
  v_cap_slot := pg_temp.slots(v_tc, v_dc[1:1]);
  v_g1 := pg_temp.slots(v_tg, v_dg[1:1]);
  v_g2 := pg_temp.slots(v_tg, v_dg[1:2]);
  v_g3 := v_g2 || pg_temp.slots(v_tp, v_dp[1:1]);
  select start_time into v_tx from public.schedule_templates where is_active and day_of_week = v_dp[1] and start_time <> v_tp limit 1;
  v_five := v_s17 || pg_temp.slots(v_tx, v_dp[1:1]);
  v_dup := pg_temp.slots(v_tp, v_dp[1:1]) || pg_temp.slots(v_tp, v_dp[1:1]);
  if v_cap_slot is null or v_g1 is null or v_g2 is null or v_g3 is null then raise exception 'FAIL: test needs 07:00 and 08:00 slots on those weekdays'; end if;

  v_ma := pg_temp.mk(v_a, 'PLATINUM', 15, 0, 29);
  v_mc1 := pg_temp.mk(v_c1, 'GOLD', 8, 0, 29); perform pg_temp.mk(v_c2, 'GOLD', 8, 0, 29); perform pg_temp.mk(v_c3, 'GOLD', 8, 0, 29);
  v_mc4 := pg_temp.mk(v_c4, 'GOLD', 8, 0, 29);
  v_mg := pg_temp.mk(v_g, 'GOLD', 8, 0, 29);
  perform pg_temp.mk(v_o, 'ONE_TIME_RIDE', 1, 0, 29);
  v_me := pg_temp.mk(v_e, 'GOLD', 8, -20, 10);
  perform pg_temp.mk(v_x, 'GOLD', 0, 0, 29);
  v_p12m := pg_temp.mk(v_p12, 'PLATINUM', 12, -5, 24);

  -- ── Plan configuration ────────────────────────────────────────────────────
  if (select class_credits from public.membership_plans where plan_code = 'PLATINUM') <> 15 then raise exception 'FAIL: Platinum plan is not 15 classes'; end if;
  if (select class_credits from public.membership_plans where plan_code = 'GOLD') <> 8 then raise exception 'FAIL: Gold plan is not 8 classes'; end if;
  if (select array_agg(recurring_slots_per_week order by plan_code) from public.membership_plans where plan_code in ('GOLD', 'ONE_TIME_RIDE', 'PLATINUM')) <> array[2, 0, 4]::smallint[] then
    raise exception 'FAIL: weekly slot limits wrong'; end if;
  -- Earlier purchases keep what they were sold with.
  if (select total_credits from public.memberships where id = v_p12m) <> 12 or pg_temp.bal(v_p12m) <> 12 then raise exception 'FAIL: an earlier Platinum purchase changed'; end if;
  if has_function_privilege('anon', 'public.confirm_recurring_schedule(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.admin_excuse_booking(uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.generate_recurring_bookings()', 'execute')
     or has_function_privilege('authenticated', 'public._recurring_try_book(uuid,uuid,uuid)', 'execute') then
    raise exception 'FAIL: a recurring function is callable by the wrong role'; end if;

  -- ── Bad input is refused (Platinum member) ────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.confirm_recurring_schedule(v_five);
    raise exception 'FAIL: 5 slots accepted on Platinum';
  exception when others then if sqlerrm not like 'TOO_MANY_SLOTS%' then raise exception 'FAIL: expected TOO_MANY_SLOTS, got %', sqlerrm; end if; end;
  begin perform public.confirm_recurring_schedule('[{"day_of_week":1,"start_time":"17:00","end_time":"18:00"}]'::jsonb);
    raise exception 'FAIL: a slot not in the timetable was accepted';
  exception when others then if sqlerrm not like 'INVALID_SLOTS%' then raise exception 'FAIL: expected INVALID_SLOTS, got %', sqlerrm; end if; end;
  begin perform public.confirm_recurring_schedule('[]'::jsonb);
    raise exception 'FAIL: empty schedule accepted';
  exception when others then if sqlerrm not like 'INVALID_SLOTS%' then raise exception 'FAIL: expected INVALID_SLOTS (empty), got %', sqlerrm; end if; end;
  begin perform public.confirm_recurring_schedule(v_dup);
    raise exception 'FAIL: duplicate slot accepted';
  exception when others then if sqlerrm not like 'INVALID_SLOTS%' then raise exception 'FAIL: expected INVALID_SLOTS (duplicate), got %', sqlerrm; end if; end;
  begin perform public.confirm_recurring_schedule('"nope"'::jsonb);
    raise exception 'FAIL: malformed input accepted';
  exception when others then if sqlerrm not like 'INVALID_SLOTS%' then raise exception 'FAIL: expected INVALID_SLOTS (shape), got %', sqlerrm; end if; end;
  reset role;
  if (select count(*) from public.recurring_schedules where user_id = v_a) <> 0 then raise exception 'FAIL: a refused request left a schedule'; end if;

  -- ── Platinum: 4 a week, stops at exactly 15 ───────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.confirm_recurring_schedule(v_s17);
  reset role;
  select count(*) into v_n from public.bookings where user_id = v_a and membership_id = v_ma and status = 'confirmed';
  if v_n <> 15 or (v_res ->> 'booked')::int <> 15 then raise exception 'FAIL: Platinum should book exactly 15, got % (%)', v_n, v_res; end if;
  if pg_temp.bal(v_ma) <> 0 then raise exception 'FAIL: Platinum balance should be 0, is %', pg_temp.bal(v_ma); end if;
  if (select count(*) from public.recurring_occurrences where user_id = v_a and status = 'skipped_no_credits') < 1 then raise exception 'FAIL: the 16th occurrence was not skipped'; end if;
  if (v_res ->> 'skipped_no_credits')::int < 1 then raise exception 'FAIL: summary does not report the skipped classes'; end if;
  if (select count(*) from public.credit_ledger where membership_id = v_ma and transaction_type = 'booking') <> 15 then raise exception 'FAIL: expected 15 booking ledger rows'; end if;
  if exists (select 1 from public.bookings b join public.class_sessions cs on cs.id = b.session_id
             where b.user_id = v_a and (cs.session_date > v_today + 29 or cs.session_date < v_today)) then raise exception 'FAIL: booked outside the membership validity'; end if;
  -- never more than 4 in one 7-day block
  select max(c) into v_n from (select count(*) c from public.bookings b join public.class_sessions cs on cs.id = b.session_id
                                where b.user_id = v_a group by (cs.session_date - v_today) / 7) w;
  if v_n > 4 then raise exception 'FAIL: % classes in one week on Platinum', v_n; end if;
  -- first full week is 4, then 4, then 4 (the 4th week supplies the remaining credits)
  select count(*) into v_n from public.bookings b join public.class_sessions cs on cs.id = b.session_id
    where b.user_id = v_a and (cs.session_date - v_today) / 7 < 3;
  if v_n < 11 then raise exception 'FAIL: first three weeks booked only % classes', v_n; end if;

  -- ── Retries change nothing (no extra booking, credit or notification) ─────
  select count(*) into v_notif from public.notifications where user_id = v_a and type like 'recurring_%';
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.confirm_recurring_schedule(v_s17);
  reset role;
  if (v_res ->> 'booked')::int <> 0 or v_res ->> 'created' <> 'false' or v_res ->> 'changed' <> 'false' then raise exception 'FAIL: retry changed something: %', v_res; end if;
  perform public.generate_recurring_bookings(); perform public.generate_recurring_bookings();
  select count(*) into v_n from public.bookings where user_id = v_a and membership_id = v_ma;
  if v_n <> 15 or pg_temp.bal(v_ma) <> 0 then raise exception 'FAIL: retries changed bookings (%) or credits (%)', v_n, pg_temp.bal(v_ma); end if;
  if (select count(*) from public.notifications where user_id = v_a and type like 'recurring_%') <> v_notif then raise exception 'FAIL: a retry sent a duplicate notification'; end if;
  if v_notif <> 1 then raise exception 'FAIL: expected one confirmation notification, got %', v_notif; end if;
  -- the backend, not the app, refuses a 16th class:
  if (public._recurring_try_book(v_a, v_ma, (select cs.id from public.class_sessions cs
        where cs.session_date between v_today + 1 and v_today + 29 and cs.status = 'open' and not exists (select 1 from public.bookings b where b.session_id = cs.id and b.user_id = v_a) order by cs.session_date, cs.start_time limit 1))) ->> 'outcome' <> 'no_credits' then
    raise exception 'FAIL: a 16th class could be booked directly'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.book_class((select cs.id from public.class_sessions cs where cs.session_date between v_today + 1 and v_today + 29 and cs.status = 'open'
                               and not exists (select 1 from public.bookings b where b.session_id = cs.id and b.user_id = v_a) order by cs.session_date, cs.start_time limit 1));
    raise exception 'FAIL: book_class booked past the credits';
  exception when others then if sqlerrm not like 'NO_CREDITS_REMAINING%' then raise exception 'FAIL: expected NO_CREDITS_REMAINING, got %', sqlerrm; end if; end;
  reset role;

  -- ── Gold: 8 classes, 2 a week; changing preferences keeps what was booked ─
  perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.confirm_recurring_schedule(v_g3);
    raise exception 'FAIL: 3 slots accepted on Gold';
  exception when others then if sqlerrm not like 'TOO_MANY_SLOTS%' then raise exception 'FAIL: expected TOO_MANY_SLOTS (Gold), got %', sqlerrm; end if; end;
  v_res := public.confirm_recurring_schedule(v_g1);
  reset role;
  select count(*), array_agg(id order by id) into v_n, v_ids from public.bookings where user_id = v_g and status = 'confirmed';
  if v_n < 3 or v_n > 6 or pg_temp.bal(v_mg) <> 8 - v_n then raise exception 'FAIL: one weekly slot booked % classes, balance %', v_n, pg_temp.bal(v_mg); end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.confirm_recurring_schedule(v_g2);
  reset role;
  select count(*), array_agg(id order by id) into v_m, v_ids_after from public.bookings where user_id = v_g and status = 'confirmed';
  if v_m <> 8 then raise exception 'FAIL: Gold should end at exactly 8 classes, has %', v_m; end if;
  if not (v_ids <@ v_ids_after) then raise exception 'FAIL: changing the schedule removed an earlier booking'; end if;
  if pg_temp.bal(v_mg) <> 0 then raise exception 'FAIL: Gold balance should be 0'; end if;
  if (select count(*) from public.recurring_schedule_slots s join public.recurring_schedules rs on rs.id = s.schedule_id where rs.user_id = v_g and rs.status = 'active') <> 2 then
    raise exception 'FAIL: schedule should now have 2 slots'; end if;
  if (select count(*) from public.recurring_schedules where user_id = v_g and status = 'active') <> 1 then raise exception 'FAIL: more than one active schedule'; end if;
  -- going back to one slot (at zero credits) edits the pattern only, never bookings
  perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.confirm_recurring_schedule(v_g1);
  if (v_res ->> 'booked')::int <> 0 or v_res ->> 'changed' <> 'true' then raise exception 'FAIL: editing at zero credits should only change the pattern: %', v_res; end if;
  v_n := public.end_recurring_schedule();
  reset role;
  if v_n <> 1 or (select count(*) from public.bookings where user_id = v_g and status = 'confirmed') <> 8 then raise exception 'FAIL: ending the schedule touched bookings'; end if;

  -- ── Capacity: three riders fill a class, the fourth is not booked or charged ─
  perform set_config('request.jwt.claims', json_build_object('sub', v_c1, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.confirm_recurring_schedule(v_cap_slot); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_c2, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.confirm_recurring_schedule(v_cap_slot); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_c3, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.confirm_recurring_schedule(v_cap_slot); reset role;
  select count(*) into v_n from public.bookings where user_id in (v_c1, v_c2, v_c3) and status = 'confirmed';
  select count(*) into v_n2 from public.recurring_occurrences where user_id = v_c1 and status = 'booked';
  if v_n <> 3 * v_n2 or v_n2 < 3 then raise exception 'FAIL: three riders should each get every class (% bookings, % classes)', v_n, v_n2; end if;
  if exists (select 1 from public.class_sessions cs where (select count(*) from public.bookings b where b.session_id = cs.id and b.status in ('held','confirmed')) > cs.capacity) then
    raise exception 'FAIL: a class is over capacity'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_c4, 'role', 'authenticated')::text, true);
  set local role authenticated; v_res := public.confirm_recurring_schedule(v_cap_slot);
  begin
    perform public.book_class((select o.session_id from public.recurring_occurrences o where o.user_id = v_c4 order by o.created_at limit 1));
    raise exception 'FAIL: a 4th rider booked a full class';
  exception when others then if sqlerrm not like 'SESSION_FULL%' then raise exception 'FAIL: expected SESSION_FULL, got %', sqlerrm; end if; end;
  reset role;
  if (v_res ->> 'booked')::int <> 0 or (v_res ->> 'skipped_full')::int < 3 then raise exception 'FAIL: 4th rider result wrong: %', v_res; end if;
  if pg_temp.bal(v_mc4) <> 8 or (select count(*) from public.bookings where user_id = v_c4) <> 0 then raise exception 'FAIL: a failed booking cost a credit'; end if;
  -- a place frees up: C1 cancels the first class; the next run books C4 into it, once.
  select b.id, b.session_id into v_b1, v_sess1 from public.bookings b join public.class_sessions cs on cs.id = b.session_id
    where b.user_id = v_c1 and b.status = 'confirmed' order by cs.session_date, cs.start_time limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_c1, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.cancel_booking(v_b1, 'test'); reset role;
  perform public.generate_recurring_bookings(); perform public.generate_recurring_bookings();
  if (select count(*) from public.bookings where user_id = v_c4 and session_id = v_sess1 and status = 'confirmed') <> 1 then raise exception 'FAIL: C4 was not booked into the freed place exactly once'; end if;
  if pg_temp.bal(v_mc4) <> 7 then raise exception 'FAIL: C4 should have been charged exactly one credit, balance %', pg_temp.bal(v_mc4); end if;
  if (select count(*) from public.notifications where user_id = v_c4 and type = 'recurring_generated') <> 1 then raise exception 'FAIL: expected exactly one "classes booked" notification for C4'; end if;
  if (select count(*) from public.bookings where user_id = v_c1 and session_id = v_sess1 and status = 'confirmed') <> 0 then raise exception 'FAIL: a cancelled class was silently re-booked'; end if;
  if exists (select 1 from public.class_sessions cs where (select count(*) from public.bookings b where b.session_id = cs.id and b.status in ('held','confirmed')) > cs.capacity) then
    raise exception 'FAIL: a class is over capacity after the retry'; end if;

  -- ── Expiry ────────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_e, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.confirm_recurring_schedule(v_g2); reset role;
  if exists (select 1 from public.bookings b join public.class_sessions cs on cs.id = b.session_id where b.user_id = v_e and cs.session_date > v_today + 10) then
    raise exception 'FAIL: booked beyond the membership end date'; end if;
  select count(*) into v_n from public.bookings where user_id = v_e;
  if v_n < 1 then raise exception 'FAIL: nothing booked before expiry'; end if;
  update public.memberships set end_date = v_today - 1 where id = v_me;
  perform public.generate_recurring_bookings();
  if (select status from public.recurring_schedules where user_id = v_e) <> 'ended' then raise exception 'FAIL: schedule did not end with the membership'; end if;
  if (select count(*) from public.bookings where user_id = v_e) <> v_n then raise exception 'FAIL: expiry changed historical bookings'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_e, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.confirm_recurring_schedule(v_g1); raise exception 'FAIL: schedule created on an expired membership';
  exception when others then if sqlerrm not like 'NO_ACTIVE_MEMBERSHIP%' then raise exception 'FAIL: expected NO_ACTIVE_MEMBERSHIP, got %', sqlerrm; end if; end;
  reset role;

  -- ── No credits / wrong plan ───────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_x, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.confirm_recurring_schedule(v_g1); raise exception 'FAIL: scheduled with no credits';
  exception when others then if sqlerrm not like 'NO_CREDITS_REMAINING%' then raise exception 'FAIL: expected NO_CREDITS_REMAINING, got %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_o, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.confirm_recurring_schedule(v_g1); raise exception 'FAIL: One-Time Ride got a weekly schedule';
  exception when others then if sqlerrm not like 'PLAN_NOT_RECURRING%' then raise exception 'FAIL: expected PLAN_NOT_RECURRING, got %', sqlerrm; end if; end;
  reset role;

  -- ── Admin excuse, restoration, replacement ────────────────────────────────
  select b.id, b.session_id into v_b1, v_sess1 from public.bookings b join public.class_sessions cs on cs.id = b.session_id
    where b.user_id = v_a and b.status = 'confirmed' order by cs.session_date, cs.start_time limit 1;
  select b.id into v_b2 from public.bookings b join public.class_sessions cs on cs.id = b.session_id
    where b.user_id = v_a and b.status = 'confirmed' and b.id <> v_b1 order by cs.session_date, cs.start_time limit 1;

  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.admin_excuse_booking(v_b1, 'x'); raise exception 'FAIL: a member excused a class';
  exception when others then if sqlerrm not like 'NOT_AUTHORIZED%' then raise exception 'FAIL: expected NOT_AUTHORIZED, got %', sqlerrm; end if; end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.admin_excuse_booking(v_b1, '  '); raise exception 'FAIL: excused without a reason';
  exception when others then if sqlerrm not like 'REASON_REQUIRED%' then raise exception 'FAIL: expected REASON_REQUIRED, got %', sqlerrm; end if; end;
  v_res := public.admin_excuse_booking(v_b1, 'Arena closed for repairs');
  reset role;
  if v_res ->> 'credit_restored' <> 'true' then raise exception 'FAIL: credit not restored: %', v_res; end if;
  if pg_temp.bal(v_ma) <> 1 then raise exception 'FAIL: balance should be 1 after the restore, is %', pg_temp.bal(v_ma); end if;
  if (select status from public.bookings where id = v_b1) <> 'absent' or (select status from public.attendance where booking_id = v_b1) <> 'excused' then raise exception 'FAIL: booking/attendance not marked excused'; end if;
  if (select count(*) from public.bookings where user_id = v_a and status = 'confirmed') <> 14 then raise exception 'FAIL: other recurring bookings were disturbed'; end if;
  -- twice is still one credit
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated; v_res := public.admin_excuse_booking(v_b1, 'Arena closed for repairs'); reset role;
  if v_res ->> 'credit_restored' <> 'false' or pg_temp.bal(v_ma) <> 1
     or (select count(*) from public.credit_ledger where booking_id = v_b1 and transaction_type = 'absence_restore') <> 1 then raise exception 'FAIL: a second excuse restored another credit'; end if;
  if (select count(*) from public.notifications where user_id = v_a and type = 'class_excused') <> 1 then raise exception 'FAIL: expected one excused notification'; end if;
  -- a class that was ridden is history
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_mark_attendance(v_b2, 'present', null);
  begin perform public.admin_excuse_booking(v_b2, 'too late'); raise exception 'FAIL: a ridden class was excused';
  exception when others then if sqlerrm not like 'BOOKING_NOT_EXCUSABLE%' then raise exception 'FAIL: expected BOOKING_NOT_EXCUSABLE, got %', sqlerrm; end if; end;
  reset role;
  if (select status from public.attendance where booking_id = v_b2) <> 'present' or pg_temp.bal(v_ma) <> 1 then raise exception 'FAIL: attendance history or credits changed'; end if;

  -- replacement uses the restored credit, not the reschedule allowance
  select cs.id into v_repl_sess from public.class_sessions cs
    where cs.session_date = (select session_date from public.class_sessions where id = v_sess1)
      and cs.start_time <> v_tp and cs.status = 'open'
      and (select count(*) from public.bookings b where b.session_id = cs.id and b.status in ('held','confirmed')) < cs.capacity;
  if v_repl_sess is null then raise exception 'FAIL: test needs another open class with a free place on the excused day'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_c2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.book_replacement(v_b1, v_repl_sess); raise exception 'FAIL: another member replaced A''s class';
  exception when others then if sqlerrm not like 'NOT_A_SCHEDULE_CLASS%' then raise exception 'FAIL: expected NOT_A_SCHEDULE_CLASS, got %', sqlerrm; end if; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if (select (o ->> 'can_replace')::boolean from jsonb_array_elements(public.my_recurring_schedule() -> 'occurrences') o where o ->> 'booking_id' = v_b1::text) is not true then
    raise exception 'FAIL: the schedule view does not offer a replacement'; end if;
  v_res := public.book_replacement(v_b1, v_repl_sess);
  begin perform public.book_replacement(v_b1, v_repl_sess); raise exception 'FAIL: replaced twice';
  exception when others then if sqlerrm not like 'ALREADY_REPLACED%' then raise exception 'FAIL: expected ALREADY_REPLACED, got %', sqlerrm; end if; end;
  reset role;
  v_new := (v_res ->> 'booking_id')::uuid;
  if pg_temp.bal(v_ma) <> 0 then raise exception 'FAIL: the replacement did not use the restored credit'; end if;
  if (select status from public.bookings where id = v_new) <> 'confirmed' or (select reschedule_count from public.bookings where id = v_new) <> 0 then raise exception 'FAIL: replacement booking wrong'; end if;
  if (select reschedules_used from public.memberships where id = v_ma) <> 0 then raise exception 'FAIL: the replacement used a reschedule'; end if;
  if (select status from public.recurring_occurrences where booking_id = v_b1) <> 'replaced' then raise exception 'FAIL: occurrence not marked replaced'; end if;
  if (select count(*) from public.recurring_schedule_slots s join public.recurring_schedules rs on rs.id = s.schedule_id where rs.user_id = v_a and rs.status = 'active') <> 4 then
    raise exception 'FAIL: the weekly preference was disturbed'; end if;

  -- ── Isolation ─────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_c2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.recurring_schedules where user_id <> v_c2;
  select count(*) into v_n2 from public.recurring_occurrences where user_id <> v_c2;
  if v_n <> 0 or v_n2 <> 0 then raise exception 'FAIL: C2 can see other members'' schedules (%, %)', v_n, v_n2; end if;
  if (select count(*) from public.recurring_schedules) <> 1 then raise exception 'FAIL: C2 cannot see their own schedule'; end if;
  if (public.my_recurring_schedule() ->> 'membership_id')::uuid is distinct from (select membership_id from public.recurring_schedules where user_id = v_c2) then raise exception 'FAIL: my_recurring_schedule returned someone else''s'; end if;
  begin insert into public.recurring_schedules (user_id, membership_id) values (v_c2, v_ma); raise exception 'FAIL: direct insert allowed';
  exception when insufficient_privilege then null; end;
  begin update public.recurring_occurrences set status = 'booked'; raise exception 'FAIL: direct update allowed';
  exception when insufficient_privilege then null; end;
  begin perform public.generate_recurring_bookings(); raise exception 'FAIL: a member ran the generator';
  exception when insufficient_privilege then null; end;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if (select count(*) from public.recurring_schedules) < 5 then raise exception 'FAIL: staff cannot see schedules'; end if;
  reset role;

  raise notice 'ALL PHASE 12 CHECKS PASSED';
end $$;

rollback;
