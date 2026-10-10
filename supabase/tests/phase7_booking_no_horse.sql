-- Phase 7 test: a booking is a place in a class and no horse exists anywhere. NOT YET RUN.
-- Apply 0022_no_horses.sql first, then run this in the SQL Editor.
-- One transaction, ends in ROLLBACK (nothing persists). A failed check aborts with
-- "FAIL: ..."; success prints "ALL PHASE 7 CHECKS PASSED".
--
-- Harness rule: role switching is done inline (set_config + SET LOCAL ROLE / RESET
-- ROLE). No helper functions are called while impersonating.

begin;

-- Test-only: allow promoting the throwaway admin inside this transaction.
alter table public.profiles disable trigger trg_prevent_privilege_escalation;

do $$
declare
  v_a uuid := gen_random_uuid();       -- rider A
  v_b uuid := gen_random_uuid();       -- rider B
  v_c uuid := gen_random_uuid();       -- rider C
  v_d uuid := gen_random_uuid();       -- rider D (fourth)
  v_admin uuid := gen_random_uuid();
  v_plan uuid;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_d1 date := (now() at time zone 'Asia/Kolkata')::date + 2;
  v_d2 date := (now() at time zone 'Asia/Kolkata')::date + 3;
  v_s1 uuid; v_s2 uuid;
  v_bk public.bookings; v_new public.bookings;
  v_n int; v_body text;
