#!/usr/bin/env bash
# Concurrency test: the SAME captured payment delivered by several processes at the SAME instant.
#
# phase18 proves duplicates are harmless one after another. This proves they are harmless when they overlap:
# the Razorpay webhook, its retry, the app's verify call and the recovery job can all arrive together.
#
# For each of N orders it starts W separate database sessions that all wait on one advisory lock, then releases
# them at once so every session calls the REAL process_payment_webhook() in the same instant. It then checks
# that each order ended up with exactly one payment, membership, credit grant, receipt, payment_received email
# and membership_activated email, and that no session failed.
#
# SAFETY. This COMMITS test rows, so it only runs against a disposable local clone:
#   * PGHOST must be this machine (127.0.0.1 / localhost / ::1), never a hosted project;
#   * the database must already have migration 0033 and must contain NO members (a fresh clone has none);
#   * every row it creates is @example.invalid, and the clone is to be dropped afterwards.
# Nothing here ever touches an existing payment.
#
# Usage (Git Bash, psql on PATH):
#   psql -h 127.0.0.1 -p 55432 -U postgres -c "create database chrcc template <a clone with 0033>"
#   PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGDATABASE=chrcc bash supabase/tests/duplicate-payment-concurrency.sh [orders=20] [workers=4]
#   psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -c "drop database chrcc"
set -u

ORDERS="${1:-20}"
WORKERS="${2:-4}"
export PGCONNECT_TIMEOUT=10
: "${PGDATABASE:?set PGDATABASE to the disposable clone}"

case "${PGHOST:-}" in
  127.0.0.1|localhost|::1) ;;
  *) echo "REFUSED: PGHOST must be 127.0.0.1/localhost (got '${PGHOST:-unset}'). This script commits test rows." >&2; exit 2 ;;
esac

q() { psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }

[ "$(q -c "select to_regclass('public.email_outbox') is not null")" = "t" ] || { echo "REFUSED: migration 0033 is not applied in $PGDATABASE" >&2; exit 2; }
if [ "$(q -c "select count(*) from public.profiles")" != "0" ] && [ "${ALLOW_NONEMPTY:-0}" != "1" ]; then
  echo "REFUSED: $PGDATABASE already has members. Use a fresh clone (or set ALLOW_NONEMPTY=1 if you are SURE it is disposable)." >&2; exit 2
fi
if [ "$(q -c "select count(*) from public.payments")" != "0" ] && [ "${ALLOW_NONEMPTY:-0}" != "1" ]; then
  echo "REFUSED: $PGDATABASE already has payments." >&2; exit 2
fi

echo "== fixture: $ORDERS members, each with one unpaid membership order (committed to the disposable clone)"
q <<SQL
do \$\$
declare i int; u uuid; v_prod uuid; v_pay uuid;
begin
  select sp.id into v_prod from public.store_products sp join public.membership_plans pl on pl.id = sp.plan_id
   where sp.category = 'membership' and sp.is_active and pl.is_active and pl.price is not null
     and (pl.min_age is null or pl.min_age <= 35) and (pl.max_age is null or pl.max_age >= 35) order by pl.price limit 1;
  if v_prod is null then raise exception 'no adult membership product in the seed data'; end if;
  for i in 1..$ORDERS loop
    u := gen_random_uuid();
    insert into auth.users (id, email, raw_user_meta_data, aud, role)
      values (u, 'cc-' || i || '-' || left(u::text, 8) || '@example.invalid', '{"full_name":"Concurrent Test"}', 'authenticated', 'authenticated');
    update public.profiles set email = 'cc' || i || '-' || left(u::text, 8) || '@example.org', date_of_birth = '1990-01-01' where id = u;
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    select payment_id into v_pay from public.create_order(jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)));
    perform set_config('request.jwt.claims', '', true);
    update public.payments set gateway_order_id = 'order_cc_' || i where id = v_pay;
  end loop;
end \$\$;
SQL
[ "$(q -c "select count(*) from public.payments where gateway_order_id like 'order_cc_%'")" = "$ORDERS" ] || { echo "fixture failed" >&2; exit 3; }

ERRDIR="$(mktemp -d)"
trap 'rm -rf "$ERRDIR"' EXIT

