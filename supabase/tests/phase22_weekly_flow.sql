-- Phase 22 test: the weekly-schedule flow end to end (regression for "only the clicked class was booked").
-- Apply 0016-0035 first. One transaction, ends in ROLLBACK; test users are @test.org. Prints "ALL PHASE 22 CHECKS PASSED".
-- It proves: a single book_class saves NO schedule (the old Book a class behaviour); confirm_recurring_schedule saves the
-- weekly pattern for the right member and membership and the generator books dated classes; running the generator again
-- changes nothing; Gold and Platinum entitlements, the 4-a-week limit, expiry, capacity and error handling all hold.
-- Role switching is inline (set_config + SET LOCAL ROLE); no helper is called while impersonating.
begin;

alter table public.profiles disable trigger trg_prevent_privilege_escalation;

create function pg_temp.mk(p_user uuid, p_plan text, p_credits int, p_days int) returns uuid language plpgsql as $$
declare v_id uuid; v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  insert into public.memberships (user_id, plan_id, status, start_date, end_date, total_credits, reschedules_allowed, reschedules_used)
  select p_user, p.id, 'active', v_today, v_today + p_days, p_credits, p.reschedules_allowed, 0
  from public.membership_plans p where p.plan_code = p_plan returning id into v_id;
  insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description) values (p_user, v_id, p_credits, 'membership_purchase', 't');
  return v_id;
end $$;
create function pg_temp.bal(p_m uuid) returns int language sql as $$ select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = p_m $$;
create function pg_temp.live(p_m uuid) returns int language sql as $$ select count(*)::int from public.bookings where membership_id = p_m and status in ('held', 'confirmed') $$;
create function pg_temp.must(p_ok boolean, p_msg text) returns void language plpgsql as $$ begin if p_ok is not true then raise exception 'FAIL: %', p_msg; end if; end $$;
create function pg_temp.slots(p_dows int[]) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('day_of_week', x.day_of_week, 'start_time', x.start_time, 'end_time', x.end_time) order by x.day_of_week)
  from (select distinct on (t.day_of_week) t.day_of_week, t.start_time, t.end_time from public.schedule_templates t
        where t.is_active and t.day_of_week = any(p_dows) order by t.day_of_week, t.start_time) x $$;
grant execute on function pg_temp.must(boolean, text) to public;

do $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  g uuid := gen_random_uuid(); g2 uuid := gen_random_uuid(); p uuid := gen_random_uuid(); e uuid := gen_random_uuid();
  one uuid := gen_random_uuid(); r1 uuid := gen_random_uuid(); r2 uuid := gen_random_uuid(); r3 uuid := gen_random_uuid(); r4 uuid := gen_random_uuid();
  mg uuid; mg2 uuid; mp uuid; me uuid; mone uuid; mr1 uuid; mr2 uuid; mr3 uuid; mr4 uuid;
  v_dows int[]; v_two jsonb; v_four jsonb; v_five jsonb; v_three jsonb; v_res jsonb; v_n int; v_a int; v_b int; v_err text; v_s uuid; v_sch uuid; v_maxweek int; v_last date;
