#!/usr/bin/env bash
# Concurrency test for class places and credits. LOCAL REPLICA ONLY (it commits test rows into its own scratch database).
# Many members try to book the SAME 3-place class at the same moment, and one member sends the same request twice at
# once. Exactly 3 places may be taken, no member is charged for a refused booking, and the duplicate request books once.
#
#   PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=... TEMPLATE_DB=chrfull bash supabase/tests/recurring-capacity-concurrency.sh [members=10]
set -u
: "${TEMPLATE_DB:?set TEMPLATE_DB to a local database with the schema through 0035}"
case "${PGHOST:-}" in 127.0.0.1|localhost) ;; *) echo "refusing to run: PGHOST must be 127.0.0.1 or localhost"; exit 2;; esac
N="${1:-10}"; DB=chrcap
psqlx() { psql -v ON_ERROR_STOP=1 -q -At "$@" | sed 's/[[:cntrl:]]//g'; }
pass=0; fail=0
ok() { if [ "$2" = "1" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1 (${3:-})"; fi; }
psqlx -d postgres -c "drop database if exists $DB" -c "create database $DB template $TEMPLATE_DB" >/dev/null 2>&1

psqlx -d $DB >/dev/null <<SQL
alter table public.profiles disable trigger trg_prevent_privilege_escalation;
create temp table users as select gen_random_uuid() id, g n from generate_series(1, $N) g;
insert into auth.users (id, email, raw_user_meta_data, aud, role)
  select id, 'cap-' || n || '@test.invalid', '{"full_name":"Cap Rider"}', 'authenticated', 'authenticated' from users;
insert into public.memberships (user_id, plan_id, status, start_date, end_date, total_credits, reschedules_allowed, reschedules_used)
  select u.id, p.id, 'active', (now() at time zone 'Asia/Kolkata')::date, (now() at time zone 'Asia/Kolkata')::date + 29, 8, p.reschedules_allowed, 0
  from users u, public.membership_plans p where p.plan_code = 'GOLD';
insert into public.credit_ledger (user_id, membership_id, amount, transaction_type, description)
  select m.user_id, m.id, 8, 'membership_purchase', 'cap test' from public.memberships m where m.user_id in (select id from users);
SQL

# an empty, future, open class with 3 places, and a second one for the duplicate-request check
read -r S1 S2 <<<"$(psqlx -d $DB -c "select string_agg(id::text, ' ') from (select cs.id from public.class_sessions cs where cs.status='open' and cs.session_date between (now() at time zone 'Asia/Kolkata')::date + 1 and (now() at time zone 'Asia/Kolkata')::date + 5 and not exists (select 1 from public.bookings b where b.session_id=cs.id and b.status in ('held','confirmed','completed','no_show')) order by cs.session_date, cs.start_time limit 2) x")"
[ -n "${S2:-}" ] || { echo "not enough empty classes in the replica (generate sessions first)"; exit 2; }
psqlx -d $DB -c "update public.class_sessions set capacity = 3 where id = '$S1'" >/dev/null
USERS=$(psqlx -d $DB -c "select id from public.profiles where email like 'cap-%@test.invalid' order by email")

book() { # user, session  -> prints OK or the error code
  out=$(psqlx -d $DB -c "select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, false); set role authenticated; select id from public.book_class('$2')" 2>&1)
  if echo "$out" | grep -q "ERROR"; then echo "$out" | grep -m1 "ERROR" | tr -d "" | cut -c1-90; else echo OK; fi
}
export -f book psqlx; export DB

res=$(mktemp); i=0
for u in $USERS; do book "$u" "$S1" >> "$res" & i=$((i+1)); done; wait
echo "results: $(sort "$res" | uniq -c | tr "
" " ")"; booked=$(grep -c "^OK" "$res"); refused=$(grep -c "ERROR" "$res")
ok "$N members race for a 3-place class: exactly 3 get a place" "$([ "$booked" = 3 ] && echo 1)" "booked=$booked"
ok "the others are refused (full), none crash" "$([ "$refused" = $((N-3)) ] && echo 1)" "refused=$refused"
ok "the database agrees: 3 live bookings on that class" "$([ "$(psqlx -d $DB -c "select count(*) from public.bookings where session_id='$S1' and status in ('held','confirmed')")" = 3 ] && echo 1)"
ok "only the 3 booked members were charged (one credit each); refused members keep all 8" "$([ "$(psqlx -d $DB -c "select count(*) from public.credit_ledger where transaction_type like '%booking%' or amount < 0")" = 3 ] && echo 1)" "$(psqlx -d $DB -c "select count(*) from public.credit_ledger where amount<0")"
ok "no membership balance is negative" "$([ "$(psqlx -d $DB -c "select count(*) from (select membership_id, sum(amount) s from public.credit_ledger group by 1) x where s < 0")" = 0 ] && echo 1)"

# the same member, the same request, sent 6 times at once
U1=$(echo "$USERS" | sed -n 1p); : > "$res"
for k in 1 2 3 4 5 6; do book "$U1" "$S2" >> "$res" & done; wait
ok "the same request sent 6 times at once books once" "$([ "$(grep -c '^OK' "$res")" = 1 ] && echo 1)" "$(sort "$res" | uniq -c | tr '\n' ' ')"
ok "...and takes exactly one class from the plan" "$([ "$(psqlx -d $DB -c "select count(*) from public.bookings where user_id='$U1' and session_id='$S2' and status in ('held','confirmed')")" = 1 ] && echo 1)"
rm -f "$res"
psqlx -d postgres -c "drop database if exists $DB" >/dev/null 2>&1
echo; echo "$pass passed, $fail failed"; [ $fail = 0 ]