echo "== racing $WORKERS simultaneous deliveries per order, $ORDERS orders"
for i in $(seq 1 "$ORDERS"); do
  LOCKKEY=$((910000 + i))
  AMOUNT="$(q -c "select amount from public.payments where gateway_order_id = 'order_cc_$i'")"
  # The gate: held exclusively for 2 seconds. Every worker blocks on it, then they are all released together.
  q -c "select pg_advisory_lock($LOCKKEY); select pg_sleep(2);" >/dev/null 2>"$ERRDIR/gate_$i" &
  GATE=$!
  sleep 0.4
  PIDS=()
  for w in $(seq 1 "$WORKERS"); do
    case $(( (w - 1) % 4 )) in
      0) EVT="evt_cc_$i"; TYPE="payment.captured" ;;              # the Razorpay webhook
      1) EVT="evt_cc_$i"; TYPE="payment.captured" ;;              # Razorpay's retry of the SAME delivery
      2) EVT="sync:pay_cc_$i"; TYPE="payment.captured (sync)" ;;  # the app's verify call
      3) EVT="reconcile:pay_cc_$i"; TYPE="payment.captured (reconcile)" ;; # the recovery job
    esac
    # The statement after the gate prints the moment this session was released: used to prove the race was real.
    q -c "select pg_advisory_lock_shared($LOCKKEY)" \
      -c "select extract(epoch from clock_timestamp())" \
      -c "select 1 from public.process_payment_webhook('$EVT','$TYPE','order_cc_$i','pay_cc_$i','success',$AMOUNT,'INR','{}'::jsonb)" \
      >"$ERRDIR/t_${i}_$w" 2>"$ERRDIR/w_${i}_$w" &
    PIDS+=($!)
  done
  wait "$GATE" "${PIDS[@]}" 2>/dev/null
done

SESSION_ERRORS="$(cat "$ERRDIR"/w_* 2>/dev/null | grep -c . || true)"

# How closely were the sessions released? Milliseconds between the first and last session of each order; the widest is kept.
MAX_SPREAD_MS="$(for i in $(seq 1 "$ORDERS"); do
  cat "$ERRDIR"/t_${i}_* 2>/dev/null | grep -E '^[0-9]+[.][0-9]+$' | sort -n | awk 'NR==1{a=$1} {b=$1} END{if (NR>0) printf "%.3f\n", (b-a)*1000}'
done | sort -n | tail -1)"

echo "== verifying every order"
RESULT="$(q <<'SQL'
with o as (
  select p.order_id, p.user_id, p.status, p.gateway_payment_id
  from public.payments p where p.gateway_order_id like 'order_cc_%'
), c as (
  select o.order_id,
    (select count(*) from public.payments x where x.order_id = o.order_id) as payments,
    o.status as pay_status,
    (select count(*) from public.memberships m join public.order_items oi on oi.id = m.order_item_id where oi.order_id = o.order_id) as memberships,
    (select count(*) from public.credit_ledger l where l.user_id = o.user_id and l.transaction_type = 'membership_purchase') as grants,
    (select count(*) from public.payment_receipts r where r.order_id = o.order_id) as receipts,
    (select count(*) from public.email_outbox e where e.related_id = o.order_id and e.template = 'payment_received') as pay_mail,
    (select count(*) from public.email_outbox e where e.user_id = o.user_id and e.template = 'membership_activated') as mem_mail,
    (select count(*) from public.notifications n where n.user_id = o.user_id and n.type = 'payment_success') as pay_notice
  from o)
select count(*) || ' orders; correct=' || count(*) filter (where payments = 1 and pay_status = 'success' and memberships = 1 and grants = 1 and receipts = 1 and pay_mail = 1 and mem_mail = 1 and pay_notice = 1)
  || '; not paid=' || count(*) filter (where pay_status <> 'success')
  || '; duplicated=' || count(*) filter (where memberships > 1 or grants > 1 or receipts > 1 or pay_mail > 1 or mem_mail > 1 or pay_notice > 1)
from c;
SQL
)"
DISTINCT_RECEIPTS="$(q -c "select count(*) = count(distinct receipt_number) from public.payment_receipts")"
echo "$RESULT"
echo "session errors: $SESSION_ERRORS | receipt numbers all distinct: $DISTINCT_RECEIPTS | widest release spread within an order: ${MAX_SPREAD_MS:-?} ms"

# The race only counts if the sessions really started together (they are all released by one lock).
if [ -z "${MAX_SPREAD_MS:-}" ] || awk -v s="$MAX_SPREAD_MS" 'BEGIN{exit !(s > 1500)}'; then
  echo "CONCURRENCY CHECK INVALID: the sessions were not released together (spread ${MAX_SPREAD_MS:-?} ms), so nothing was proven" >&2
  exit 4
fi

EXPECT="$ORDERS orders; correct=$ORDERS; not paid=0; duplicated=0"
if [ "$RESULT" = "$EXPECT" ] && [ "$SESSION_ERRORS" = "0" ] && [ "$DISTINCT_RECEIPTS" = "t" ]; then
  echo "CONCURRENCY CHECK PASSED"
  exit 0
fi
echo "CONCURRENCY CHECK FAILED" >&2
[ "$SESSION_ERRORS" != "0" ] && { echo "--- first session errors:" >&2; cat "$ERRDIR"/w_* | grep . | head -5 >&2; }
exit 1
