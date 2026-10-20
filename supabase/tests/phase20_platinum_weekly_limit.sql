-- Phase 20 test: Platinum can hold 4 classes in a week, Gold stays at 3, credits stay exact (0035).
-- Apply 0016-0035 first. One transaction, ends in ROLLBACK; test users are @test.invalid. Prints
-- "ALL PHASE 20 CHECKS PASSED". It drives the real book_class / reschedule_booking / member_current_block_usage.
begin;

alter table public.profiles disable trigger trg_prevent_privilege_escalation;

create function pg_temp.mk(p_user uuid, p_plan text, p_credits int) returns uuid language plpgsql as $$
declare v_id uuid; v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  insert into public.memberships (user_id, plan_id, status, start_date, end_date, total_credits, reschedules_allowed, reschedules_used)
  select p_user, p.id, 'active', v_today, v_today + 29, p_credits, p.reschedules_allowed, 0
  from public.membership_plans p where p.plan_code = p_plan returning id into v_id;
  insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description)
  values (p_user, v_id, p_credits, 'membership_purchase', 'test');
  return v_id;
end $$;

create function pg_temp.bal(p_m uuid) returns int language sql as $$
  select coalesce(sum(amount), 0)::int from public.credit_ledger where membership_id = p_m $$;

do $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_p uuid := gen_random_uuid(); v_g uuid := gen_random_uuid(); v_o uuid := gen_random_uuid();
  v_mp uuid; v_mg uuid; v_mo uuid;
  v_s uuid[]; v_b uuid[] := '{}'; v_id uuid; v_err text; v_i int; v_row record; v_before int;
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select u, 'p20-' || left(u::text, 8) || '@test.invalid', '{"full_name":"Test Rider"}', 'authenticated', 'authenticated'
  from unnest(array[v_p, v_g, v_o]) u;

  -- Plan configuration the migration relies on.
  if (select recurring_slots_per_week from public.membership_plans where plan_code = 'PLATINUM') <> 4 then raise exception 'FAIL: Platinum should allow 4 a week'; end if;
  if (select recurring_slots_per_week from public.membership_plans where plan_code = 'GOLD') <> 2 then raise exception 'FAIL: Gold should allow 2 recurring slots a week'; end if;
  if (select (value #>> '{}')::int from public.system_settings where key = 'weekly_class_limit') <> 3 then raise exception 'FAIL: the shared weekly_class_limit setting must stay 3 (Gold is unchanged)'; end if;

  -- Six empty, future classes inside the first 7-day block (they start today, so the block is today .. today+6).
  select array_agg(id) into v_s from (
    select cs.id from public.class_sessions cs
    where cs.session_date between v_today and v_today + 6 and cs.status = 'open'
      and (cs.session_date + cs.start_time) > (now() at time zone 'Asia/Kolkata') + interval '1 hour'
      and not exists (select 1 from public.bookings b where b.session_id = cs.id and b.status in ('held', 'confirmed', 'completed', 'no_show'))
    order by cs.session_date, cs.start_time limit 6) x;
  if coalesce(array_length(v_s, 1), 0) < 6 then raise notice 'SKIPPED: fewer than 6 empty classes in the next 6 days (generate sessions first)'; return; end if;

  v_mp := pg_temp.mk(v_p, 'PLATINUM', 15);
  v_mg := pg_temp.mk(v_g, 'GOLD', 8);

  -- ── Platinum: four in one 7-day block, the fifth refused and not charged ──
  perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
  set local role authenticated;
  for v_i in 1..4 loop
    select (book_class).id into v_id from public.book_class(v_s[v_i]);
    v_b := v_b || v_id;
  end loop;
  select * into v_row from public.member_current_block_usage();
  reset role;
  if v_row.block_class_limit <> 4 or v_row.block_classes_used <> 4 or v_row.block_classes_remaining <> 0 then
    raise exception 'FAIL: Platinum block usage should read limit 4 / used 4 / remaining 0, got % / % / %', v_row.block_class_limit, v_row.block_classes_used, v_row.block_classes_remaining;
  end if;
  if pg_temp.bal(v_mp) <> 11 then raise exception 'FAIL: four bookings should leave Platinum with 11 credits, got %', pg_temp.bal(v_mp); end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.book_class(v_s[5]);
    v_err := 'booked';
  exception when others then v_err := sqlerrm;
  end;
  reset role;
  if v_err <> 'WEEKLY_LIMIT_REACHED' then raise exception 'FAIL: the fifth class in a week must be refused with WEEKLY_LIMIT_REACHED, got %', v_err; end if;
  if pg_temp.bal(v_mp) <> 11 then raise exception 'FAIL: a refused booking must not touch credits (balance %)', pg_temp.bal(v_mp); end if;
  if (select count(*) from public.bookings where user_id = v_p and status in ('held', 'confirmed')) <> 4 then raise exception 'FAIL: a refused booking must not leave a booking row'; end if;

  -- ── Platinum: moving one of four into another class of the same full week works (limit 4, no credit change) ──
  perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.reschedule_booking(v_b[1], v_s[5]);
    v_err := 'moved';
  exception when others then v_err := sqlerrm;
  end;
  reset role;
  if v_err <> 'moved' then raise exception 'FAIL: Platinum should be able to move a class within a full 4-class week, got %', v_err; end if;
  if pg_temp.bal(v_mp) <> 11 then raise exception 'FAIL: rescheduling must not change credits (balance %)', pg_temp.bal(v_mp); end if;
  if (select reschedules_used from public.memberships where id = v_mp) <> 1 then raise exception 'FAIL: one reschedule should be counted'; end if;

  -- ── Gold: unchanged, three then refused ──
  perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
  set local role authenticated;
  for v_i in 1..3 loop perform public.book_class(v_s[v_i]); end loop;
  select * into v_row from public.member_current_block_usage();
  begin
    perform public.book_class(v_s[4]);
    v_err := 'booked';
  exception when others then v_err := sqlerrm;
  end;
  reset role;
  if v_row.block_class_limit <> 3 then raise exception 'FAIL: Gold weekly limit must stay 3, got %', v_row.block_class_limit; end if;
  if v_err <> 'WEEKLY_LIMIT_REACHED' then raise exception 'FAIL: Gold fourth class in a week must be refused, got %', v_err; end if;
  if pg_temp.bal(v_mg) <> 5 then raise exception 'FAIL: Gold should have 5 credits left, got %', pg_temp.bal(v_mg); end if;

  -- ── Another member cannot move or cancel Platinum's booking ──
  perform set_config('request.jwt.claims', json_build_object('sub', v_g, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.reschedule_booking(v_b[2], v_s[6]);
    v_err := 'moved';
  exception when others then v_err := sqlerrm;
  end;
  reset role;
  if v_err = 'moved' then raise exception 'FAIL: a member moved another member''s booking'; end if;

  raise notice 'ALL PHASE 20 CHECKS PASSED';
end $$;

rollback;
