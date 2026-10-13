-- Phase 10 test: waitlist, upcoming-class limit, weekly timetable, enquiry status. NOT YET RUN.
-- Apply 0025_waitlist_limits_timetable_enquiries.sql first, then run this in the SQL Editor.
-- One transaction, ends in ROLLBACK (nothing persists). A failed check aborts with
-- "FAIL: ..."; success prints "ALL PHASE 10 CHECKS PASSED".
--
-- Harness rule: role switching is done inline (set_config + SET LOCAL ROLE / RESET
-- ROLE). No helper functions are called while impersonating.

begin;

alter table public.profiles disable trigger trg_prevent_privilege_escalation;

do $$
declare
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_d uuid := gen_random_uuid();   -- joins the waitlist
  v_admin uuid := gen_random_uuid();
  v_plan uuid;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_d1 date := (now() at time zone 'Asia/Kolkata')::date + 2;
  v_d2 date := (now() at time zone 'Asia/Kolkata')::date + 3;
  v_s1 uuid; v_s2 uuid;
  v_bk_a public.bookings;
  v_t public.schedule_templates; v_t2 public.schedule_templates;
  v_enq uuid;
  v_n int;
begin
  select id into v_plan from public.membership_plans where plan_code = 'GOLD';
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select u, 'p10-' || left(u::text, 8) || '@test.invalid', '{"full_name":"Test Rider"}', 'authenticated', 'authenticated'
  from unnest(array[v_a, v_b, v_c, v_d, v_admin]) u;
  update public.profiles set role = 'admin' where id = v_admin;

  insert into public.memberships (user_id, plan_id, status, start_date, end_date, total_credits, reschedules_allowed, reschedules_used)
  select u, v_plan, 'active', v_today, v_today + 29, 8, 2, 0 from unnest(array[v_a, v_b, v_c, v_d]) u;
  insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description)
  select m.user_id, m.id, 8, 'membership_purchase', 'test' from public.memberships m where m.user_id in (v_a, v_b, v_c, v_d);

  insert into public.class_sessions (session_date, start_time, end_time, capacity, status) values (v_d1, '12:00', '13:00', 3, 'open') returning id into v_s1;
  insert into public.class_sessions (session_date, start_time, end_time, capacity, status) values (v_d2, '12:00', '13:00', 3, 'open') returning id into v_s2;

  -- A, B, C fill class 1
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated; v_bk_a := public.book_class(v_s1); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.book_class(v_s1); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', v_c, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.book_class(v_s1); reset role;

  -- waitlist is off by default ---------------------------------------------------
  update public.system_settings set value = 'false'::jsonb where key = 'waitlist_enabled';
  perform set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.join_waitlist(v_s1); reset role;
    raise exception 'FAIL: joined a waitlist that is switched off';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'WAITLIST_DISABLED%' then raise exception 'FAIL: expected WAITLIST_DISABLED, got %', sqlerrm; end if;
  end;

  update public.system_settings set value = 'true'::jsonb where key = 'waitlist_enabled';

  -- a class with a free place cannot be queued for -------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.join_waitlist(v_s2); reset role;
    raise exception 'FAIL: joined the waitlist of a class with free places';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'SESSION_NOT_FULL%' then raise exception 'FAIL: expected SESSION_NOT_FULL, got %', sqlerrm; end if;
  end;

  -- D joins the full class; joining twice is harmless --------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.join_waitlist(v_s1);
  perform public.join_waitlist(v_s1);
  select count(*) into v_n from public.waitlist_entries where session_id = v_s1 and user_id = v_d;
  reset role;
  if v_n <> 1 then raise exception 'FAIL: one rider should have exactly one waitlist entry (got %)', v_n; end if;

  -- a rider cannot write the table directly, nor read another's entry
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.waitlist_entries;
  begin
    insert into public.waitlist_entries (session_id, user_id) values (v_s1, v_a);
    reset role;
    raise exception 'FAIL: a rider wrote to waitlist_entries directly';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  if v_n <> 0 then raise exception 'FAIL: rider A can see someone else''s waitlist entry'; end if;

  -- A cancels: D is told, once ---------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.cancel_booking(v_bk_a.id, 'test'); reset role;
  select count(*) into v_n from public.notifications where audience = 'user' and user_id = v_d and type = 'waitlist_place_free';
  if v_n <> 1 then raise exception 'FAIL: the waiting rider should get exactly one notice (got %)', v_n; end if;
  if (select notified_at from public.waitlist_entries where session_id = v_s1 and user_id = v_d) is null then
    raise exception 'FAIL: the waitlist entry should record that D was told'; end if;

  -- D books the place and leaves the queue ---------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_d, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.book_class(v_s1); reset role;
  select count(*) into v_n from public.waitlist_entries where session_id = v_s1 and user_id = v_d;
  if v_n <> 0 then raise exception 'FAIL: a rider who booked should leave the waitlist'; end if;

  -- upcoming-class limit --------------------------------------------------------------------------
  update public.system_settings set value = '1'::jsonb where key = 'max_future_bookings';
  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.book_class(v_s2); reset role;
    raise exception 'FAIL: booked past max_future_bookings';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'FUTURE_BOOKING_LIMIT%' then raise exception 'FAIL: expected FUTURE_BOOKING_LIMIT, got %', sqlerrm; end if;
  end;
  update public.system_settings set value = '8'::jsonb where key = 'max_future_bookings';

  -- weekly timetable (Monday has no active slots, so nothing real clashes) -------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.admin_save_template(null, 1, '12:00', '13:00', null, true); reset role;
    raise exception 'FAIL: a rider changed the timetable';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'NOT_AUTHORIZED%' then raise exception 'FAIL: expected NOT_AUTHORIZED, got %', sqlerrm; end if;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_t := public.admin_save_template(null, 1, '12:00', '13:00', 2, true);
  begin
    perform public.admin_save_template(null, 1, '12:30', '13:30', null, true); reset role;
    raise exception 'FAIL: overlapping timetable slots were accepted';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'TEMPLATE_OVERLAP%' then raise exception 'FAIL: expected TEMPLATE_OVERLAP, got %', sqlerrm; end if;
  end;
  set local role authenticated;
  v_t2 := public.admin_save_template(null, 1, '13:00', '14:00', null, true);   -- touching, not overlapping
  v_t := public.admin_save_template(v_t.id, 1, '12:00', '13:00', 2, false);    -- switched off
  begin
    perform public.admin_save_template(null, 1, '12:00', '13:00', 99, true); reset role;
    raise exception 'FAIL: capacity 99 was accepted';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'INVALID_VALUE%' then raise exception 'FAIL: expected INVALID_VALUE, got %', sqlerrm; end if;
  end;
  if v_t.is_active then raise exception 'FAIL: the slot should be switched off'; end if;

  -- enquiries ------------------------------------------------------------------------------------------
  insert into public.enquiries (name, age, email, phone, topic) values ('Test Visitor', 20, 'v@test.invalid', '9999999999', 'Test')
  returning id into v_enq;
  if (select status from public.enquiries where id = v_enq) <> 'new' then raise exception 'FAIL: a new enquiry should start as new'; end if;
  select count(*) into v_n from public.notifications where audience = 'admin' and type = 'enquiry_new' and data ->> 'enquiry_id' = v_enq::text;
  if v_n <> 1 then raise exception 'FAIL: a new enquiry should ring the admin bell once (got %)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.admin_set_enquiry_status(v_enq, 'answered'); reset role;
    raise exception 'FAIL: a rider changed an enquiry';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL:%' then raise; end if;
    if sqlerrm not like 'NOT_AUTHORIZED%' then raise exception 'FAIL: expected NOT_AUTHORIZED, got %', sqlerrm; end if;
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated; perform public.admin_set_enquiry_status(v_enq, 'answered'); reset role;
  if (select status from public.enquiries where id = v_enq) <> 'answered'
     or (select handled_by from public.enquiries where id = v_enq) is distinct from v_admin then
    raise exception 'FAIL: marking answered should record who did it'; end if;
  set local role authenticated; perform public.admin_set_enquiry_status(v_enq, 'new'); reset role;
  if (select handled_at from public.enquiries where id = v_enq) is not null then
    raise exception 'FAIL: reopening should clear the handled time'; end if;

  raise notice 'ALL PHASE 10 CHECKS PASSED';
end $$;

rollback;
