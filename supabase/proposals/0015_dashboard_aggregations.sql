-- ============================================================================
-- Phase 4.6 (dashboard redesign) — read-only aggregation RPCs for the Admin
-- Dashboard. Applied to production via Supabase MCP.
-- ============================================================================
-- Scope: ONLY dashboard-specific read aggregations. No table, column,
-- business-rule, RLS, trigger, or existing-function-logic change. Every
-- function here mirrors admin_dashboard_metrics()'s contract:
--   * SECURITY DEFINER, owner postgres, SET search_path = public, STABLE
--   * gate: is_staff_or_admin() -> NOT_AUTHORIZED
--   * all business-date math on the Asia/Kolkata calendar
--   * revoked from public + anon; granted to authenticated (the gate is the
--     function's own check)
--   * aggregation happens here, never in React
-- ============================================================================


-- ---------------------------------------------------------------------------
-- admin_dashboard_metrics() — EXTENDED. Return signature changes, so it is
-- dropped and recreated. Only caller is src/admin/pages/AdminOverview.jsx
-- (rewritten in the same change).
-- ---------------------------------------------------------------------------
drop function if exists public.admin_dashboard_metrics();

create function public.admin_dashboard_metrics()
returns table (
  -- existing metrics (unchanged semantics)
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
  enquiries_total int,
  -- new for the redesigned dashboard
  total_bookings int,          -- seats booked all-time, excludes cancelled/expired
  revenue_total numeric,       -- SUM(payments.amount) WHERE status='success' AND currency='INR'
  revenue_30d numeric,         -- same, paid in the last 30 IST days
  revenue_prev_30d numeric,    -- same, paid in the 30 IST days before that (for a delta)
  horses_total int,
  horses_available int,
  horses_maintenance int,
  horses_rest int,
  horses_medical int,
  horses_retired int,
  horses_inactive int
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
    case when v_is_admin then (select count(*)::int from public.enquiries) else null end,
    -- new
    (select count(*)::int from public.bookings where status in ('confirmed', 'completed', 'no_show')),
    (select coalesce(sum(amount), 0)::numeric from public.payments where status = 'success' and currency = 'INR'),
    (select coalesce(sum(amount), 0)::numeric from public.payments
       where status = 'success' and currency = 'INR'
         and paid_at is not null and (paid_at at time zone 'Asia/Kolkata')::date > v_today - 30),
    (select coalesce(sum(amount), 0)::numeric from public.payments
       where status = 'success' and currency = 'INR'
         and paid_at is not null
         and (paid_at at time zone 'Asia/Kolkata')::date > v_today - 60
         and (paid_at at time zone 'Asia/Kolkata')::date <= v_today - 30),
    (select count(*)::int from public.horses),
    (select count(*)::int from public.horses where status = 'available'),
    (select count(*)::int from public.horses where status = 'maintenance'),
    (select count(*)::int from public.horses where status = 'rest'),
    (select count(*)::int from public.horses where status = 'medical'),
    (select count(*)::int from public.horses where status = 'retired'),
    (select count(*)::int from public.horses where not is_active);
end;
$$;
revoke all on function public.admin_dashboard_metrics() from public, anon;
grant execute on function public.admin_dashboard_metrics() to authenticated;


-- ---------------------------------------------------------------------------
-- admin_dashboard_booking_series(p_from, p_to)
-- One row per calendar day in [p_from, p_to] (zero-filled). Aggregated by
-- class_sessions.session_date (the "class happening" date) to stay
-- consistent with bookings_today / booked_next_7d in the metrics RPC.
-- Also carries per-day session count + capacity so the same series feeds
-- the Session Capacity Utilisation chart (booked / capacity).
-- ---------------------------------------------------------------------------
create or replace function public.admin_dashboard_booking_series(p_from date, p_to date)
returns table (day date, bookings int, sessions int, capacity bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_staff_or_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_DATE_RANGE';
  end if;
  if p_to - p_from > 366 then
    raise exception 'INVALID_DATE_RANGE' using detail = 'Range too large (max 366 days).';
  end if;

  return query
  with days as (
    select d::date as day from generate_series(p_from, p_to, interval '1 day') d
  ),
  sess as (
    select s.session_date, count(*) as sessions, coalesce(sum(s.capacity), 0) as capacity
    from public.class_sessions s
    where s.session_date between p_from and p_to and s.status <> 'cancelled'
    group by s.session_date
  ),
  bk as (
    select s.session_date, count(*) as bookings
    from public.bookings b
    join public.class_sessions s on s.id = b.session_id
    where s.session_date between p_from and p_to and b.status in ('confirmed', 'completed', 'no_show')
    group by s.session_date
  )
  select days.day,
         coalesce(bk.bookings, 0)::int,
         coalesce(sess.sessions, 0)::int,
         coalesce(sess.capacity, 0)::bigint
  from days
  left join bk on bk.session_date = days.day
  left join sess on sess.session_date = days.day
  order by days.day;
end;
$$;
revoke all on function public.admin_dashboard_booking_series(date, date) from public, anon;
grant execute on function public.admin_dashboard_booking_series(date, date) to authenticated;


-- ---------------------------------------------------------------------------
-- admin_dashboard_revenue_series(p_from, p_to, p_grain)
-- SUM(payments.amount) WHERE status='success' AND currency='INR', bucketed
-- by paid_at on the Asia/Kolkata calendar. Zero-filled buckets. Empty
-- (all-zero) series when no successful payments exist — never fabricated.
-- ---------------------------------------------------------------------------
create or replace function public.admin_dashboard_revenue_series(p_from date, p_to date, p_grain text default 'day')
returns table (bucket date, revenue numeric, payments int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_step interval;
begin
  if not public.is_staff_or_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_grain not in ('day', 'week', 'month') then
    raise exception 'INVALID_GRAIN';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'INVALID_DATE_RANGE';
  end if;
  if p_to - p_from > 1100 then
    raise exception 'INVALID_DATE_RANGE' using detail = 'Range too large.';
  end if;
  v_step := case p_grain when 'day' then interval '1 day' when 'week' then interval '1 week' else interval '1 month' end;

  return query
  with buckets as (
    select date_trunc(p_grain, g)::date as bucket
    from generate_series(date_trunc(p_grain, p_from::timestamp), date_trunc(p_grain, p_to::timestamp), v_step) g
  ),
  pay as (
    select date_trunc(p_grain, (p.paid_at at time zone 'Asia/Kolkata'))::date as bucket,
           sum(p.amount) as revenue,
           count(*) as payments
    from public.payments p
    where p.status = 'success' and p.currency = 'INR' and p.paid_at is not null
      and (p.paid_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    group by 1
  )
  select b.bucket, coalesce(pay.revenue, 0)::numeric, coalesce(pay.payments, 0)::int
  from buckets b
  left join pay on pay.bucket = b.bucket
  order by b.bucket;
end;
$$;
revoke all on function public.admin_dashboard_revenue_series(date, date, text) from public, anon;
grant execute on function public.admin_dashboard_revenue_series(date, date, text) to authenticated;


-- ---------------------------------------------------------------------------
-- admin_dashboard_membership_breakdown()
-- dimension='status': the five real memberships.status values. 'active'
--   counts only rows still within end_date; an 'active' row past end_date is
--   folded into 'expired' — consistent with src/account/useMembershipStatus.js
--   "lapsed" logic. No new status category is introduced.
-- dimension='plan': one row per membership_plans row, count of its memberships.
-- ---------------------------------------------------------------------------
create or replace function public.admin_dashboard_membership_breakdown()
returns table (dimension text, key text, label text, count int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not public.is_staff_or_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  return query
  select 'status'::text, k.key, k.key,
    (case k.key
      when 'active' then (select count(*)::int from public.memberships where status = 'active' and end_date >= v_today)
      when 'expired' then (select count(*)::int from public.memberships where status = 'expired' or (status = 'active' and end_date < v_today))
      when 'pending_payment' then (select count(*)::int from public.memberships where status = 'pending_payment')
      when 'cancelled' then (select count(*)::int from public.memberships where status = 'cancelled')
      when 'suspended' then (select count(*)::int from public.memberships where status = 'suspended')
     end)
  from (values ('active'), ('pending_payment'), ('expired'), ('cancelled'), ('suspended')) as k(key)

  union all

  select 'plan'::text, mp.id::text, mp.name, count(m.id)::int
  from public.membership_plans mp
  left join public.memberships m on m.plan_id = mp.id
  group by mp.id, mp.name

  order by 1, 4 desc;
end;
$$;
revoke all on function public.admin_dashboard_membership_breakdown() from public, anon;
grant execute on function public.admin_dashboard_membership_breakdown() to authenticated;
