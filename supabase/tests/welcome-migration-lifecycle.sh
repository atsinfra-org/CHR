#!/usr/bin/env bash
# Lifecycle test for 0034_welcome_email (apply twice, constraint drift, rollback that keeps history, reapply).
# Runs ONLY against a local replica (never production). Needs a template database that already has 0016-0033 applied and an
# auth.users with email_confirmed_at, deleted_at, banned_until (see the notes in docs/TRANSACTIONAL_EMAIL.md).
#
#   PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=... TEMPLATE_DB=chrbase033 bash supabase/tests/welcome-migration-lifecycle.sh
# It creates and drops its own scratch databases (chrlife_*).
set -u
: "${TEMPLATE_DB:?set TEMPLATE_DB to a local database with 0033 applied}"
case "${PGHOST:-}" in 127.0.0.1|localhost) ;; *) echo "refusing to run: PGHOST must be 127.0.0.1 or localhost"; exit 2;; esac
HERE="$(cd "$(dirname "$0")/.." && pwd)"
UP="$HERE/proposals/0034_welcome_email.sql"; DOWN="$HERE/proposals/0034_welcome_email.down.sql"; P033="$HERE/proposals/0033_transactional_email.sql"
PSQL="psql -v ON_ERROR_STOP=1 -q -At"
fail=0; pass=0
ok() { if [ "$2" = "1" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1"; fi; }
mk() { $PSQL -d postgres -c "drop database if exists $1" -c "create database $1 template $TEMPLATE_DB" >/dev/null 2>&1; }
q() { $PSQL -d "$DB" -c "$1" 2>&1; }
ENABLE="update public.system_settings set value = to_jsonb(to_char(now() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')) where key='welcome_email_start'"
NEWUSER() { q "insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at,created_at) values ('$1','$2@example.org','{\"full_name\":\"T $2\"}',now(),now()+interval '1 second')" >/dev/null; }

# ── 1. apply twice; the activation survives a re-apply ──
DB=chrlife_a; mk $DB
$PSQL -d $DB -f "$UP" >/dev/null 2>&1; r1=$?
$PSQL -d $DB -c "$ENABLE" >/dev/null; before=$(q "select value from public.system_settings where key='welcome_email_start'")
$PSQL -d $DB -f "$UP" >/dev/null 2>&1; r2=$?
after=$(q "select value from public.system_settings where key='welcome_email_start'")
ok "0034 applies cleanly, and a second apply is safe" "$([ $r1 = 0 ] && [ $r2 = 0 ] && echo 1)"
ok "re-applying keeps the activation timestamp (does not switch off or reset)" "$([ -n "$before" ] && [ "$before" = "$after" ] && echo 1)"
NEWUSER aaaaaaaa-0000-4000-8000-000000000001 one
ok "after activation, a new confirmed account queues exactly one welcome" "$([ "$(q "select count(*) from email_outbox where template='welcome'")" = 1 ] && echo 1)"

# ── 2. rollback keeps history; reapply works; nothing unrelated is touched ──
q "update email_outbox set status='sent', delivery_status='accepted', provider_message_id='msg_test_1' where template='welcome'" >/dev/null
NEWUSER aaaaaaaa-0000-4000-8000-000000000002 two        # stays queued
q "insert into public.email_outbox(dedupe_key,template,user_id,related_type,related_id,status) select 'payment.succeeded:'||gen_random_uuid(),'payment_received',id,'order',gen_random_uuid(),'sent' from public.profiles limit 1" >/dev/null
total_before=$(q "select count(*) from email_outbox"); other_before=$(q "select count(*) from email_outbox where template<>'welcome'")
$PSQL -d $DB -f "$DOWN" >/dev/null 2>&1; rd=$?
ok "rollback runs" "$([ $rd = 0 ] && echo 1)"
ok "rollback deletes no email row (sent, queued, and other templates all remain)" "$([ "$(q "select count(*) from email_outbox")" = "$total_before" ] && [ "$(q "select count(*) from email_outbox where template<>'welcome'")" = "$other_before" ] && echo 1)"
ok "the sent welcome row is unchanged" "$([ "$(q "select count(*) from email_outbox where template='welcome' and status='sent' and provider_message_id='msg_test_1'")" = 1 ] && echo 1)"
ok "a still-waiting welcome job is marked skipped (feature_rolled_back), not left to send" "$([ "$(q "select count(*) from email_outbox where template='welcome' and status='skipped' and last_error_category='feature_rolled_back'")" = 1 ] && echo 1)"
ok "the old welcome row can still receive delivery updates after rollback" "$([ "$(q "select public.record_email_provider_event('msg_test_1','email.delivered')" | head -1)" != "" ] && [ "$(q "select delivery_status from email_outbox where provider_message_id='msg_test_1'")" = delivered ] && echo 1)"
ok "triggers, helpers and the setting are gone" "$([ "$(q "select (select count(*) from pg_trigger where tgname like 'trg_z_welcome%')+(select count(*) from pg_proc where proname in ('_trg_welcome_email','_queue_welcome_email','_welcome_start'))+(select count(*) from system_settings where key='welcome_email_start')")" = 0 ] && echo 1)"
ok "email_job_context is the 0033 version again (no welcome branch)" "$([ "$(q "select pg_get_functiondef('public.email_job_context(uuid)'::regprocedure) like '%welcome%'")" = f ] && echo 1)"
NEWUSER aaaaaaaa-0000-4000-8000-000000000003 three
ok "after rollback a new account queues no welcome" "$([ "$(q "select count(*) from email_outbox where template='welcome'")" = 2 ] && echo 1)"
$PSQL -d $DB -f "$UP" >/dev/null 2>&1; rr=$?
ok "re-applying 0034 after a rollback works and keeps all history" "$([ $rr = 0 ] && [ "$(q "select count(*) from email_outbox")" = "$total_before" ] && echo 1)"
ok "the setting is blank after the re-apply (feature OFF until deliberately enabled)" "$([ "$(q "select value from system_settings where key='welcome_email_start'")" = '""' ] && echo 1)"

# ── 3. rollback with NO welcome history restores the exact original constraints ──
DB=chrlife_b; mk $DB
orig=$(q "select string_agg(conname||pg_get_constraintdef(oid), '|' order by conname) from pg_constraint where conrelid='public.email_outbox'::regclass and contype='c'")
$PSQL -d $DB -f "$UP" >/dev/null 2>&1; $PSQL -d $DB -f "$DOWN" >/dev/null 2>&1
now=$(q "select string_agg(conname||pg_get_constraintdef(oid), '|' order by conname) from pg_constraint where conrelid='public.email_outbox'::regclass and contype='c'")
ok "apply + rollback with no welcome rows restores the original constraints exactly" "$([ "$orig" = "$now" ] && echo 1)"

# ── 4. constraint drift: a renamed old CHECK must make the migration FAIL, loudly, changing nothing ──
DB=chrlife_c; mk $DB
q "alter table public.email_outbox rename constraint email_outbox_template_check to some_old_name" >/dev/null
out=$($PSQL -d $DB -f "$UP" 2>&1); rc=$?
ok "a renamed old template CHECK makes 0034 fail with a clear message" "$([ $rc != 0 ] && echo "$out" | grep -q "unexpected CHECK some_old_name" && echo 1)"
ok "...and the failed run changed nothing (no triggers, no setting)" "$([ "$(q "select (select count(*) from pg_trigger where tgname like 'trg_z_welcome%')+(select count(*) from system_settings where key='welcome_email_start')")" = 0 ] && echo 1)"
DB=chrlife_d; mk $DB
q "alter table public.email_outbox rename constraint email_outbox_related_type_check to some_old_rel" >/dev/null
out=$($PSQL -d $DB -f "$UP" 2>&1); rc=$?
ok "a renamed old related_type CHECK makes 0034 fail with a clear message" "$([ $rc != 0 ] && echo "$out" | grep -q "unexpected CHECK some_old_rel" && echo 1)"

# ── 5. why the rollback does not use NOT VALID: it would block updates of old welcome rows ──
DB=chrlife_e; mk $DB
$PSQL -d $DB -f "$UP" >/dev/null 2>&1; $PSQL -d $DB -c "$ENABLE" >/dev/null; NEWUSER aaaaaaaa-0000-4000-8000-000000000009 nine
q "alter table public.email_outbox drop constraint email_outbox_template_check, add constraint email_outbox_template_check check (template in ('payment_received','membership_activated','booking_confirmed','reschedule_confirmed','order_confirmation','payment_pending')) not valid" >/dev/null
out=$(q "update public.email_outbox set status='sent' where template='welcome'")
ok "a NOT VALID narrow constraint WOULD reject updates to an old welcome row (so the rollback keeps the wider one)" "$(echo "$out" | grep -q "violates check constraint" && echo 1)"

for d in a b c d e; do $PSQL -d postgres -c "drop database if exists chrlife_$d" >/dev/null 2>&1; done
echo; echo "$pass passed, $fail failed"; [ $fail = 0 ]
