-- Recurring weekly class bookings.
-- Requires 0016–0026. Runs in one transaction; safe to run more than once.
-- PROPOSAL: nothing here has been applied to the live database.
--
-- A member picks their preferred weekdays and times (a "weekly schedule"). The
-- server then books the matching real class sessions for the rest of the
-- membership, one booking and one credit each, through the same ledger, capacity
-- and membership rules as book_class(). The schedule is only the preference;
-- bookings stay ordinary bookings (cancel, reschedule, attendance all unchanged).
--
--  1. Platinum is 15 classes (live already is; this keeps fresh databases equal).
--     Only the plan row changes: purchased memberships keep the credits they were
--     sold with (memberships.total_credits / credit_ledger are untouched).
--  2. membership_plans.recurring_slots_per_week: how many weekly slots a plan may
--     reserve (Gold 2, Platinum 4, One-Time Ride 0).
--  3. recurring_schedules / recurring_schedule_slots / recurring_occurrences.
--     An occurrence is one (schedule, class session) pair and is unique, which is
--     what makes generation safe to retry: a session is never booked twice, and a
--     booking the member cancelled is never silently re-created.
--  4. confirm_recurring_schedule(slots), end_recurring_schedule(),
--     my_recurring_schedule(), book_replacement(booking, session): member actions.
--  5. admin_excuse_booking(booking, reason): staff excuse one class, restore exactly
--     one credit (idempotent, same unique index as absences), keep the schedule.
--  6. generate_recurring_bookings(): daily job; also retries slots that were full.
--  7. session_availability_range(from, to): a week of availability in one call.
--
-- Capacity: "all horses booked" is the session's places (capacity, set per class
-- or from default_session_capacity = 3). There is no horse table since 0022.
--
-- Not changed: book_class, reschedule_booking, cancel_booking, admin_mark_attendance,
-- payment and activation functions, the weekly_class_limit / max_future_bookings
-- settings, or any existing booking, credit or attendance row.

begin;

-- ─── 1–2. Plans ─────────────────────────────────────────────────────────────
update public.membership_plans set class_credits = 15
where plan_code = 'PLATINUM' and class_credits = 12;

alter table public.membership_plans
  add column if not exists recurring_slots_per_week smallint not null default 0
  check (recurring_slots_per_week between 0 and 7);

update public.membership_plans set recurring_slots_per_week = 2 where plan_code = 'GOLD' and recurring_slots_per_week = 0;
update public.membership_plans set recurring_slots_per_week = 4 where plan_code = 'PLATINUM' and recurring_slots_per_week = 0;

-- ─── 3. Tables ──────────────────────────────────────────────────────────────
create table if not exists public.recurring_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  membership_id uuid not null references public.memberships(id),
  status text not null default 'active' check (status in ('active', 'ended')),
  end_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);
create unique index if not exists uq_recurring_one_active_per_membership
  on public.recurring_schedules (membership_id) where status = 'active';
create index if not exists idx_recurring_schedules_user on public.recurring_schedules (user_id);

