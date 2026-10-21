-- 0036_admin_reports.sql  (REVIEW ONLY: not applied anywhere. Apply in the Supabase SQL Editor; safe to run twice.)
--
-- Read-only data sources for the admin Excel / PDF exports. The files themselves are built in the administrator's
-- browser from these pages; nothing is stored and there are no download links.
--
--   admin_report_members      one row per member (role = 'member'), with their current membership
--   admin_report_memberships  one row per membership, with its plan, credits and linked payment
--   admin_report_payments     one row per payment, with the items bought and the membership state
--   admin_report_bookings     one row per booking (a real reservation; a weekly-schedule preference is not a booking)
--   admin_report_summary      counts and totals for the preview, over exactly the same rows
--   admin_log_export          records WHO exported WHAT (type, format, filters, row count) in audit_logs; never the contents
--
-- Authorization: every function checks is_admin() itself. Staff and members get FORBIDDEN. None of them is callable by anon.
-- Paging: p_limit 1..500, p_offset >= 0, stable order. A row is one entity: joins that can fan out are collapsed first.
-- Dates: filters compare India (Asia/Kolkata) calendar days, the same convention as the rest of the club's data.
-- Money: amounts are INR as stored (no paise conversion). Revenue = status 'success' only. There is NO refund-amount
-- column in the database, so refunded / partially refunded payments are reported separately with their ORIGINAL amount
-- and are never counted as revenue or netted off.
-- Privacy: erased accounts are blanked; *.invalid placeholder emails are blanked; empty phones stay blank; no payment
-- metadata or gateway payload is exported; there are no horse columns (CHR does not assign horses in the software).
-- Rollback: 0036_admin_reports.down.sql. Nothing here changes a table, a policy or an existing function.

begin;

-- Cheap range scans for the date filters (IF NOT EXISTS: harmless if a similar index exists).
create index if not exists idx_profiles_created_at on public.profiles (created_at);
create index if not exists idx_memberships_created_at on public.memberships (created_at);
create index if not exists idx_payments_created_at on public.payments (created_at);

-- ─── Internal row sources (no authorization here: only the functions below call them) ───────────────────────

create or replace function public._rpt_members(p_from date, p_to date, p_status text, p_plan text)
returns table (member_id uuid, full_name text, phone text, email text, registered_at timestamptz,
               plan_name text, plan_code text, membership_status text, start_date date, end_date date)
language sql stable security definer set search_path = public as $$
  select p.id,
         case when p.erased_at is null then p.full_name end,
         case when p.erased_at is null then nullif(btrim(p.phone), '') end,
         case when p.erased_at is null and coalesce(p.email, '') not like '%.invalid' then p.email end,
         p.created_at, pl.name, pl.plan_code, m.status, m.start_date, m.end_date
  from public.profiles p
  left join lateral (
    -- the member's CURRENT membership: an active one first, then the latest to end, then the newest
    select mm.* from public.memberships mm where mm.user_id = p.id
    order by (mm.status = 'active') desc, mm.end_date desc nulls last, mm.created_at desc, mm.id limit 1
  ) m on true
  left join public.membership_plans pl on pl.id = m.plan_id
  where p.role = 'member'
    and (p_from is null or (p.created_at at time zone 'Asia/Kolkata')::date >= p_from)
    and (p_to is null or (p.created_at at time zone 'Asia/Kolkata')::date <= p_to)
    and (p_plan is null or pl.plan_code = p_plan)
    and (p_status is null or (p_status = 'none' and m.id is null) or m.status = p_status);
$$;

create or replace function public._rpt_memberships(p_from date, p_to date, p_status text, p_plan text)
returns table (membership_id uuid, member_id uuid, full_name text, phone text, email text, plan_name text, plan_code text,
               plan_price numeric, currency text, total_credits integer, credits_remaining integer, credits_used integer,
               purchased_at timestamptz, start_date date, end_date date, membership_status text,
               payment_status text, payment_amount numeric)
