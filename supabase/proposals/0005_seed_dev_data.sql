-- ============================================================================
-- PROPOSAL — NOT APPLIED. Part of Phase 2 of the database redesign.
-- DEV/STAGING ONLY. Do not run against the live project — this is fake
-- placeholder data for local development and testing, not real content.
-- ============================================================================

-- System settings the RPCs read.
insert into public.system_settings (key, value, description) values
  ('cancellation_cutoff_hours', '24', 'Hours before a session start below which a cancellation forfeits the credit'),
  ('default_session_capacity', 'null', 'Fallback session capacity when a schedule_templates row does not override it (null = derive from active horse count)'),
  ('booking_window_days', '30', 'How many days ahead a member may book — matches the 30-day membership validity'),
  ('max_future_bookings', '8', 'Cap on a member''s simultaneous held/confirmed future bookings'),
  ('waitlist_enabled', 'false', 'Whether a full session accepts waitlist entries (not implemented yet)')
on conflict (key) do nothing;

-- 3 horses — matches the current real-world count, but nothing in the schema
-- hardcodes "3"; add or retire rows freely.
insert into public.horses (name, description, status) values
  ('Midnight', 'Bay gelding, calm temperament, suitable for junior riders.', 'available'),
  ('Storm', 'Grey mare, experienced, suitable for adult riders.', 'available'),
  ('Duke', 'Chestnut gelding, steady and reliable.', 'available')
on conflict do nothing;

-- Weekly schedule: 2 morning + 2 evening sessions, every day.
-- capacity left null on every row so it derives from the active horse count
-- (3) at generation time — change any single day/time independently later.
insert into public.schedule_templates (day_of_week, start_time, end_time) values
  (0, '06:00', '07:00'), (0, '07:00', '08:00'), (0, '16:00', '17:00'), (0, '17:00', '18:00'),
  (1, '06:00', '07:00'), (1, '07:00', '08:00'), (1, '16:00', '17:00'), (1, '17:00', '18:00'),
  (2, '06:00', '07:00'), (2, '07:00', '08:00'), (2, '16:00', '17:00'), (2, '17:00', '18:00'),
  (3, '06:00', '07:00'), (3, '07:00', '08:00'), (3, '16:00', '17:00'), (3, '17:00', '18:00'),
  (4, '06:00', '07:00'), (4, '07:00', '08:00'), (4, '16:00', '17:00'), (4, '17:00', '18:00'),
  (5, '06:00', '07:00'), (5, '07:00', '08:00'), (5, '16:00', '17:00'), (5, '17:00', '18:00'),
  (6, '06:00', '07:00'), (6, '07:00', '08:00'), (6, '16:00', '17:00'), (6, '17:00', '18:00');

-- Confirmed pricing: two age-gated plans, not one flat plan. min_age/max_age
-- are inclusive bounds (see membership_plans in 0002) — Junior leaves
-- min_age null (no lower bound) and caps max_age at 11; Adult sets min_age
-- 12 and leaves max_age null (no upper bound). begin_membership_purchase()
-- enforces this against profiles.date_of_birth server-side.
insert into public.membership_plans (name, description, price, currency, class_credits, validity_days, min_age, max_age) values
  ('Junior Riding Membership', '8 riding classes per month, flexible scheduling. Under 12 years.', 12000.00, 'INR', 8, 30, null, 11),
  ('Adult Riding Membership', '8 riding classes per month, flexible scheduling. Age 12 and above.', 16000.00, 'INR', 8, 30, 12, null);

-- Generate concrete bookable sessions for the next 30 days from the
-- templates above — matches booking_window_days (30) above; generating only
-- part of the window would leave the tail of it unbookable in dev/staging.
-- NOTE: this inserts directly rather than calling generate_sessions() —
-- that RPC checks is_staff_or_admin() via auth.uid(), which is null when
-- run as a script/superuser in the SQL editor (no authenticated request
-- context), so it would reject itself here. Direct insert is correct for a
-- trusted seed script; the RPC is what the admin panel calls for the same
-- operation once a real session exists.
insert into public.class_sessions (session_date, start_time, end_time, capacity, template_id)
select d::date, t.start_time, t.end_time,
       coalesce(t.capacity, (select count(*) from public.horses where is_active and status = 'available')),
       t.id
from generate_series(current_date, current_date + 30, interval '1 day') as d
join public.schedule_templates t on t.day_of_week = extract(dow from d) and t.is_active
on conflict (session_date, start_time, end_time) do nothing;