create table if not exists public.recurring_schedule_slots (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.recurring_schedules(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  constraint recurring_slot_unique unique (schedule_id, day_of_week, start_time),
  constraint recurring_slot_times check (end_time > start_time)
);

create table if not exists public.recurring_occurrences (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.recurring_schedules(id),
  user_id uuid not null references public.profiles(id),
  session_id uuid not null references public.class_sessions(id),
  booking_id uuid references public.bookings(id),
  replacement_booking_id uuid references public.bookings(id),
  -- booked: a booking exists (its own status — cancelled, absent… — lives on the booking)
  -- skipped_full: the class was full (retried until it starts) · skipped_no_credits: credits ran out (final)
  -- skipped_other: weekly cap or similar (final) · replaced: an excused class was replaced
  status text not null check (status in ('booked', 'skipped_full', 'skipped_no_credits', 'skipped_other', 'replaced')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_occurrence_schedule_session unique (schedule_id, session_id)
);
create unique index if not exists uq_occurrence_booking on public.recurring_occurrences (booking_id) where booking_id is not null;
create unique index if not exists uq_occurrence_replacement on public.recurring_occurrences (replacement_booking_id) where replacement_booking_id is not null;
create index if not exists idx_occurrences_user on public.recurring_occurrences (user_id);

alter table public.recurring_schedules enable row level security;
alter table public.recurring_schedule_slots enable row level security;
alter table public.recurring_occurrences enable row level security;

drop policy if exists "Members read own recurring schedules" on public.recurring_schedules;
create policy "Members read own recurring schedules" on public.recurring_schedules
  for select to authenticated using (user_id = auth.uid() or public.is_staff_or_admin());
drop policy if exists "Members read own recurring slots" on public.recurring_schedule_slots;
create policy "Members read own recurring slots" on public.recurring_schedule_slots
  for select to authenticated using (exists (
    select 1 from public.recurring_schedules s
    where s.id = schedule_id and (s.user_id = auth.uid() or public.is_staff_or_admin())));
drop policy if exists "Members read own recurring occurrences" on public.recurring_occurrences;
create policy "Members read own recurring occurrences" on public.recurring_occurrences
  for select to authenticated using (user_id = auth.uid() or public.is_staff_or_admin());
-- No insert/update/delete policies: every write goes through the functions below.

revoke all on public.recurring_schedules, public.recurring_schedule_slots, public.recurring_occurrences from anon;
revoke insert, update, delete, truncate on public.recurring_schedules, public.recurring_schedule_slots, public.recurring_occurrences from authenticated;

-- ─── 4a. The one place a recurring booking is made ──────────────────────────
-- The same checks and writes as book_class() (session row lock, then membership
-- row lock, ledger balance, one active booking per rider per class, capacity),
-- minus its notifications (a schedule sends one summary) and its
-- max_future_bookings cap (a schedule books ahead by design). The weekly cap is
-- the plan's recurring_slots_per_week, counted over the same membership blocks.
create or replace function public._recurring_try_book(p_user uuid, p_membership uuid, p_session uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_session public.class_sessions;
  v_m public.memberships;
  v_slots int;
  v_balance int;
  v_booked int;
  v_block_days int;
  v_week_index int;
  v_week_count int;
  v_existing uuid;
  v_booking public.bookings;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select * into v_session from public.class_sessions where id = p_session for update;
  if not found or v_session.status <> 'open'
     or (v_session.session_date + v_session.start_time) <= (now() at time zone 'Asia/Kolkata') then
    return jsonb_build_object('outcome', 'not_open');
  end if;

  select * into v_m from public.memberships where id = p_membership and user_id = p_user for update;
  if not found or v_m.status <> 'active' or v_m.end_date < v_today
     or v_m.end_date < v_session.session_date or v_m.start_date > v_session.session_date then
    return jsonb_build_object('outcome', 'membership_invalid');
  end if;

  select coalesce(sum(amount), 0) into v_balance from public.credit_ledger where membership_id = v_m.id;
  if v_balance <= 0 then return jsonb_build_object('outcome', 'no_credits'); end if;

  select id into v_existing from public.bookings
  where user_id = p_user and session_id = p_session and status in ('held', 'confirmed');
  if found then return jsonb_build_object('outcome', 'duplicate', 'booking_id', v_existing); end if;

  select coalesce(p.recurring_slots_per_week, 0) into v_slots
  from public.membership_plans p where p.id = v_m.plan_id;
  v_block_days := coalesce((select (value #>> '{}')::int from public.system_settings where key = 'membership_block_days'), 7);
  v_week_index := (v_session.session_date - v_m.start_date) / v_block_days;
  select count(*) into v_week_count
  from public.bookings b join public.class_sessions cs on cs.id = b.session_id
  where b.membership_id = v_m.id and b.status in ('held', 'confirmed', 'completed', 'no_show')
    and (cs.session_date - v_m.start_date) / v_block_days = v_week_index;
  if v_week_count >= v_slots then return jsonb_build_object('outcome', 'weekly_cap'); end if;

  select count(*) into v_booked from public.bookings where session_id = p_session and status in ('held', 'confirmed');
  if v_booked >= v_session.capacity then return jsonb_build_object('outcome', 'full'); end if;

  begin
    insert into public.bookings (user_id, membership_id, session_id, status, booked_at)
    values (p_user, v_m.id, p_session, 'confirmed', now())
    returning * into v_booking;
  exception when unique_violation then
    select id into v_existing from public.bookings
    where user_id = p_user and session_id = p_session and status in ('held', 'confirmed');
    return jsonb_build_object('outcome', 'duplicate', 'booking_id', v_existing);
  end;

  insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type, description)
  values (p_user, v_m.id, v_booking.id, -1, 'booking', 'Class booked (weekly schedule)');
  delete from public.waitlist_entries where session_id = p_session and user_id = p_user;
  perform public._audit('bookings', v_booking.id, 'BOOKING_CREATED', null,
    jsonb_build_object('session_id', p_session, 'membership_id', v_m.id, 'source', 'recurring'));

  return jsonb_build_object('outcome', 'booked', 'booking_id', v_booking.id);
end;
$$;

-- ─── 4b. Books the schedule's upcoming classes (idempotent) ─────────────────
create or replace function public._recurring_generate(p_schedule uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sch public.recurring_schedules;
  v_m public.memberships;
  v_s public.class_sessions;
  v_occ public.recurring_occurrences;
  v_r jsonb;
  v_out text;
  v_inserted boolean;
  v_booked int := 0;
  v_full_new int := 0;
  v_nocredit int := 0;
  v_first uuid;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select * into v_sch from public.recurring_schedules where id = p_schedule and status = 'active' for update;
  if not found then return jsonb_build_object('booked', 0, 'full_new', 0, 'no_credits', 0); end if;

  select * into v_m from public.memberships where id = v_sch.membership_id;
  if not found or v_m.status <> 'active' or v_m.end_date < v_today then
    update public.recurring_schedules set status = 'ended', end_reason = 'membership_ended', ended_at = now(), updated_at = now()
    where id = v_sch.id;
    return jsonb_build_object('booked', 0, 'full_new', 0, 'no_credits', 0, 'ended', true);
  end if;

  for v_s in
    select cs.* from public.class_sessions cs
    join public.recurring_schedule_slots sl
      on sl.schedule_id = v_sch.id and sl.day_of_week = extract(dow from cs.session_date)::int
     and sl.start_time = cs.start_time and sl.end_time = cs.end_time
    where cs.session_date between v_today and v_m.end_date and cs.status = 'open'
      and (cs.session_date + cs.start_time) > (now() at time zone 'Asia/Kolkata')
    order by cs.session_date, cs.start_time
  loop
    select * into v_occ from public.recurring_occurrences where schedule_id = v_sch.id and session_id = v_s.id;
    -- Already handled (booked, excused, cancelled, out of credits…): never touched again.
    if found and v_occ.status <> 'skipped_full' then continue; end if;

    v_r := public._recurring_try_book(v_sch.user_id, v_sch.membership_id, v_s.id);
    v_out := v_r ->> 'outcome';
    if v_out in ('not_open', 'membership_invalid') then continue; end if;

    insert into public.recurring_occurrences (schedule_id, user_id, session_id, booking_id, status)
    values (v_sch.id, v_sch.user_id, v_s.id, nullif(v_r ->> 'booking_id', '')::uuid,
            case v_out when 'booked' then 'booked' when 'duplicate' then 'booked' when 'full' then 'skipped_full'
                       when 'no_credits' then 'skipped_no_credits' else 'skipped_other' end)
    on conflict (schedule_id, session_id) do update
      set status = excluded.status,
          booking_id = coalesce(excluded.booking_id, public.recurring_occurrences.booking_id),
          updated_at = now()
    returning (xmax = 0) into v_inserted;

    if v_out = 'booked' then
      v_booked := v_booked + 1;
      v_first := coalesce(v_first, (v_r ->> 'booking_id')::uuid);
    elsif v_out = 'full' and v_inserted then
      v_full_new := v_full_new + 1;
    elsif v_out = 'no_credits' and v_inserted then
      v_nocredit := v_nocredit + 1;
    end if;
  end loop;

  return jsonb_build_object('booked', v_booked, 'full_new', v_full_new, 'no_credits', v_nocredit, 'first_booking_id', v_first);
end;
$$;

-- ─── 4c. Member: confirm (or change) the weekly schedule ────────────────────
create or replace function public.confirm_recurring_schedule(p_slots jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_m public.memberships;
  v_limit int;
  v_plan_name text;
  v_balance int;
  v_n int;
  v_distinct int;
  v_valid int;
  v_sch public.recurring_schedules;
  v_created boolean := false;
  v_changed boolean := false;
  v_rows int;
  v_gen jsonb;
  v_booked int;
  v_norm jsonb;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_slots is null or jsonb_typeof(p_slots) <> 'array' then raise exception 'INVALID_SLOTS'; end if;

  begin
    select coalesce(jsonb_agg(jsonb_build_object('day_of_week', x.day_of_week, 'start_time', x.start_time, 'end_time', x.end_time)), '[]'::jsonb)
    into v_norm from jsonb_to_recordset(p_slots) as x(day_of_week int, start_time time, end_time time);
  exception when others then
    raise exception 'INVALID_SLOTS';
  end;

  select * into v_m from public.memberships m
  join public.membership_plans p on p.id = m.plan_id and p.recurring_slots_per_week > 0
  where m.user_id = v_uid and m.status = 'active' and m.end_date >= v_today
  order by m.end_date asc limit 1 for update of m;
  if not found then
    if exists (select 1 from public.memberships where user_id = v_uid and status = 'active' and end_date >= v_today) then
      raise exception 'PLAN_NOT_RECURRING' using detail = 'Your plan does not include a weekly schedule.';
    end if;
    raise exception 'NO_ACTIVE_MEMBERSHIP';
  end if;

  select coalesce(sum(amount), 0) into v_balance from public.credit_ledger where membership_id = v_m.id;
  -- Credits are needed to start a schedule; an existing one can be re-sent or edited at zero credits.

  select p.recurring_slots_per_week, p.name into v_limit, v_plan_name from public.membership_plans p where p.id = v_m.plan_id;
  select count(*), count(distinct (x.day_of_week, x.start_time)) into v_n, v_distinct from jsonb_to_recordset(v_norm) as x(day_of_week int, start_time time, end_time time);
  if v_n < 1 then raise exception 'INVALID_SLOTS' using detail = 'Choose at least one day and time.'; end if;
  if v_n <> v_distinct then raise exception 'INVALID_SLOTS' using detail = 'The same slot was chosen twice.'; end if;
  if v_n > v_limit then
    raise exception 'TOO_MANY_SLOTS' using detail = format('%s allows up to %s classes a week.', v_plan_name, v_limit);
  end if;

  select count(*) into v_valid from jsonb_to_recordset(v_norm) as x(day_of_week int, start_time time, end_time time)
  where x.day_of_week between 0 and 6 and exists (
    select 1 from public.schedule_templates t
    where t.is_active and t.day_of_week = x.day_of_week and t.start_time = x.start_time and t.end_time = x.end_time);
  if v_valid <> v_n then raise exception 'INVALID_SLOTS' using detail = 'One of those times is not in the club timetable.'; end if;

  select * into v_sch from public.recurring_schedules where membership_id = v_m.id and status = 'active' for update;
  if not found then
    if v_balance <= 0 then raise exception 'NO_CREDITS_REMAINING'; end if;
    insert into public.recurring_schedules (user_id, membership_id) values (v_uid, v_m.id) returning * into v_sch;
    v_created := true;
  end if;

  -- Changing preferences only edits the weekly pattern: bookings already made stay as they are.
  delete from public.recurring_schedule_slots s
  where s.schedule_id = v_sch.id
    and not exists (select 1 from jsonb_to_recordset(v_norm) as x(day_of_week int, start_time time, end_time time) where x.day_of_week = s.day_of_week and x.start_time = s.start_time);
  get diagnostics v_rows = row_count;
  v_changed := v_rows > 0;
  insert into public.recurring_schedule_slots (schedule_id, day_of_week, start_time, end_time)
  select v_sch.id, x.day_of_week, x.start_time, x.end_time from jsonb_to_recordset(v_norm) as x(day_of_week int, start_time time, end_time time)
  on conflict (schedule_id, day_of_week, start_time) do nothing;
  get diagnostics v_rows = row_count;
  v_changed := v_changed or v_rows > 0;
  if v_changed then update public.recurring_schedules set updated_at = now() where id = v_sch.id; end if;

  v_gen := public._recurring_generate(v_sch.id);
  v_booked := (v_gen ->> 'booked')::int;

  perform public._audit('recurring_schedules', v_sch.id, case when v_created then 'RECURRING_CREATED' else 'RECURRING_UPDATED' end,
    null, jsonb_build_object('slots', p_slots, 'booked', v_booked));

  -- One summary; a retry that changes nothing and books nothing sends nothing.
  if v_created or v_changed or v_booked > 0 then
    perform public._notify_user(v_uid, 'recurring_confirmed', 'Weekly schedule confirmed',
      format('%s class%s booked from your weekly schedule.', v_booked, case when v_booked = 1 then '' else 'es' end)
        || case when (v_gen ->> 'full_new')::int > 0
                then format(' %s could not be booked because the class is full.', v_gen ->> 'full_new') else '' end
        || case when (v_gen ->> 'no_credits')::int > 0
                then ' Your credits are used up for the rest.' else '' end,
      case when v_gen ->> 'first_booking_id' is not null
           then jsonb_build_object('booking_id', v_gen ->> 'first_booking_id') else '{}'::jsonb end);
    perform public._notify_admins('recurring_confirmed', 'Weekly schedule set',
      public._display_name(v_uid) || ' · ' || v_booked || ' class' || case when v_booked = 1 then '' else 'es' end || ' booked',
      jsonb_build_object('user_id', v_uid));
  end if;

  return jsonb_build_object('schedule_id', v_sch.id, 'created', v_created, 'changed', v_changed,
    'booked', v_booked, 'skipped_full', (v_gen ->> 'full_new')::int, 'skipped_no_credits', (v_gen ->> 'no_credits')::int);
end;
$$;

-- ─── 4d. Member: stop the weekly schedule (bookings already made are kept) ──
create or replace function public.end_recurring_schedule()
returns int language plpgsql security definer set search_path = public as $$
declare
  v_n int;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  update public.recurring_schedules
  set status = 'ended', end_reason = 'member_ended', ended_at = now(), updated_at = now()
  where user_id = auth.uid() and status = 'active';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ─── 4e. Member: the schedule, its occurrences and their live state ─────────
create or replace function public.my_recurring_schedule()
returns jsonb language sql stable security definer set search_path = public as $$
  with sch as (
    select s.* from public.recurring_schedules s
    where s.user_id = auth.uid() and s.status = 'active' order by s.created_at desc limit 1
  )
  select case when not exists (select 1 from sch) then null else jsonb_build_object(
    'schedule_id', (select id from sch),
    'membership_id', (select membership_id from sch),
    'plan_name', (select p.name from sch join public.memberships m on m.id = sch.membership_id join public.membership_plans p on p.id = m.plan_id),
    'slots_per_week', (select p.recurring_slots_per_week from sch join public.memberships m on m.id = sch.membership_id join public.membership_plans p on p.id = m.plan_id),
    'valid_until', (select m.end_date from sch join public.memberships m on m.id = sch.membership_id),
    'credits_remaining', (select coalesce(sum(l.amount), 0) from sch join public.credit_ledger l on l.membership_id = sch.membership_id),
    'slots', coalesce((select jsonb_agg(jsonb_build_object('day_of_week', sl.day_of_week, 'start_time', sl.start_time, 'end_time', sl.end_time)
                                         order by sl.day_of_week, sl.start_time)
                       from sch join public.recurring_schedule_slots sl on sl.schedule_id = sch.id), '[]'::jsonb),
    'occurrences', coalesce((select jsonb_agg(jsonb_build_object(
        'occurrence_id', o.id, 'session_id', o.session_id, 'session_date', cs.session_date,
        'start_time', cs.start_time, 'end_time', cs.end_time, 'status', o.status,
        'booking_id', o.booking_id, 'booking_status', b.status, 'attendance', a.status,
        'replacement_booking_id', o.replacement_booking_id,
        'can_replace', (o.replacement_booking_id is null and b.status = 'absent' and a.status = 'excused'
                        and exists (select 1 from public.credit_ledger l where l.booking_id = b.id and l.transaction_type = 'absence_restore'))
      ) order by cs.session_date, cs.start_time)
      from sch
      join public.recurring_occurrences o on o.schedule_id = sch.id
      join public.class_sessions cs on cs.id = o.session_id
      left join public.bookings b on b.id = o.booking_id
      left join public.attendance a on a.booking_id = b.id), '[]'::jsonb)
  ) end;
$$;

-- ─── 4f. Admin: excuse one class and give the credit back ───────────────────
-- Unlike an ordinary absence (which follows the absence-credit policy), this is a
-- deliberate staff decision about one class: exactly one credit is restored, once.
create or replace function public.admin_excuse_booking(p_booking_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_b public.bookings;
  v_session public.class_sessions;
  v_m public.memberships;
  v_old text;
  v_rows int := 0;
  v_restored boolean := false;
  v_balance int;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_reason text := nullif(trim(p_reason), '');
begin
  if not public.is_staff_or_admin() then raise exception 'NOT_AUTHORIZED'; end if;
  if v_reason is null then raise exception 'REASON_REQUIRED' using detail = 'Say why this class is being excused.'; end if;

  select * into v_b from public.bookings where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND'; end if;
  if v_b.status not in ('confirmed', 'absent') then
    raise exception 'BOOKING_NOT_EXCUSABLE' using detail = format('A %s booking cannot be excused.', v_b.status);
  end if;
  select status into v_old from public.attendance where booking_id = p_booking_id;
  -- A class already recorded as ridden is history: never rewritten.
  if v_old = 'present' then raise exception 'BOOKING_NOT_EXCUSABLE' using detail = 'This class was already ridden.'; end if;
  select * into v_session from public.class_sessions where id = v_b.session_id;

  insert into public.attendance (booking_id, status, marked_by, marked_at, notes)
  values (p_booking_id, 'excused', auth.uid(), now(), 'Excused by the club: ' || v_reason)
  on conflict (booking_id) do update
    set status = 'excused', marked_by = excluded.marked_by, marked_at = excluded.marked_at, notes = excluded.notes;
  update public.bookings set status = 'absent' where id = p_booking_id;

  select * into v_m from public.memberships where id = v_b.membership_id for update;
  if v_m.status = 'active' and v_m.end_date >= v_today then
    insert into public.credit_ledger (user_id, membership_id, booking_id, amount, transaction_type, description, created_by)
    values (v_b.user_id, v_b.membership_id, v_b.id, 1, 'absence_restore', 'Class excused by the club: ' || v_reason, auth.uid())
    on conflict (booking_id) where transaction_type = 'absence_restore' do nothing;
    get diagnostics v_rows = row_count;
    v_restored := v_rows > 0;
  end if;

  perform public._audit('attendance', p_booking_id, 'BOOKING_EXCUSED',
    jsonb_build_object('status', v_old),
    jsonb_build_object('booking_id', p_booking_id, 'reason', v_reason, 'credit_restored', v_restored));

  -- Only the first excuse notifies; repeating it changes and sends nothing.
  if v_old is distinct from 'excused' or v_restored then
    select coalesce(sum(amount), 0) into v_balance from public.credit_ledger where membership_id = v_b.membership_id;
    perform public._notify_user(v_b.user_id, 'class_excused',
      case when v_restored then 'Class excused — credit restored' else 'Class excused' end,
      public._fmt_slot(v_session)
        || case when v_restored then format(' · you have %s class%s remaining. You can book a replacement.', v_balance, case when v_balance = 1 then '' else 'es' end)
                else '' end,
      jsonb_build_object('booking_id', p_booking_id));
  end if;

  return jsonb_build_object('booking_id', p_booking_id, 'credit_restored', v_restored,
    'already_excused', v_old = 'excused' and not v_restored);
end;
$$;

-- ─── 4g. Member: book the replacement for an excused class ──────────────────
-- Uses the restored credit through the normal booking checks. It is not a
-- reschedule: reschedules_used and reschedule_count are never touched.
create or replace function public.book_replacement(p_excused_booking_id uuid, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_occ public.recurring_occurrences;
  v_b public.bookings;
  v_r jsonb;
  v_out text;
  v_session public.class_sessions;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;

  select * into v_occ from public.recurring_occurrences
  where booking_id = p_excused_booking_id and user_id = v_uid for update;
  if not found then raise exception 'NOT_A_SCHEDULE_CLASS'; end if;
  if v_occ.replacement_booking_id is not null then raise exception 'ALREADY_REPLACED'; end if;

  select * into v_b from public.bookings where id = p_excused_booking_id;
  if v_b.status <> 'absent'
     or not exists (select 1 from public.attendance where booking_id = v_b.id and status = 'excused')
     or not exists (select 1 from public.credit_ledger where booking_id = v_b.id and transaction_type = 'absence_restore') then
    raise exception 'NOT_EXCUSED' using detail = 'Only a class the club excused can be replaced this way.';
  end if;

  v_r := public._recurring_try_book(v_uid, v_b.membership_id, p_session_id);
  v_out := v_r ->> 'outcome';
  if v_out = 'full' then raise exception 'SESSION_FULL'; end if;
  if v_out = 'no_credits' then raise exception 'NO_CREDITS_REMAINING'; end if;
  if v_out = 'membership_invalid' then raise exception 'MEMBERSHIP_EXPIRED'; end if;
  if v_out = 'not_open' then raise exception 'SESSION_NOT_AVAILABLE'; end if;
  if v_out = 'weekly_cap' then raise exception 'WEEKLY_LIMIT_REACHED'; end if;
  if v_out = 'duplicate' then raise exception 'DUPLICATE_BOOKING'; end if;

  update public.recurring_occurrences
  set replacement_booking_id = (v_r ->> 'booking_id')::uuid, status = 'replaced', updated_at = now()
  where id = v_occ.id;

  select * into v_session from public.class_sessions where id = p_session_id;
  perform public._notify_user(v_uid, 'booking_confirmed', 'Replacement class booked', public._fmt_slot(v_session),
    jsonb_build_object('booking_id', v_r ->> 'booking_id'));
  return jsonb_build_object('booking_id', v_r ->> 'booking_id');
end;
$$;

-- ─── 6. Daily generation (and retry of full classes) ────────────────────────
create or replace function public.generate_recurring_bookings()
returns int language plpgsql security definer set search_path = public as $$
declare
  r record;
  g jsonb;
  v_n int := 0;
  v_booked int;
  v_full int;
begin
  for r in select id, user_id from public.recurring_schedules where status = 'active' loop
    g := public._recurring_generate(r.id);
    v_booked := coalesce((g ->> 'booked')::int, 0);
    v_full := coalesce((g ->> 'full_new')::int, 0);
    v_n := v_n + v_booked;
    -- Only new outcomes notify, so running this again sends nothing twice.
    if v_booked > 0 then
      perform public._notify_user(r.user_id, 'recurring_generated', 'Weekly classes booked',
        format('%s more class%s booked from your weekly schedule.', v_booked, case when v_booked = 1 then '' else 'es' end),
        case when g ->> 'first_booking_id' is not null then jsonb_build_object('booking_id', g ->> 'first_booking_id') else '{}'::jsonb end);
    end if;
    if v_full > 0 then
      perform public._notify_user(r.user_id, 'recurring_skipped', 'A weekly class could not be booked',
        format('%s class%s on your schedule %s full. We will keep trying until it starts.', v_full,
               case when v_full = 1 then '' else 'es' end, case when v_full = 1 then 'is' else 'are' end),
        '{}'::jsonb);
    end if;
  end loop;
  return v_n;
end;
$$;

-- ─── 7. A week of availability in one call ──────────────────────────────────
create or replace function public.session_availability_range(p_from date, p_to date)
returns table (
  session_id uuid, session_date date, start_time time, end_time time, session_status text,
  capacity integer, places_left integer, is_bookable boolean, is_mine boolean
)
language sql stable security definer set search_path = public as $$
  select a.* from generate_series(p_from, least(p_to, p_from + 13), interval '1 day') d,
         lateral public.session_availability(d::date) a
  where auth.uid() is not null
  order by a.session_date, a.start_time;
$$;

-- ─── Permissions ────────────────────────────────────────────────────────────
revoke execute on function public._recurring_try_book(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public._recurring_generate(uuid) from public, anon, authenticated;
revoke execute on function public.generate_recurring_bookings() from public, anon, authenticated;
revoke execute on function public.confirm_recurring_schedule(jsonb) from public, anon;
revoke execute on function public.end_recurring_schedule() from public, anon;
revoke execute on function public.my_recurring_schedule() from public, anon;
revoke execute on function public.admin_excuse_booking(uuid, text) from public, anon;
revoke execute on function public.book_replacement(uuid, uuid) from public, anon;
revoke execute on function public.session_availability_range(date, date) from public, anon;
grant execute on function public.confirm_recurring_schedule(jsonb) to authenticated;
grant execute on function public.end_recurring_schedule() to authenticated;
grant execute on function public.my_recurring_schedule() to authenticated;
grant execute on function public.admin_excuse_booking(uuid, text) to authenticated;
grant execute on function public.book_replacement(uuid, uuid) to authenticated;
grant execute on function public.session_availability_range(date, date) to authenticated;

-- ─── Schedule the daily job (UTC; 01:15 IST, after generate_future_sessions at 01:00) ───
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron unavailable (%); enable it in Database > Extensions and re-run this block.', sqlerrm;
    return;
  end;
  perform cron.schedule('csf-recurring-bookings', '45 19 * * *', 'select public.generate_recurring_bookings()');
end $$;

notify pgrst, 'reload schema';

commit;
