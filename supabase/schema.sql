-- Colonel Horse Riding — enquiry storage + admin access
-- Run this once in the Supabase SQL editor (Project -> SQL Editor -> New query).
--
-- Security model: the browser only ever holds the *anon* key, which is
-- public by design. Everything that actually protects this data is the Row
-- Level Security (RLS) policies below — anyone can INSERT (the public
-- enquiry form), but only a signed-in admin can SELECT (the dashboard).

create table if not exists public.enquiries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  age smallint not null,
  email text not null,
  phone text not null,
  -- Which card/CTA the enquiry came from (e.g. "Book Riding Classes",
  -- "Café") — null for a generic "Enquire Now" with no specific topic.
  topic text
);

alter table public.enquiries enable row level security;

-- Public enquiry form: anyone (including a logged-out visitor) can submit.
drop policy if exists "Anyone can submit an enquiry" on public.enquiries;
create policy "Anyone can submit an enquiry"
  on public.enquiries
  for insert
  to anon, authenticated
  with check (true);

-- Admin dashboard: only signed-in users may read submissions.
--
-- IMPORTANT: by default, Supabase Auth lets anyone sign up for an account,
-- and *any* authenticated user would satisfy this policy. Before relying on
-- this in production, do ONE of:
--   1. Turn off public sign-ups: Authentication -> Providers -> Email ->
--      disable "Allow new users to sign up". Create the admin account
--      yourself instead (Authentication -> Users -> Add user).
--   2. Or replace `true` below with an allowlist, e.g.:
--      using (auth.email() in ('you@example.com'))
drop policy if exists "Authenticated users can read enquiries" on public.enquiries;
create policy "Authenticated users can read enquiries"
  on public.enquiries
  for select
  to authenticated
  using (true);

-- Optional: let an admin delete a handled enquiry from the dashboard.
drop policy if exists "Authenticated users can delete enquiries" on public.enquiries;
create policy "Authenticated users can delete enquiries"
  on public.enquiries
  for delete
  to authenticated
  using (true);
