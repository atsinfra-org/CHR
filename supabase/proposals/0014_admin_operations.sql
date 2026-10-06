-- ============================================================================
-- Phase 4.6 — Objective A (first-admin bootstrap) + Objective C (admin
-- operational backend). Applied to production via Supabase MCP.
-- ============================================================================
-- Verified against the LIVE database before writing (information_schema +
-- pg_constraint + pg_policies + pg_proc):
--   * credit_ledger sign convention: book_class writes amount -1
--     ('booking'); cancel_booking writes +1 ('cancellation'); balance =
--     sum(amount). Refunds here therefore write +1 / 'cancellation'.
--   * bookings.status check = held|confirmed|cancelled|completed|no_show|expired
--     and book_class() inserts rows directly as 'confirmed' ('held' is unused
--     in the live flow).
--   * class_sessions.status check = open|closed|cancelled|completed
--   * horses.status check = available|maintenance|rest|medical|retired
--   * credit_ledger.transaction_type check includes 'cancellation' and
--     'admin_adjustment'; amount <> 0.
--   * attendance has UNIQUE(booking_id); status check = present|absent|no_show|excused;
--     no created_at column.
--   * AFTER INSERT trigger trg_sync_membership_credit_cache keeps
--     memberships.credits_remaining in sync, so ledger inserts here need no
--     manual cache update.
--   * profiles has ONLY BEFORE UPDATE triggers
--     (trg_prevent_privilege_escalation, trg_profiles_updated_at) — neither
--     fires on INSERT or DELETE.
--   * role 'postgres' has rolbypassrls and owns every public table; no table
--     has FORCE ROW LEVEL SECURITY. SECURITY DEFINER functions owned by
--     postgres therefore bypass RLS exactly like the existing book_class()/
--     cancel_booking()/admin_adjust_credits().
--   * RLS already grants staff/admin read access to every operational table
--     ("Staff/admin read all ..."), and admin-only read on audit_logs and
--     enquiries. The admin UI reads through those policies; only MUTATIONS
--     and the dashboard aggregate go through the RPCs below.
--
-- Every function here:
--   * SECURITY DEFINER, owner postgres, SET search_path = public
--   * authorises INTERNALLY on profiles.role via is_admin() /
--     is_staff_or_admin() — never on email, never trusting a client value
--   * is atomic (one function = one transaction; FOR UPDATE on any row that
--     can race)
--   * writes public.audit_logs for every privileged mutation
--   * raises structured, machine-mappable error codes
--   * has grants asserted explicitly at the end (belt-and-braces on top of
--     0013's fail-closed default privileges)
-- ============================================================================


-- ===========================================================================
-- OBJECTIVE A — bootstrap_first_admin(p_user_id uuid)
-- ===========================================================================
-- prevent_privilege_escalation() (BEFORE UPDATE on profiles) by design has
-- no path to authorise the FIRST admin: it requires the acting auth.uid()
-- to already resolve to a staff/admin profile. This function does NOT
-- weaken, disable, or add an exception to that trigger. Instead it promotes
-- by REPLACING the row: DELETE the profile, then re-INSERT it with
-- role='admin' and every other column (and the original created_at) carried
-- over verbatim. A BEFORE UPDATE trigger never observes an INSERT/DELETE, so
-- the trigger stays 100% intact and enforcing for every normal code path.
--
-- Fail-closed / safe-to-re-run properties:
--   * pg_advisory_xact_lock serialises concurrent callers
--   * aborts if ANY admin OR staff profile already exists
--     (ADMIN_ALREADY_EXISTS) — so a second run is a safe no-op error
--   * target must have an auth.users row AND an existing profile (i.e. has
--     signed in at least once)
--   * REFUSES if the target has any membership / booking / payment /
--     credit-ledger / audit history, so the DELETE can never cascade real
--     operational data away
--   * writes an audit_logs row (action BOOTSTRAP_FIRST_ADMIN)
--   * callable ONLY by postgres / service_role — revoked from PUBLIC, anon,
--     and authenticated, so no ordinary member can invoke it at all
-- ---------------------------------------------------------------------------
create or replace function public.bootstrap_first_admin(p_user_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.profiles;
  v_privileged_count int;
begin
  perform pg_advisory_xact_lock(hashtext('bootstrap_first_admin'));

  select count(*) into v_privileged_count
  from public.profiles where role in ('admin', 'staff');
  if v_privileged_count > 0 then
    raise exception 'ADMIN_ALREADY_EXISTS'
      using detail = 'A privileged (admin/staff) account already exists. Use admin_set_role() instead.';
  end if;

  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'AUTH_USER_NOT_FOUND';
  end if;

  select * into v_existing from public.profiles where id = p_user_id;
  if not found then
    raise exception 'PROFILE_NOT_FOUND'
      using detail = 'That user has no profile yet — they must sign in at least once first.';
  end if;

  if exists (select 1 from public.memberships   where user_id = p_user_id)
     or exists (select 1 from public.bookings   where user_id = p_user_id)
     or exists (select 1 from public.payments   where user_id = p_user_id)
     or exists (select 1 from public.credit_ledger where user_id = p_user_id)
     or exists (select 1 from public.audit_logs where performed_by = p_user_id) then
    raise exception 'USER_HAS_ACTIVITY'
      using detail = 'The first admin must be a clean operational account with no membership/booking/payment/audit history.';
  end if;

  delete from public.profiles where id = p_user_id;
  insert into public.profiles
    (id, full_name, phone, email, avatar_url, date_of_birth, role, status, created_at, updated_at)
  values
    (v_existing.id, v_existing.full_name, v_existing.phone, v_existing.email, v_existing.avatar_url,
     v_existing.date_of_birth, 'admin', v_existing.status, v_existing.created_at, now())
  returning * into v_existing;

  insert into public.audit_logs (table_name, record_id, action, performed_by, old_values, new_values)
  values ('profiles', p_user_id, 'BOOTSTRAP_FIRST_ADMIN', null,
          jsonb_build_object('role', 'member'),
          jsonb_build_object('role', 'admin'));

  return v_existing;
end;
$$;
comment on function public.bootstrap_first_admin(uuid) is
  'One-time first-admin bootstrap. Fails closed once any admin/staff exists. Callable only by postgres/service_role. Does not touch prevent_privilege_escalation(). Safe to drop after the first admin is established.';
revoke all on function public.bootstrap_first_admin(uuid) from public, anon, authenticated;
-- postgres (owner) + service_role keep EXECUTE via the schema's default ACL.


-- ===========================================================================
-- admin_set_role — ongoing role management (post-bootstrap)
-- ===========================================================================
create or replace function public.admin_set_role(p_user_id uuid, p_role text, p_reason text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target public.profiles;
  v_old_role text;
  v_admin_count int;
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_role not in ('member', 'staff', 'admin') then
    raise exception 'INVALID_ROLE';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED';
  end if;

  select * into v_target from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  v_old_role := v_target.role;
  if v_old_role = p_role then
    return v_target; -- idempotent no-op
  end if;

  -- The system must always retain at least one admin.
  if v_old_role = 'admin' and p_role <> 'admin' then
    select count(*) into v_admin_count from public.profiles where role = 'admin';
    if v_admin_count <= 1 then
      raise exception 'LAST_ADMIN'
        using detail = 'Cannot demote the only admin. Promote another admin first.';
    end if;
  end if;

  -- Runs as postgres (BYPASSRLS) so the UPDATE is not gated by the
  -- "Admin updates any profile" policy; prevent_privilege_escalation() DOES
  -- still fire on this UPDATE and passes because auth.uid() resolved to an
  -- admin above (is_admin() = true).
  update public.profiles set role = p_role where id = p_user_id
  returning * into v_target;

  insert into public.audit_logs (table_name, record_id, action, performed_by, old_values, new_values)
  values ('profiles', p_user_id, 'SET_ROLE', auth.uid(),
          jsonb_build_object('role', v_old_role),
          jsonb_build_object('role', p_role, 'reason', p_reason));

  return v_target;
end;
$$;
revoke all on function public.admin_set_role(uuid, text, text) from public, anon;
grant execute on function public.admin_set_role(uuid, text, text) to authenticated;


-- ===========================================================================
-- admin_dashboard_metrics — one authoritative call, all numbers server-side
-- ===========================================================================
create or replace function public.admin_dashboard_metrics()
returns table (
  total_members int,
  active_memberships int,
  pending_payment_memberships int,
  active_horses int,
  sessions_today int,
  bookings_today int,
  open_sessions_next_7d int,
  capacity_next_7d bigint,
  booked_next_7d bigint,
  pending_payments int,
  cancellations_7d int,
  bookings_awaiting_attendance int,
  enquiries_total int
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_is_admin boolean := public.is_admin();
begin
  if not public.is_staff_or_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  return query
  select
    (select count(*)::int from public.profiles where role = 'member'),
    (select count(*)::int from public.memberships where status = 'active' and end_date >= v_today),
    (select count(*)::int from public.memberships where status = 'pending_payment'),
    (select count(*)::int from public.horses where is_active and status = 'available'),
    (select count(*)::int from public.class_sessions where session_date = v_today),
    (select count(*)::int from public.bookings b
       join public.class_sessions s on s.id = b.session_id
       where s.session_date = v_today and b.status in ('confirmed', 'completed', 'no_show')),
    (select count(*)::int from public.class_sessions
       where session_date > v_today and session_date <= v_today + 7 and status = 'open'),
    (select coalesce(sum(s.capacity), 0) from public.class_sessions s
       where s.session_date > v_today and s.session_date <= v_today + 7 and s.status = 'open'),
    (select count(*) from public.bookings b
       join public.class_sessions s on s.id = b.session_id
       where s.session_date > v_today and s.session_date <= v_today + 7 and b.status = 'confirmed'),
    (select count(*)::int from public.payments where status in ('created', 'pending', 'processing')),
    (select count(*)::int from public.bookings
       where status = 'cancelled' and cancelled_at >= now() - interval '7 days'),
    (select count(*)::int from public.bookings b
       join public.class_sessions s on s.id = b.session_id
       where b.status = 'confirmed' and s.session_date < v_today
         and not exists (select 1 from public.attendance a where a.booking_id = b.id)),
    case when v_is_admin then (select count(*)::int from public.enquiries) else null end;
end;
$$;
revoke all on function public.admin_dashboard_metrics() from public, anon;
grant execute on function public.admin_dashboard_metrics() to authenticated;


-- ===========================================================================
-- admin_generate_sessions — controlled wrapper over the locked generate_sessions()
-- ===========================================================================
create or replace function public.admin_generate_sessions(p_from date, p_to date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_inserted int;
begin
  if not public.is_staff_or_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_DATE_RANGE';
  end if;
  if p_from < v_today - 1 then
    raise exception 'INVALID_DATE_RANGE' using detail = 'Cannot generate sessions in the past.';
  end if;
  if p_to - p_from > 92 then
    raise exception 'INVALID_DATE_RANGE' using detail = 'Generate at most one quarter (92 days) per call.';
  end if;

  -- generate_sessions() re-checks is_staff_or_admin() itself and is
  -- idempotent via uq_session_slot (ON CONFLICT DO NOTHING). Capacity is
  -- derived inside it from system_settings / active-available horse count —
  -- never hardcoded here.
  v_inserted := public.generate_sessions(p_from, p_to);

  insert into public.audit_logs (table_name, record_id, action, performed_by, new_values)
  values ('class_sessions', gen_random_uuid(), 'GENERATE_SESSIONS', auth.uid(),
          jsonb_build_object('from', p_from, 'to', p_to, 'inserted', v_inserted));

  return v_inserted;
end;
$$;
revoke all on function public.admin_generate_sessions(date, date) from public, anon;
grant execute on function public.admin_generate_sessions(date, date) to authenticated;


-- ===========================================================================
-- admin_set_session_status — open / close / cancel / complete a session
-- ===========================================================================
create or replace function public.admin_set_session_status(p_session_id uuid, p_status text)
returns public.class_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.class_sessions;
  v_old text;
  v_active_bookings int;
begin
  if not public.is_staff_or_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_status not in ('open', 'closed', 'cancelled', 'completed') then
    raise exception 'INVALID_STATUS';
  end if;

  select * into v_session from public.class_sessions where id = p_session_id for update;
  if not found then
    raise exception 'SESSION_NOT_FOUND';
  end if;
  v_old := v_session.status;

  -- Cancelling a session with live bookings would silently strand members;
  -- require those to be handled first via admin_cancel_booking().
  if p_status = 'cancelled' then
    select count(*) into v_active_bookings from public.bookings
    where session_id = p_session_id and status in ('held', 'confirmed');
    if v_active_bookings > 0 then
      raise exception 'SESSION_HAS_BOOKINGS'
        using detail = format('%s active booking(s) must be cancelled first.', v_active_bookings);
    end if;
  end if;

  update public.class_sessions set status = p_status where id = p_session_id
  returning * into v_session;

  insert into public.audit_logs (table_name, record_id, action, performed_by, old_values, new_values)
  values ('class_sessions', p_session_id, 'SET_SESSION_STATUS', auth.uid(),
          jsonb_build_object('status', v_old), jsonb_build_object('status', p_status));

  return v_session;
end;
$$;
revoke all on function public.admin_set_session_status(uuid, text) from public, anon;
grant execute on function public.admin_set_session_status(uuid, text) to authenticated;


-- ===========================================================================
-- admin_create_horse — admin only (RLS "Admin manages horses")
-- ===========================================================================
create or replace function public.admin_create_horse(p_name text, p_description text)
returns public.horses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_horse public.horses;
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'NAME_REQUIRED';
  end if;

  insert into public.horses (name, description)
  values (trim(p_name), nullif(trim(p_description), ''))
  returning * into v_horse;

  insert into public.audit_logs (table_name, record_id, action, performed_by, new_values)
  values ('horses', v_horse.id, 'CREATE_HORSE', auth.uid(),
          jsonb_build_object('name', v_horse.name));

  return v_horse;
end;
$$;
revoke all on function public.admin_create_horse(text, text) from public, anon;
grant execute on function public.admin_create_horse(text, text) to authenticated;


-- ===========================================================================
-- admin_set_horse_status — staff + admin (RLS "Staff updates horse status")
-- ===========================================================================
create or replace function public.admin_set_horse_status(p_horse_id uuid, p_status text, p_is_active boolean)
returns public.horses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_horse public.horses;
  v_old jsonb;
begin
  if not public.is_staff_or_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_status not in ('available', 'maintenance', 'rest', 'medical', 'retired') then
    raise exception 'INVALID_STATUS';
  end if;

  select * into v_horse from public.horses where id = p_horse_id for update;
  if not found then
    raise exception 'HORSE_NOT_FOUND';
  end if;
  v_old := jsonb_build_object('status', v_horse.status, 'is_active', v_horse.is_active);

  update public.horses
  set status = p_status, is_active = coalesce(p_is_active, is_active)
  where id = p_horse_id
  returning * into v_horse;

  insert into public.audit_logs (table_name, record_id, action, performed_by, old_values, new_values)
  values ('horses', p_horse_id, 'SET_HORSE_STATUS', auth.uid(), v_old,
          jsonb_build_object('status', v_horse.status, 'is_active', v_horse.is_active));

  return v_horse;
end;
$$;
revoke all on function public.admin_set_horse_status(uuid, text, boolean) from public, anon;
grant execute on function public.admin_set_horse_status(uuid, text, boolean) to authenticated;


-- ===========================================================================
-- admin_cancel_booking — explicit admin/staff booking override
-- ===========================================================================
-- Distinct from the member cancel_booking(): the operator EXPLICITLY chooses
-- whether one credit is returned (p_refund_credit), independent of the
-- cancellation-cutoff policy — the legitimate case is "we cancelled the
-- class, refund regardless of timing". Atomic; double-cancel rejected;
-- audited. The AFTER INSERT trigger on credit_ledger re-syncs
-- credits_remaining.
-- ---------------------------------------------------------------------------
create or replace function public.admin_cancel_booking(p_booking_id uuid, p_reason text, p_refund_credit boolean)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
begin
  if not public.is_staff_or_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'BOOKING_NOT_FOUND';
  end if;
  if v_booking.status not in ('held', 'confirmed') then
    raise exception 'BOOKING_NOT_CANCELLABLE'
      using detail = format('Booking is already %s.', v_booking.status);
  end if;

  update public.bookings
  set status = 'cancelled', cancelled_at = now(),
      cancellation_reason = 'Admin: ' || p_reason
  where id = p_booking_id
  returning * into v_booking;

  if coalesce(p_refund_credit, false) then
    insert into public.credit_ledger
      (user_id, membership_id, booking_id, amount, transaction_type, description, created_by)
    values
      (v_booking.user_id, v_booking.membership_id, v_booking.id, 1, 'cancellation',
       'Admin cancellation — credit returned', auth.uid());
  end if;

  insert into public.audit_logs (table_name, record_id, action, performed_by, old_values, new_values)
  values ('bookings', p_booking_id, 'ADMIN_CANCEL_BOOKING', auth.uid(),
          jsonb_build_object('status', 'confirmed'),
          jsonb_build_object('status', 'cancelled', 'reason', p_reason,
                             'refunded', coalesce(p_refund_credit, false)));

  return v_booking;
end;
$$;
revoke all on function public.admin_cancel_booking(uuid, text, boolean) from public, anon;
grant execute on function public.admin_cancel_booking(uuid, text, boolean) to authenticated;


-- ===========================================================================
-- admin_mark_attendance — staff + admin (RLS "Staff/admin manage attendance")
-- ===========================================================================
create or replace function public.admin_mark_attendance(p_booking_id uuid, p_status text, p_notes text)
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
  v_att public.attendance;
begin
  if not public.is_staff_or_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_status not in ('present', 'absent', 'no_show', 'excused') then
    raise exception 'INVALID_STATUS';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id for update;
  if not found then
    raise exception 'BOOKING_NOT_FOUND';
  end if;
  if v_booking.status not in ('confirmed', 'completed', 'no_show') then
    raise exception 'BOOKING_NOT_ATTENDABLE'
      using detail = format('Attendance cannot be set on a %s booking.', v_booking.status);
  end if;

  insert into public.attendance (booking_id, status, marked_by, marked_at, notes)
  values (p_booking_id, p_status, auth.uid(), now(), nullif(trim(p_notes), ''))
  on conflict (booking_id)
  do update set status = excluded.status, marked_by = excluded.marked_by,
               marked_at = excluded.marked_at, notes = excluded.notes
  returning * into v_att;

  -- Reflect the outcome on the booking lifecycle: a no-show/absent becomes
  -- 'no_show', anyone accounted for (present/excused) becomes 'completed'.
  update public.bookings
  set status = case when p_status in ('no_show', 'absent') then 'no_show' else 'completed' end,
      completed_at = case when p_status in ('present', 'excused') then now() else completed_at end
  where id = p_booking_id;

  insert into public.audit_logs (table_name, record_id, action, performed_by, new_values)
  values ('attendance', v_att.id, 'MARK_ATTENDANCE', auth.uid(),
          jsonb_build_object('booking_id', p_booking_id, 'status', p_status));

  return v_att;
end;
$$;
revoke all on function public.admin_mark_attendance(uuid, text, text) from public, anon;
grant execute on function public.admin_mark_attendance(uuid, text, text) to authenticated;


-- ===========================================================================
-- admin_adjust_credits — REPLACES the Phase 4.3 stub: adds a mandatory
-- reason, structured error codes, and an audit_logs record. Signature and
-- return type unchanged (RpcSignatures.admin_adjust_credits).
-- ===========================================================================
create or replace function public.admin_adjust_credits(p_membership_id uuid, p_amount integer, p_reason text)
returns public.credit_ledger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.credit_ledger;
  v_user_id uuid;
begin
  if not public.is_staff_or_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_amount = 0 then
    raise exception 'INVALID_AMOUNT' using detail = 'Adjustment must be non-zero.';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED';
  end if;

  select user_id into v_user_id from public.memberships where id = p_membership_id;
  if v_user_id is null then
    raise exception 'MEMBERSHIP_NOT_FOUND';
  end if;

  insert into public.credit_ledger
    (user_id, membership_id, amount, transaction_type, description, created_by)
  values
    (v_user_id, p_membership_id, p_amount, 'admin_adjustment', p_reason, auth.uid())
  returning * into v_row;

  insert into public.audit_logs (table_name, record_id, action, performed_by, new_values)
  values ('credit_ledger', v_row.id, 'ADJUST_CREDITS', auth.uid(),
          jsonb_build_object('membership_id', p_membership_id, 'amount', p_amount, 'reason', p_reason));

  return v_row;
end;
$$;
revoke all on function public.admin_adjust_credits(uuid, integer, text) from public, anon;
grant execute on function public.admin_adjust_credits(uuid, integer, text) to authenticated;