language sql stable security definer set search_path = public as $$
  select m.id, p.id,
         case when p.erased_at is null then p.full_name end,
         case when p.erased_at is null then nullif(btrim(p.phone), '') end,
         case when p.erased_at is null and coalesce(p.email, '') not like '%.invalid' then p.email end,
         pl.name, pl.plan_code, pl.price, pl.currency,
         -- total and remaining are the membership's own authoritative columns; "used" is their difference
         coalesce(m.total_credits, pl.class_credits), m.credits_remaining,
         greatest(coalesce(m.total_credits, pl.class_credits) - m.credits_remaining, 0),
         m.created_at, m.start_date, m.end_date, m.status, pay.status, pay.amount
  from public.memberships m
  join public.profiles p on p.id = m.user_id
  left join public.membership_plans pl on pl.id = m.plan_id
  left join public.payments pay on pay.id = m.payment_id
  where (p_from is null or (m.created_at at time zone 'Asia/Kolkata')::date >= p_from)
    and (p_to is null or (m.created_at at time zone 'Asia/Kolkata')::date <= p_to)
    and (p_plan is null or pl.plan_code = p_plan)
    and (p_status is null or m.status = p_status);
$$;

create or replace function public._rpt_payments(p_from date, p_to date, p_status text, p_gateway text)
returns table (payment_id uuid, member_id uuid, full_name text, phone text, email text, items text, amount numeric,
               currency text, gateway text, gateway_order_id text, gateway_payment_id text, payment_status text,
               created_at timestamptz, paid_at timestamptz, membership_state text)
language sql stable security definer set search_path = public as $$
  select pay.id, p.id,
         case when p.erased_at is null then p.full_name end,
         case when p.erased_at is null then nullif(btrim(p.phone), '') end,
         case when p.erased_at is null and coalesce(p.email, '') not like '%.invalid' then p.email end,
         coalesce(it.items, lm.plan_name),
         pay.amount, pay.currency, pay.gateway, pay.gateway_order_id, pay.gateway_payment_id, pay.status,
         pay.created_at, pay.paid_at,
         coalesce(ms.states, lm.state)
  from public.payments pay
  join public.profiles p on p.id = pay.user_id
  -- items bought, collapsed to ONE value per payment (an order can have several lines)
  left join lateral (
    select string_agg(oi.name || case when oi.quantity > 1 then ' x' || oi.quantity else '' end, '; ' order by oi.name, oi.id) as items
    from public.order_items oi where oi.order_id = pay.order_id
  ) it on true
  -- membership state(s) created from this order, collapsed to ONE value per payment
  left join lateral (
    select string_agg(distinct mm.status, '; ') as states
    from public.order_items oi join public.memberships mm on mm.order_item_id = oi.id
    where oi.order_id = pay.order_id
  ) ms on true
  -- legacy payments that point straight at a membership
  left join lateral (
    select pl.name as plan_name, mm.status as state
    from public.memberships mm left join public.membership_plans pl on pl.id = mm.plan_id
    where mm.id = pay.membership_id and pay.order_id is null
  ) lm on true
  where (p_from is null or (pay.created_at at time zone 'Asia/Kolkata')::date >= p_from)
    and (p_to is null or (pay.created_at at time zone 'Asia/Kolkata')::date <= p_to)
    and (p_status is null or pay.status = p_status)
    and (p_gateway is null or pay.gateway = p_gateway);
$$;

create or replace function public._rpt_bookings(p_from date, p_to date, p_status text, p_plan text)
returns table (booking_id uuid, member_id uuid, full_name text, phone text, email text, plan_name text, plan_code text,
               session_date date, weekday text, start_time time, end_time time, booking_status text,
               attendance_status text, reschedule_count integer, recurring_schedule_id uuid, booking_source text)
language sql stable security definer set search_path = public as $$
  select b.id, p.id,
         case when p.erased_at is null then p.full_name end,
         case when p.erased_at is null then nullif(btrim(p.phone), '') end,
         case when p.erased_at is null and coalesce(p.email, '') not like '%.invalid' then p.email end,
         pl.name, pl.plan_code, cs.session_date, btrim(to_char(cs.session_date, 'Day')), cs.start_time, cs.end_time,
         b.status, att.status, b.reschedule_count, ro.schedule_id,
         case when ro.id is null then 'Single booking' else 'Weekly schedule' end
  from public.bookings b
  join public.class_sessions cs on cs.id = b.session_id
  join public.profiles p on p.id = b.user_id
  left join public.memberships m on m.id = b.membership_id
  left join public.membership_plans pl on pl.id = m.plan_id
  left join lateral (select a.status from public.attendance a where a.booking_id = b.id order by a.marked_at desc, a.id limit 1) att on true
  left join public.recurring_occurrences ro on ro.booking_id = b.id           -- at most one (unique index)
  where (p_from is null or cs.session_date >= p_from)
    and (p_to is null or cs.session_date <= p_to)
    and (p_plan is null or pl.plan_code = p_plan)
    and (p_status is null or b.status = p_status);