begin
  perform public.generate_future_sessions();
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select u, 'p22-' || left(u::text, 8) || '@test.org', '{"full_name":"Test Rider"}', 'authenticated', 'authenticated'
  from unnest(array[g, g2, p, e, one, r1, r2, r3, r4]) u;

  select array_agg(distinct day_of_week) into v_dows from public.schedule_templates where is_active;
  if coalesce(array_length(v_dows, 1), 0) < 4 then raise notice 'SKIPPED: the timetable has fewer than four riding days'; return; end if;
  v_two := pg_temp.slots(v_dows[1:2]);
  v_four := pg_temp.slots(v_dows[1:4]);
  v_five := pg_temp.slots(v_dows[1:5]);
  v_three := pg_temp.slots(v_dows[1:3]);

  mg := pg_temp.mk(g, 'GOLD', 8, 29);
  mg2 := pg_temp.mk(g2, 'GOLD', 3, 29);
  mp := pg_temp.mk(p, 'PLATINUM', 15, 29);
  me := pg_temp.mk(e, 'GOLD', 8, 9);
  mone := pg_temp.mk(one, 'ONE_TIME_RIDE', 1, 29);
  mr1 := pg_temp.mk(r1, 'GOLD', 8, 29); mr2 := pg_temp.mk(r2, 'GOLD', 8, 29); mr3 := pg_temp.mk(r3, 'GOLD', 8, 29); mr4 := pg_temp.mk(r4, 'GOLD', 8, 29);

  -- ═══ The bug, reproduced: booking ONE class through book_class saves no weekly schedule ═══
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select id into v_s from public.class_sessions where status = 'open' and session_date > v_today order by session_date, start_time limit 1;
  perform public.book_class(v_s);
  reset role;
  perform pg_temp.must(pg_temp.live(mg) = 1, 'repro: book_class booked exactly the one class');
  perform pg_temp.must((select count(*) from public.recurring_schedules where user_id = g) = 0, 'repro: ...and saved NO weekly schedule');
  perform public.generate_recurring_bookings();
  perform pg_temp.must(pg_temp.live(mg) = 1, 'repro: the daily job has nothing to generate from, so nothing more is ever booked');
  perform pg_temp.must(pg_temp.bal(mg) = 7, 'repro: one class used');

  -- ═══ Test A: saving the weekly schedule persists the pattern for the right member and membership ═══
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.confirm_recurring_schedule(v_two);
  reset role;
  perform pg_temp.must((v_res ->> 'created')::boolean, 'A: a schedule was created');
  select id into v_sch from public.recurring_schedules where user_id = g and status = 'active';
  perform pg_temp.must(v_sch is not null and (select membership_id from public.recurring_schedules where id = v_sch) = mg, 'A: it belongs to this member and their membership');
  perform pg_temp.must((select count(*) from public.recurring_schedule_slots where schedule_id = v_sch) = 2, 'A: both weekday/time selections are stored');
  perform pg_temp.must(not exists (select 1 from jsonb_to_recordset(v_two) s(day_of_week int, start_time time, end_time time)
                                   where not exists (select 1 from public.recurring_schedule_slots x where x.schedule_id = v_sch and x.day_of_week = s.day_of_week and x.start_time = s.start_time and x.end_time = s.end_time)), 'A: the stored slots are exactly the chosen ones');
  perform pg_temp.must((select count(*) from public.recurring_schedules where membership_id = mg) = 1, 'A: exactly one schedule per membership');

  -- ═══ Test B: dated reservations exist, are visible to My Classes, and a second run changes nothing ═══
  v_n := pg_temp.live(mg);
  perform pg_temp.must(v_n >= 2, 'B: the schedule booked dated classes, not just one (got ' || v_n || ')');
  perform pg_temp.must(not exists (select 1 from public.recurring_occurrences o where o.schedule_id = v_sch and o.status = 'booked' and o.booking_id is null), 'B: every booked occurrence points at a real booking');
  perform pg_temp.must(pg_temp.bal(mg) = 8 - pg_temp.live(mg), 'B: one class taken per live booking, ledger and bookings agree (balance ' || pg_temp.bal(mg) || ', live ' || pg_temp.live(mg) || ')');
  perform pg_temp.must((select count(*) from public.bookings b join public.class_sessions cs on cs.id = b.session_id
                        where b.user_id = g and b.status in ('confirmed', 'held') and cs.session_date >= v_today) = pg_temp.live(mg), 'B: My Classes (upcoming, active) lists every one of them');
  perform pg_temp.must((select count(*) from public.credit_ledger where membership_id = mg and transaction_type = 'booking') = pg_temp.live(mg) + 0, 'B: exactly one ledger charge per booking');
  perform pg_temp.must(not exists (select 1 from (select session_id from public.bookings where user_id = g and status in ('held', 'confirmed') group by 1 having count(*) > 1) d), 'B: no class is booked twice');
  v_a := pg_temp.live(mg); v_b := pg_temp.bal(mg);
  perform public.generate_recurring_bookings();
  perform public.generate_recurring_bookings();
  perform pg_temp.must(pg_temp.live(mg) = v_a and pg_temp.bal(mg) = v_b, 'B: running the daily job twice more creates no bookings and takes no credits');
  perform pg_temp.must((select count(*) from public.recurring_occurrences where schedule_id = v_sch) = (select count(distinct session_id) from public.recurring_occurrences where schedule_id = v_sch), 'B: one occurrence per class');
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.confirm_recurring_schedule(v_two);       -- a retry of the same request
  reset role;
  perform pg_temp.must(pg_temp.live(mg) = v_a and pg_temp.bal(mg) = v_b and (v_res ->> 'booked')::int = 0, 'B: sending the same schedule again books nothing and takes nothing');

  -- ═══ Test C: Gold can never be given more than it holds (3 credits -> exactly 3 classes; no 4th) ═══
  perform set_config('request.jwt.claims', json_build_object('sub', g2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.confirm_recurring_schedule(v_two);
  reset role;
  perform pg_temp.must(pg_temp.live(mg2) = 3 and pg_temp.bal(mg2) = 0, 'C: three credits, three classes, balance zero (live ' || pg_temp.live(mg2) || ', balance ' || pg_temp.bal(mg2) || ')');
  perform public.generate_recurring_bookings();
  perform pg_temp.must(pg_temp.live(mg2) = 3 and pg_temp.bal(mg2) = 0, 'C: the daily job adds nothing once credits are used');
  perform set_config('request.jwt.claims', json_build_object('sub', g2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select id into v_s from public.class_sessions cs where cs.status = 'open' and cs.session_date > v_today
    and not exists (select 1 from public.bookings b where b.session_id = cs.id and b.user_id = g2) order by session_date, start_time limit 1;
  begin perform public.book_class(v_s); v_err := 'booked'; exception when others then v_err := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_err = 'NO_CREDITS_REMAINING', 'C: a class beyond the entitlement is rejected: ' || v_err);
  perform pg_temp.must((select count(*) from public.credit_ledger where membership_id = mg2 and transaction_type = 'booking') = 3 and not exists (select 1 from public.credit_ledger where membership_id = mg2 and amount < -1), 'C: the rejected request charged nothing');
  perform pg_temp.must((select min(s) from (select pg_temp.bal(mg2) s) x) >= 0 and pg_temp.bal(mg) >= 0, 'C: no balance is negative');

  -- ═══ Test D: Platinum, 4 times a week, never more than 15 classes, never more than 4 in a week ═══
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.confirm_recurring_schedule(v_four);
  reset role;
  perform pg_temp.must(pg_temp.live(mp) <= 15 and pg_temp.bal(mp) = 15 - pg_temp.live(mp) and pg_temp.bal(mp) >= 0, 'D: never more than 15 classes (live ' || pg_temp.live(mp) || ')');
  select coalesce(max(c), 0) into v_maxweek from (
    select count(*) c from public.bookings b join public.class_sessions cs on cs.id = b.session_id
    where b.membership_id = mp and b.status in ('held', 'confirmed') group by (cs.session_date - v_today) / 7) w;
  perform pg_temp.must(v_maxweek <= 4, 'D: never more than 4 classes in a 7-day block (max ' || v_maxweek || ')');
  perform pg_temp.must(pg_temp.live(mp) >= 5, 'D: the four weekly times booked several weeks, not just one (' || pg_temp.live(mp) || ')');
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.confirm_recurring_schedule(v_five); v_err := 'saved'; exception when others then v_err := sqlerrm; end;
  reset role;
  if array_length(v_dows, 1) >= 5 then perform pg_temp.must(v_err = 'TOO_MANY_SLOTS', 'D: a fifth weekly time is refused: ' || v_err); end if;

  -- ═══ Test E: expiry, no class after the membership ends ═══
  perform set_config('request.jwt.claims', json_build_object('sub', e, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.confirm_recurring_schedule(v_two);
  reset role;
  select max(cs.session_date) into v_last from public.bookings b join public.class_sessions cs on cs.id = b.session_id where b.membership_id = me and b.status in ('held', 'confirmed');
  perform pg_temp.must(v_last is not null and v_last <= v_today + 9, 'E: nothing is booked after the membership ends (' || v_last || ' vs ' || (v_today + 9) || ')');
  update public.memberships set start_date = v_today - 20, end_date = v_today - 1, status = 'expired' where id = me;
  v_a := pg_temp.live(me);
  perform public.generate_recurring_bookings();
  perform pg_temp.must(pg_temp.live(me) = v_a, 'E: an expired membership gets nothing new');
  perform pg_temp.must((select status from public.recurring_schedules where membership_id = me order by created_at desc limit 1) = 'ended', 'E: its schedule is ended by the job');

  -- ═══ Test F: three riders fill a class, the fourth is refused ═══
  select cs.id into v_s from public.class_sessions cs where cs.status = 'open' and cs.session_date > v_today + 1
    and not exists (select 1 from public.bookings b where b.session_id = cs.id and b.status in ('held', 'confirmed')) order by cs.session_date, cs.start_time offset 8 limit 1;
  update public.class_sessions set capacity = 3 where id = v_s;
  perform set_config('request.jwt.claims', json_build_object('sub', r1, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.book_class(v_s); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', r2, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.book_class(v_s); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', r3, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.book_class(v_s); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', r4, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.book_class(v_s); v_err := 'booked'; exception when others then v_err := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_err = 'SESSION_FULL', 'F: the fourth rider is refused: ' || v_err);
  perform pg_temp.must(pg_temp.bal(mr4) = 8 and (select count(*) from public.bookings where session_id = v_s and status in ('held', 'confirmed')) = 3, 'F: three places taken, the refused rider kept all classes');
  -- the weekly generator respects the same capacity
  perform set_config('request.jwt.claims', json_build_object('sub', r4, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.confirm_recurring_schedule((select jsonb_agg(jsonb_build_object('day_of_week', extract(dow from cs.session_date)::int, 'start_time', cs.start_time, 'end_time', cs.end_time)) from public.class_sessions cs where cs.id = v_s));
  reset role;
  perform pg_temp.must(not exists (select 1 from public.bookings where user_id = r4 and session_id = v_s and status in ('held', 'confirmed')), 'F: a weekly schedule cannot take the fourth place either');
  perform pg_temp.must((select count(*) from public.bookings where session_id = v_s and status in ('held', 'confirmed')) = 3, 'F: capacity is still exactly 3');

  -- ═══ Test G: failures are reported, and leave nothing behind ═══
  perform set_config('request.jwt.claims', json_build_object('sub', one, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.confirm_recurring_schedule(v_two); v_err := 'saved'; exception when others then v_err := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_err = 'PLAN_NOT_RECURRING', 'G: a One-Time Ride cannot save a weekly schedule: ' || v_err);
  perform pg_temp.must((select count(*) from public.recurring_schedules where user_id = one) = 0 and pg_temp.bal(mone) = 1, 'G: ...and nothing was saved or charged');
  perform set_config('request.jwt.claims', json_build_object('sub', r1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.confirm_recurring_schedule('[{"day_of_week": 9, "start_time": "05:00", "end_time": "06:00"}]'::jsonb); v_err := 'saved'; exception when others then v_err := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_err = 'INVALID_SLOTS', 'G: a time that is not in the timetable is refused: ' || v_err);
  perform set_config('request.jwt.claims', json_build_object('sub', r1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.confirm_recurring_schedule('[]'::jsonb); v_err := 'saved'; exception when others then v_err := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_err = 'INVALID_SLOTS', 'G: an empty schedule is refused: ' || v_err);
  perform set_config('request.jwt.claims', json_build_object('sub', r1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.confirm_recurring_schedule(v_three); v_err := 'saved'; exception when others then v_err := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_err = 'TOO_MANY_SLOTS', 'G: three weekly times on Gold are refused: ' || v_err);
  perform pg_temp.must((select count(*) from public.recurring_schedules where user_id = r1) = 0 and pg_temp.bal(mr1) = 7 and pg_temp.live(mr1) = 1, 'G: the failed saves left no schedule, no booking and no charge beyond the earlier class');
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  begin perform public.confirm_recurring_schedule(v_two); v_err := 'saved'; exception when others then v_err := sqlerrm; end;
  reset role;
  perform pg_temp.must(v_err like 'permission denied%', 'G: signed-out callers cannot save a schedule: ' || v_err);
  -- one member cannot see or change another's schedule
  perform set_config('request.jwt.claims', json_build_object('sub', g2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform pg_temp.must((public.my_recurring_schedule() ->> 'schedule_id')::uuid <> v_sch, 'G: my_recurring_schedule returns only the caller''s own schedule');
  reset role;

  raise notice 'ALL PHASE 22 CHECKS PASSED';
end $$;

rollback;
