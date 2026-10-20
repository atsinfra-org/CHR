-- Phase 19 test: welcome email on genuinely new accounts only (0034). Apply 0016–0034 first.
-- One transaction, ends in ROLLBACK. Uses isolated test users only (@example.org, never a real member): never run this against
-- real members. It inserts into auth.users, so the REAL handle_new_user() trigger creates the profiles, and it
-- proves the welcome hook against that, not against a stand-in.
-- The local replica's auth.users is a stub: it needs email_confirmed_at (Supabase has it) before this runs.
-- Prints "ALL PHASE 19 CHECKS PASSED" on success.

begin;

create function pg_temp.must(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin if p_ok is not true then raise exception 'FAIL: %', p_msg; end if; end $$;

create function pg_temp.n_welcome(p_user uuid) returns bigint language sql as $$
  select count(*) from public.email_outbox where template = 'welcome' and user_id = p_user $$;

create function pg_temp.n_all_welcome() returns bigint language sql as $$
  select count(*) from public.email_outbox where template = 'welcome' $$;

create function pg_temp.q_as(p_role text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute 'set local role ' || p_role;
  begin
    execute p_sql into v;
  exception when others then
    execute 'reset role';
    return 'ERR:' || sqlerrm;
  end;
  execute 'reset role';
  return v;
end $$;

do $$
declare
  old_unconfirmed uuid := gen_random_uuid();   -- registered long before the switch, never confirmed
  old_confirmed uuid := gen_random_uuid();     -- registered long before the switch, confirmed
  pw uuid := gen_random_uuid();                -- new email/password account
  gg uuid := gen_random_uuid();                -- new Google account (confirmed on insert)
  off_user uuid := gen_random_uuid();          -- signs up while the switch is off
  anon_name uuid := gen_random_uuid();         -- new account with no name
  before_n bigint; j uuid; ctx jsonb; v text; n bigint;
begin
  -- Accounts that existed before the feature, in both states.
  insert into auth.users (id, email, raw_user_meta_data, created_at, email_confirmed_at)
    values (old_confirmed, 'old-confirmed-' || old_confirmed || '@example.org', '{"full_name":"Old Member"}', now() - interval '30 days', now() - interval '29 days');
  insert into auth.users (id, email, raw_user_meta_data, created_at, email_confirmed_at)
    values (old_unconfirmed, 'old-unconfirmed-' || old_unconfirmed || '@example.org', '{}', now() - interval '30 days', null);
  perform pg_temp.must(pg_temp.n_all_welcome() = 0, 'switch off by default: signing up before the switch queued nothing');
  perform pg_temp.must(public._email_cfg('welcome_email_start') is null, 'the switch ships blank');

  -- 1. Switch OFF: a brand-new confirmed account (Google) and a confirmation both queue nothing.
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
    values (off_user, 'off-' || off_user || '@example.org', '{"full_name":"Off Switch"}', now());
  perform pg_temp.must(pg_temp.n_welcome(off_user) = 0, 'switch off: a new Google account queues nothing');

  -- Switch ON, now. Enabling must not create a single job (no backfill).
  before_n := pg_temp.n_all_welcome();
  update public.system_settings set value = to_jsonb((now() - interval '1 hour')::text), updated_at = now() where key = 'welcome_email_start';
  perform pg_temp.must(pg_temp.n_all_welcome() = before_n, 'enabling the switch back-fills nobody');

  -- 2. Existing users: confirming later, logging in, editing their profile: never emailed.
  update auth.users set email_confirmed_at = now() where id = old_unconfirmed;                       -- confirms late
  perform pg_temp.must(pg_temp.n_welcome(old_unconfirmed) = 0, 'an account created before the switch is not welcomed when it confirms later');
  update auth.users set raw_app_meta_data = '{"provider":"email"}' where id = old_confirmed;          -- a login touches the row
  update auth.users set email_confirmed_at = now() where id = old_confirmed;                          -- confirmed -> confirmed again
  update public.profiles set full_name = 'Old Member Renamed' where id = old_confirmed;               -- profile sync
  perform pg_temp.must(pg_temp.n_welcome(old_confirmed) = 0, 'an existing confirmed user: login / refresh / profile edit queue nothing');

  -- 3. New email/password sign-up: unconfirmed at first (email confirmation is on).
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
    values (pw, 'password-' || pw || '@example.org', '{"full_name":"  Priya   Patel "}', null);
  perform pg_temp.must(exists (select 1 from public.profiles where id = pw), 'the real handle_new_user() created the profile');
  perform pg_temp.must(pg_temp.n_welcome(pw) = 0, 'unconfirmed sign-up: nothing yet (the address is not proven)');
  update public.profiles set full_name = 'Priya Patel' where id = pw;                                  -- profile sync before confirming
  insert into public.profiles (id, email, full_name) values (pw, 'x@example.org', 'dup') on conflict (id) do nothing;
  perform pg_temp.must(pg_temp.n_welcome(pw) = 0, 'profile sync / duplicate profile insert never queues a welcome');
  update auth.users set email_confirmed_at = now() where id = pw;                                      -- clicks the link
  perform pg_temp.must(pg_temp.n_welcome(pw) = 1, 'confirming a new email/password account queues exactly one welcome');
  select id into j from public.email_outbox where template = 'welcome' and user_id = pw;
  perform pg_temp.must((select dedupe_key = 'welcome:' || pw and related_type = 'user' and related_id = pw and status = 'queued' from public.email_outbox where id = j),
    'the job is keyed welcome:<user id>, related to the user, and queued');

  -- 3b. Replays: a repeated callback, a second confirmation, a login, a refresh, an email change.
  update auth.users set email_confirmed_at = now() where id = pw;                                      -- confirmed -> confirmed
  update auth.users set email_confirmed_at = null where id = pw;                                       -- (hypothetical) un-confirm
  update auth.users set email_confirmed_at = now() where id = pw;                                      -- and confirm again
  update auth.users set raw_app_meta_data = '{"provider":"email"}', raw_user_meta_data = '{"full_name":"Priya Patel"}' where id = pw;
  update auth.users set email = 'password-new-' || pw || '@example.org' where id = pw;
  perform pg_temp.must(pg_temp.n_welcome(pw) = 1, 'repeated confirmation, login, refresh and email change never create a second welcome');
  -- Even a direct second enqueue is a no-op (the unique dedupe key).
  perform pg_temp.must(public._queue_welcome_email(pw, now()) = false and pg_temp.n_welcome(pw) = 1, 'calling the hook again for the same user does nothing');

  -- 4. New Google account: confirmed on insert -> exactly one.
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
    values (gg, 'google-' || gg || '@example.org', '{"full_name":"Gita Google"}', now());
  perform pg_temp.must(pg_temp.n_welcome(gg) = 1, 'a new Google account queues exactly one welcome (profile existed when the hook ran)');
  -- Existing Google login: the row is updated (no insert); a repeated OAuth callback re-sends the same confirmed state.
  update auth.users set raw_app_meta_data = '{"provider":"google","providers":["google"]}' where id = gg;
  update auth.users set email_confirmed_at = email_confirmed_at where id = gg;
  update auth.users set email_confirmed_at = now() where id = gg;
  perform pg_temp.must(pg_temp.n_welcome(gg) = 1, 'existing Google login / repeated OAuth callback: still exactly one');

  -- 5. A new account with no name: the job still exists and the context carries no invented name.
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
    values (anon_name, 'noname-' || anon_name || '@example.org', '{}', now());
  select id into j from public.email_outbox where template = 'welcome' and user_id = anon_name;
  perform pg_temp.must(j is not null, 'a new account without a name is still welcomed');
  ctx := public.email_job_context(j);
  perform pg_temp.must(ctx ->> 'ok' = 'true' and ctx ->> 'template' = 'welcome', 'welcome context is ok');
  perform pg_temp.must(ctx -> 'welcome' ->> 'display_name' is null, 'no name -> display_name is null (never the email address)');
  perform pg_temp.must(ctx::text not like '%noname-%' or ctx ->> 'to' like 'noname-%', 'the address appears only as the recipient');
  select id into j from public.email_outbox where template = 'welcome' and user_id = gg;
  ctx := public.email_job_context(j);
  perform pg_temp.must(ctx -> 'welcome' ->> 'display_name' = 'Gita Google', 'display_name is the profile name');
  perform pg_temp.must((select count(*) from jsonb_object_keys(ctx -> 'welcome')) = 1, 'the welcome context holds nothing but the display name');

  -- 6. Erased / unusable address: no job.
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
    values (gen_random_uuid(), 'erased@erased.invalid', '{}', now());
  perform pg_temp.must(pg_temp.n_all_welcome() = 3, 'a *.invalid address is never queued (3 welcomes so far: password, google, no-name)');

  -- 7. Sign-up is never blocked by a broken setting.
  update public.system_settings set value = '"not a date"'::jsonb where key = 'welcome_email_start';
  begin
    insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
      values (gen_random_uuid(), 'garbled-' || gen_random_uuid() || '@example.org', '{}', now());
  exception when others then
    raise exception 'FAIL: sign-up failed because of a bad welcome setting: %', sqlerrm;
  end;
  perform pg_temp.must(pg_temp.n_all_welcome() = 3, 'a bad setting queues nothing and does not break sign-up');
  update public.system_settings set value = '""'::jsonb where key = 'welcome_email_start';
  insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at)
    values (gen_random_uuid(), 'off-' || gen_random_uuid() || '@example.org', '{}', now());
  perform pg_temp.must(pg_temp.n_all_welcome() = 3, 'switching back to blank stops new welcomes');

  -- 7b. The activation value is strict: only an explicit timestamp WITH a zone enables sending.
  declare
    bad text[] := array['', '   ', '2026-01-01', '2026-01-01T00:00:00', '2026-01-01 00:00', 'epoch', 'now', 'tomorrow', 'today', 'yesterday',
                        'infinity', '-infinity', 'allballs', 'garbage', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-01-01T25:00:00Z',
                        '2026-01-01T00:00:00 PST', '2026-01-01T00:00:00+25:00', '1', 'true', '2000-01-01T00:00:00', 'Jan 1 2000 UTC'];
    good text[] := array['2000-01-01T00:00:00Z', '2000-01-01 00:00:00+05:30', '2000-01-01T00:00:00-04:00', '2000-01-01T00:00:00.123456Z',
                         '2000-01-01T00:00Z', '2000-01-01 00:00:00+0530', '2000-01-01T00:00:00+05'];
    x text; nb bigint; u uuid;
  begin
    foreach x in array bad loop
      update public.system_settings set value = to_jsonb(x) where key = 'welcome_email_start';
      perform pg_temp.must(public._welcome_start() is null, 'invalid activation value keeps the feature off: [' || x || ']');
      nb := pg_temp.n_all_welcome(); u := gen_random_uuid();
      insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values (u, 'bad-' || u || '@example.org', '{}', now());
      perform pg_temp.must(pg_temp.n_all_welcome() = nb, 'invalid activation value queues nothing: [' || x || ']');
    end loop;
    -- JSON that is not a string
    foreach x in array array['12345', 'null', 'true', '{"a":1}', '[1]'] loop
      update public.system_settings set value = x::jsonb where key = 'welcome_email_start';
      perform pg_temp.must(public._welcome_start() is null, 'a non-string setting keeps the feature off: ' || x);
    end loop;
    foreach x in array good loop
      update public.system_settings set value = to_jsonb(x) where key = 'welcome_email_start';
      perform pg_temp.must(public._welcome_start() is not null, 'valid activation value accepted: [' || x || ']');
    end loop;
    -- offsets mean what they say
    update public.system_settings set value = '"2026-10-21T10:00:00+05:30"' where key = 'welcome_email_start';
    perform pg_temp.must(public._welcome_start() = '2026-10-21T04:30:00Z'::timestamptz, '+05:30 is converted correctly');
    update public.system_settings set value = '"2026-10-21T10:00:00-04:00"' where key = 'welcome_email_start';
    perform pg_temp.must(public._welcome_start() = '2026-10-21T14:00:00Z'::timestamptz, '-04:00 is converted correctly');
    perform pg_temp.must(public._queue_welcome_email(gen_random_uuid(), '2026-10-21T13:59:59Z') = false, 'an account one second before the activation instant is excluded');
    update public.system_settings set value = '""'::jsonb where key = 'welcome_email_start';
  end;

  -- 8. Privileges: nobody can call the hook from the API.
  v := pg_temp.q_as('anon', format('select public._queue_welcome_email(%L, now())', pw));
  perform pg_temp.must(v like 'ERR:permission denied%', 'anon cannot call _queue_welcome_email: ' || coalesce(v, 'NULL'));
  v := pg_temp.q_as('authenticated', format('select public._queue_welcome_email(%L, now())', pw));
  perform pg_temp.must(v like 'ERR:permission denied%', 'a signed-in member cannot call _queue_welcome_email: ' || coalesce(v, 'NULL'));
  v := pg_temp.q_as('authenticated', 'select count(*) from public.email_outbox');
  perform pg_temp.must(v like 'ERR:permission denied%', 'members still cannot read the outbox');

  -- 9. The other email types are untouched: the constraint still accepts them all.
  perform pg_temp.must((select pg_get_constraintdef(oid) from pg_constraint where conname = 'email_outbox_template_check') ~
    'payment_received.*membership_activated.*booking_confirmed.*reschedule_confirmed.*order_confirmation.*payment_pending.*welcome', 'every template is still allowed');
  perform pg_temp.must((select pg_get_constraintdef(oid) from pg_constraint where conname = 'email_outbox_related_type_check') ~
    'payment.*order.*membership.*booking.*user', 'every related_type is still allowed');
  perform pg_temp.must(public.email_job_context(gen_random_uuid()) ->> 'skip_reason' = 'job_not_found', 'context for an unknown job is unchanged');

  raise notice 'ALL PHASE 19 CHECKS PASSED';
end $$;

rollback;