$$;

revoke execute on function public._rpt_members(date, date, text, text) from public, anon, authenticated;
revoke execute on function public._rpt_memberships(date, date, text, text) from public, anon, authenticated;
revoke execute on function public._rpt_payments(date, date, text, text) from public, anon, authenticated;
revoke execute on function public._rpt_bookings(date, date, text, text) from public, anon, authenticated;

-- ─── The one authorization + validation gate every report goes through ──────────────────────────────────────
create or replace function public._rpt_guard(p_from date, p_to date, p_limit int, p_offset int)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  if (p_from is not null and (p_from < date '2000-01-01' or p_from > date '2100-01-01'))
     or (p_to is not null and (p_to < date '2000-01-01' or p_to > date '2100-01-01'))
     or (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception 'INVALID_DATE_RANGE';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then raise exception 'INVALID_LIMIT'; end if;
  if p_offset is null or p_offset < 0 then raise exception 'INVALID_OFFSET'; end if;
end;
$$;
revoke execute on function public._rpt_guard(date, date, int, int) from public, anon, authenticated;

-- ─── Public report functions (administrators only) ──────────────────────────────────────────────────────────
create or replace function public.admin_report_members(
  p_from date default null, p_to date default null, p_status text default null, p_plan text default null,
  p_limit int default 200, p_offset int default 0)
returns table (member_id uuid, full_name text, phone text, email text, registered_at timestamptz, plan_name text,
               membership_status text, start_date date, end_date date, total_count bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._rpt_guard(p_from, p_to, p_limit, p_offset);
  if p_status is not null and p_status not in ('none', 'pending_payment', 'active', 'expired', 'cancelled', 'suspended') then raise exception 'INVALID_STATUS'; end if;
  if p_plan is not null and p_plan !~ '^[A-Za-z0-9_-]{1,40}$' then raise exception 'INVALID_PLAN'; end if;
  return query
    select r.member_id, r.full_name, r.phone, r.email, r.registered_at, r.plan_name, r.membership_status, r.start_date, r.end_date,
           count(*) over ()
    from public._rpt_members(p_from, p_to, p_status, p_plan) r
    order by r.registered_at, r.member_id limit p_limit offset p_offset;
end;
$$;

create or replace function public.admin_report_memberships(
  p_from date default null, p_to date default null, p_status text default null, p_plan text default null,
  p_limit int default 200, p_offset int default 0)
returns table (membership_id uuid, member_id uuid, full_name text, phone text, email text, plan_name text, plan_price numeric,
               currency text, total_credits integer, credits_used integer, credits_remaining integer, purchased_at timestamptz,
               start_date date, end_date date, membership_status text, payment_status text, payment_amount numeric, total_count bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._rpt_guard(p_from, p_to, p_limit, p_offset);
  if p_status is not null and p_status not in ('pending_payment', 'active', 'expired', 'cancelled', 'suspended') then raise exception 'INVALID_STATUS'; end if;
  if p_plan is not null and p_plan !~ '^[A-Za-z0-9_-]{1,40}$' then raise exception 'INVALID_PLAN'; end if;
  return query
    select r.membership_id, r.member_id, r.full_name, r.phone, r.email, r.plan_name, r.plan_price, r.currency, r.total_credits,
           r.credits_used, r.credits_remaining, r.purchased_at, r.start_date, r.end_date, r.membership_status, r.payment_status,
           r.payment_amount, count(*) over ()
    from public._rpt_memberships(p_from, p_to, p_status, p_plan) r
    order by r.purchased_at, r.membership_id limit p_limit offset p_offset;
end;
$$;

create or replace function public.admin_report_payments(
  p_from date default null, p_to date default null, p_status text default null, p_gateway text default null,
  p_limit int default 200, p_offset int default 0)
returns table (payment_id uuid, member_id uuid, full_name text, phone text, email text, items text, amount numeric,
               currency text, gateway text, gateway_order_id text, gateway_payment_id text, payment_status text,
               created_at timestamptz, paid_at timestamptz, membership_state text, total_count bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._rpt_guard(p_from, p_to, p_limit, p_offset);
  if p_status is not null and p_status not in ('created', 'pending', 'processing', 'success', 'failed', 'expired', 'refunded', 'partially_refunded') then raise exception 'INVALID_STATUS'; end if;
  if p_gateway is not null and p_gateway !~ '^[A-Za-z0-9_-]{1,40}$' then raise exception 'INVALID_GATEWAY'; end if;
  return query
    select r.payment_id, r.member_id, r.full_name, r.phone, r.email, r.items, r.amount, r.currency, r.gateway,
           r.gateway_order_id, r.gateway_payment_id, r.payment_status, r.created_at, r.paid_at, r.membership_state, count(*) over ()
    from public._rpt_payments(p_from, p_to, p_status, p_gateway) r
    order by r.created_at, r.payment_id limit p_limit offset p_offset;
end;
$$;

create or replace function public.admin_report_bookings(
  p_from date default null, p_to date default null, p_status text default null, p_plan text default null,
  p_limit int default 200, p_offset int default 0)
returns table (booking_id uuid, member_id uuid, full_name text, phone text, email text, plan_name text, session_date date,
               weekday text, start_time time, end_time time, booking_status text, attendance_status text,
               reschedule_count integer, recurring_schedule_id uuid, booking_source text, total_count bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._rpt_guard(p_from, p_to, p_limit, p_offset);
  if p_status is not null and p_status not in ('held', 'confirmed', 'cancelled', 'completed', 'no_show', 'expired', 'absent', 'rescheduled') then raise exception 'INVALID_STATUS'; end if;
  if p_plan is not null and p_plan !~ '^[A-Za-z0-9_-]{1,40}$' then raise exception 'INVALID_PLAN'; end if;
  return query
    select r.booking_id, r.member_id, r.full_name, r.phone, r.email, r.plan_name, r.session_date, r.weekday, r.start_time, r.end_time,
           r.booking_status, r.attendance_status, r.reschedule_count, r.recurring_schedule_id, r.booking_source, count(*) over ()
    from public._rpt_bookings(p_from, p_to, p_status, p_plan) r
    order by r.session_date, r.start_time, r.booking_id limit p_limit offset p_offset;
end;
$$;

-- ─── Preview summary: the same rows, counted and totalled ───────────────────────────────────────────────────
-- Payments: successful revenue counts ONLY status 'success'. Refunded and partially refunded are listed separately with
-- the original payment amount (the database holds no refund amount, so none is shown and nothing is netted off).
create or replace function public.admin_report_summary(
  p_report text, p_from date default null, p_to date default null, p_status text default null,
  p_plan text default null, p_gateway text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v jsonb;
begin
  perform public._rpt_guard(p_from, p_to, 1, 0);
  if p_report = 'members' then
    if p_status is not null and p_status not in ('none', 'pending_payment', 'active', 'expired', 'cancelled', 'suspended') then raise exception 'INVALID_STATUS'; end if;
    select jsonb_build_object('total', coalesce(sum(n), 0),
      'by_membership_status', coalesce(jsonb_object_agg(s, n) filter (where s is not null), '{}'::jsonb))
    into v from (select coalesce(r.membership_status, 'none') s, count(*) n from public._rpt_members(p_from, p_to, p_status, p_plan) r group by 1) x;
    return coalesce(v, jsonb_build_object('total', 0, 'by_membership_status', '{}'::jsonb));
  elsif p_report = 'memberships' then
    if p_status is not null and p_status not in ('pending_payment', 'active', 'expired', 'cancelled', 'suspended') then raise exception 'INVALID_STATUS'; end if;
    select jsonb_build_object('total', coalesce(sum(n), 0), 'credits_total', coalesce(sum(total_credits), 0),
      'credits_used', coalesce(sum(credits_used), 0), 'credits_remaining', coalesce(sum(credits_remaining), 0),
      'by_status', coalesce(jsonb_object_agg(s, n), '{}'::jsonb))
    into v from (select r.membership_status s, count(*) n, sum(r.total_credits) total_credits, sum(r.credits_used) credits_used,
                        sum(r.credits_remaining) credits_remaining
                 from public._rpt_memberships(p_from, p_to, p_status, p_plan) r group by 1) x;
    return coalesce(v, jsonb_build_object('total', 0, 'credits_total', 0, 'credits_used', 0, 'credits_remaining', 0, 'by_status', '{}'::jsonb));
  elsif p_report = 'payments' then
    if p_status is not null and p_status not in ('created', 'pending', 'processing', 'success', 'failed', 'expired', 'refunded', 'partially_refunded') then raise exception 'INVALID_STATUS'; end if;
    select jsonb_build_object(
      'total', coalesce(sum(n), 0),
      'by_status', coalesce(jsonb_object_agg(s, jsonb_build_object('count', n, 'amount', amt)), '{}'::jsonb),
      'successful_revenue', jsonb_build_object('count', coalesce(max(n) filter (where s = 'success'), 0), 'amount', coalesce(max(amt) filter (where s = 'success'), 0)),
      'refunded_original_amount', jsonb_build_object('count', coalesce(max(n) filter (where s = 'refunded'), 0), 'amount', coalesce(max(amt) filter (where s = 'refunded'), 0)),
      'partially_refunded_original_amount', jsonb_build_object('count', coalesce(max(n) filter (where s = 'partially_refunded'), 0), 'amount', coalesce(max(amt) filter (where s = 'partially_refunded'), 0)),
      'currency', 'INR',
      'note', 'Revenue counts only payments with status success. Refunded and partially refunded payments show their original amount; the database records no refund amount, so nothing is netted off.')
    into v from (select r.payment_status s, count(*) n, coalesce(sum(r.amount), 0) amt
                 from public._rpt_payments(p_from, p_to, p_status, p_gateway) r group by 1) x;
    return v;
  elsif p_report = 'bookings' then
    if p_status is not null and p_status not in ('held', 'confirmed', 'cancelled', 'completed', 'no_show', 'expired', 'absent', 'rescheduled') then raise exception 'INVALID_STATUS'; end if;
    select jsonb_build_object('total', coalesce(sum(n), 0), 'by_status', coalesce(jsonb_object_agg(s, n), '{}'::jsonb))
    into v from (select r.booking_status s, count(*) n from public._rpt_bookings(p_from, p_to, p_status, p_plan) r group by 1) x;
    return v;
  end if;
  raise exception 'INVALID_REPORT';
end;
$$;

-- ─── Audit: who exported what (metadata only) ───────────────────────────────────────────────────────────────
create or replace function public.admin_log_export(p_report text, p_format text, p_filters jsonb, p_rows int, p_outcome text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_filters jsonb := '{}'::jsonb;
  k text;
  v text;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  if p_report not in ('members', 'memberships', 'payments', 'bookings', 'combined') then raise exception 'INVALID_REPORT'; end if;
  if p_format not in ('xlsx', 'pdf') then raise exception 'INVALID_FORMAT'; end if;
  if p_outcome not in ('success', 'failure') then raise exception 'INVALID_OUTCOME'; end if;
  -- Only known filter keys, short plain values. Whatever else the caller sends is dropped, never stored.
  if p_filters is not null and jsonb_typeof(p_filters) = 'object' then
    foreach k in array array['from', 'to', 'status', 'plan', 'gateway'] loop
      v := p_filters ->> k;
      if v is not null and v ~ '^[A-Za-z0-9_:. -]{1,40}$' then v_filters := v_filters || jsonb_build_object(k, v); end if;
    end loop;
  end if;
  perform public._audit('admin_exports', auth.uid(), 'REPORT_EXPORT', null,
    jsonb_build_object('report', p_report, 'format', p_format, 'filters', v_filters,
                       'rows', greatest(least(coalesce(p_rows, 0), 1000000), 0), 'outcome', p_outcome));
end;
$$;

-- ─── Grants: signed-in callers may EXECUTE; every function still refuses anyone who is not an administrator ───
revoke execute on function public.admin_report_members(date, date, text, text, int, int) from public, anon;
revoke execute on function public.admin_report_memberships(date, date, text, text, int, int) from public, anon;
revoke execute on function public.admin_report_payments(date, date, text, text, int, int) from public, anon;
revoke execute on function public.admin_report_bookings(date, date, text, text, int, int) from public, anon;
revoke execute on function public.admin_report_summary(text, date, date, text, text, text) from public, anon;
revoke execute on function public.admin_log_export(text, text, jsonb, int, text) from public, anon;
grant execute on function public.admin_report_members(date, date, text, text, int, int) to authenticated;
grant execute on function public.admin_report_memberships(date, date, text, text, int, int) to authenticated;
grant execute on function public.admin_report_payments(date, date, text, text, int, int) to authenticated;
grant execute on function public.admin_report_bookings(date, date, text, text, int, int) to authenticated;
grant execute on function public.admin_report_summary(text, date, date, text, text, text) to authenticated;
grant execute on function public.admin_log_export(text, text, jsonb, int, text) to authenticated;

notify pgrst, 'reload schema';

commit;