begin
  -- nothing horse-shaped is left in the schema --------------------------------
  if to_regclass('public.horses') is not null then raise exception 'FAIL: the horses table still exists'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and column_name ilike '%horse%') then
    raise exception 'FAIL: a column still refers to a horse'; end if;
  select count(*) into v_n from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and (p.proname ilike '%horse%' or p.prosrc ilike '%horse%' or pg_get_function_arguments(p.oid) ilike '%horse%');
  if v_n <> 0 then raise exception 'FAIL: % function(s) still refer to a horse', v_n; end if;
  if (select (value #>> '{}')::int from public.system_settings where key = 'default_session_capacity') is null then
    raise exception 'FAIL: riders per class (default_session_capacity) is not set'; end if;

  -- people ---------------------------------------------------------------------
  select id into v_plan from public.membership_plans where plan_code = 'GOLD';
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select u, 'p7-' || left(u::text, 8) || '@test.invalid', '{"full_name":"Test Rider"}', 'authenticated', 'authenticated'
  from unnest(array[v_a, v_b, v_c, v_d, v_admin]) u;
  update public.profiles set role = 'admin' where id = v_admin;

  insert into public.memberships (user_id, plan_id, status, start_date, end_date, total_credits, reschedules_allowed, reschedules_used)
  select u, v_plan, 'active', v_today, v_today + 29, 8, 2, 0 from unnest(array[v_a, v_b, v_c, v_d]) u;
  insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description)
  select m.user_id, m.id, 8, 'membership_purchase', 'test' from public.memberships m where m.user_id in (v_a, v_b, v_c, v_d);

  -- two classes of our own, three places each (midday, so they clash with nothing real)
  insert into public.class_sessions (session_date, start_time, end_time, capacity, status)
  values (v_d1, '12:00', '13:00', 3, 'open') returning id into v_s1;
  insert into public.class_sessions (session_date, start_time, end_time, capacity, status)
  values (v_d2, '12:00', '13:00', 3, 'open') returning id into v_s2;

  -- signed-out callers learn nothing
  select count(*) into v_n from public.session_availability(v_d1);
  if v_n <> 0 then raise exception 'FAIL: session_availability must return nothing without a signed-in user'; end if;

  -- rider A books a place ------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.session_availability(v_d1) sa where sa.session_id = v_s1 and sa.places_left = 3 and not sa.is_mine and sa.is_bookable;
  if v_n <> 1 then reset role; raise exception 'FAIL: a fresh class should show 3 places, not mine, bookable'; end if;
  v_bk := public.book_class(v_s1);
  select count(*) into v_n from public.session_availability(v_d1) sa where sa.session_id = v_s1 and sa.places_left = 2 and sa.is_mine;
  reset role;
  if v_n <> 1 then raise exception 'FAIL: after booking, 2 places left and marked as mine'; end if;
  if (select coalesce(sum(amount), 0) from public.credit_ledger where user_id = v_a) <> 7 then
    raise exception 'FAIL: booking should use exactly one class'; end if;

  -- what each side is told: the slot, and for staff the rider — nothing else
  select body into v_body from public.notifications
  where audience = 'user' and user_id = v_a and type = 'booking_confirmed' order by created_at desc limit 1;
  if v_body is null or v_body like '% · %' then
    raise exception 'FAIL: the rider confirmation should be the slot only (got: %)', v_body; end if;
  select body into v_body from public.notifications
  where audience = 'admin' and type = 'booking_created' and data ->> 'booking_id' = v_bk.id::text;
  if v_body is null or array_length(string_to_array(v_body, ' · '), 1) <> 2 then
    raise exception 'FAIL: the staff notification should be "rider · slot" (got: %)', v_body; end if;

  -- the same rider cannot take a second place in the same class
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.book_class(v_s1);
    reset role;
    raise exception 'FAIL: a rider booked the same class twice';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'DUPLICATE_BOOKING%' then raise exception 'FAIL: expected DUPLICATE_BOOKING, got %', sqlerrm; end if;
  end;

  -- B and C fill the class -----------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.session_availability(v_d1) sa where sa.session_id = v_s1 and sa.places_left = 2 and not sa.is_mine;
  perform public.book_class(v_s1);
  reset role;
  if v_n <> 1 then raise exception 'FAIL: rider B should see 2 places and not "mine"'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.book_class(v_s1);
  select count(*) into v_n from public.session_availability(v_d1) sa where sa.session_id = v_s1 and sa.places_left = 0;
  reset role;
  if v_n <> 1 then raise exception 'FAIL: three riders should fill the class (0 places left)'; end if;

  -- a fourth rider does not fit, and loses nothing -----------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.book_class(v_s1);
    reset role;
    raise exception 'FAIL: a fourth rider was allowed into a full class';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'SESSION_FULL%' then raise exception 'FAIL: expected SESSION_FULL, got %', sqlerrm; end if;
  end;
  if (select coalesce(sum(amount), 0) from public.credit_ledger where user_id = v_d) <> 8 then
    raise exception 'FAIL: the refused rider lost a class'; end if;

  -- only staff change the places of a class ------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.admin_set_session_capacity(v_s1, 4);
    reset role;
    raise exception 'FAIL: a rider changed the places of a class';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'NOT_AUTHORIZED%' then raise exception 'FAIL: expected NOT_AUTHORIZED, got %', sqlerrm; end if;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.admin_set_session_capacity(v_s1, 2);
    reset role;
    raise exception 'FAIL: places were set below the riders already booked';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'CAPACITY_BELOW_BOOKINGS%' then raise exception 'FAIL: expected CAPACITY_BELOW_BOOKINGS, got %', sqlerrm; end if;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.admin_set_session_capacity(v_s1, 13);
    reset role;
    raise exception 'FAIL: 13 places was accepted';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'INVALID_CAPACITY%' then raise exception 'FAIL: expected INVALID_CAPACITY, got %', sqlerrm; end if;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_set_session_capacity(v_s1, 4);
  reset role;
  if (select capacity from public.class_sessions where id = v_s1) <> 4 then raise exception 'FAIL: places should now be 4'; end if;
  if not exists (select 1 from public.audit_logs where action = 'SET_SESSION_CAPACITY' and record_id = v_s1) then
    raise exception 'FAIL: the places change was not written to the audit log'; end if;

  -- with a fourth place, rider D now fits
  perform set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.book_class(v_s1);
  select count(*) into v_n from public.session_availability(v_d1) sa where sa.session_id = v_s1 and sa.places_left = 0 and sa.is_mine;
  reset role;
  if v_n <> 1 then raise exception 'FAIL: the fourth place should be taken by rider D'; end if;

  -- what staff see: riders per class, and an empty class still listed ----------
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.admin_session_roster(v_d1) r where r.session_id = v_s1 and r.booking_id is not null and r.capacity = 4;
  if v_n <> 4 then reset role; raise exception 'FAIL: the roster should list 4 riders in the first class (saw %)', v_n; end if;
  select count(*) into v_n from public.admin_session_roster(v_d2) r where r.session_id = v_s2 and r.booking_id is null and r.capacity = 3;
  if v_n <> 1 then reset role; raise exception 'FAIL: an empty class should appear once on the roster'; end if;
  select count(*) into v_n from public.admin_dashboard_metrics();
  reset role;
  if v_n <> 1 then raise exception 'FAIL: the dashboard figures should be one row'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform count(*) from public.admin_session_roster(v_d1);
    reset role;
    raise exception 'FAIL: a rider read the staff roster';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'NOT_AUTHORIZED%' then raise exception 'FAIL: expected NOT_AUTHORIZED, got %', sqlerrm; end if;
  end;

  -- moving a class: same class is refused, another class works, no class is used
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.reschedule_booking(v_bk.id, v_s1);
    reset role;
    raise exception 'FAIL: a class was moved onto itself';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'SAME_SLOT%' then raise exception 'FAIL: expected SAME_SLOT, got %', sqlerrm; end if;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_new := public.reschedule_booking(v_bk.id, v_s2);
  select count(*) into v_n from public.session_availability(v_d1) sa where sa.session_id = v_s1 and sa.places_left = 1 and not sa.is_mine;
  reset role;
  if v_n <> 1 then raise exception 'FAIL: moving a class should free its place in the old class'; end if;
  if v_new.session_id <> v_s2 or v_new.status <> 'confirmed' then raise exception 'FAIL: the moved class should be confirmed in the new class'; end if;
  if (select status from public.bookings where id = v_bk.id) <> 'rescheduled' then raise exception 'FAIL: the old booking should be marked rescheduled'; end if;
  if (select coalesce(sum(amount), 0) from public.credit_ledger where user_id = v_a) <> 7 then
    raise exception 'FAIL: moving a class must not use another class'; end if;
  if (select reschedules_used from public.memberships where user_id = v_a) <> 1 then
    raise exception 'FAIL: the move should count as one reschedule'; end if;

  -- reminders say when, and nothing else ---------------------------------------
  update public.system_settings set value = '168'::jsonb where key = 'class_reminder_hours';
  perform public.send_lifecycle_notifications();
  select count(*) into v_n from public.notifications
  where audience = 'user' and type = 'class_reminder' and user_id in (v_a, v_b, v_c, v_d);
  if v_n <> 4 then raise exception 'FAIL: expected 4 class reminders, saw %', v_n; end if;
  select count(*) into v_n from public.notifications
  where audience = 'user' and type in ('booking_confirmed', 'class_reminder') and user_id in (v_a, v_b, v_c, v_d) and body like '% · %';
  if v_n <> 0 then raise exception 'FAIL: % rider notification(s) carry more than the slot', v_n; end if;

  -- new classes get their places from the setting ------------------------------
  perform public.generate_future_sessions();
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.generate_sessions(v_today + 60, v_today + 66);
  perform set_config('request.jwt.claims', '', true);
  if exists (select 1 from public.class_sessions cs left join public.schedule_templates t on t.id = cs.template_id
             where cs.session_date between v_today + 60 and v_today + 66
               and cs.capacity <> coalesce(t.capacity, (select (value #>> '{}')::int from public.system_settings where key = 'default_session_capacity'))) then
    raise exception 'FAIL: a generated class did not take its places from the template or the setting'; end if;

  raise notice 'ALL PHASE 7 CHECKS PASSED';
end $$;

rollback;
