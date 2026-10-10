import { useCallback, useEffect, useState } from "react";
import { Receipt } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import AccountStateGuard from "./AccountStateGuard";
import { ActionButton, Card, CardSkeleton, EmptyState, ErrorState, PageHeader, StatusPill } from "./ui";
import { collectionNote, orderNumber, orderStatusLabel, paymentSummary } from "../lib/labels";
import RazorpayPaymentFlow from "./purchase/RazorpayPaymentFlow";
import { todayISODate } from "./dashboardUtils";
import { formatINR } from "../store/cartMath";

const GROUPS = [
  { key: "membership", label: "Membership" },
  { key: "tack", label: "Tack shop" },
  { key: "cafe", label: "Café" },
];

/**
 * The customer's own orders (RLS: orders/order_items/payments are readable
 * only by their owner). An order that has not been paid can be paid from
 * here; collection status is set by staff and this page just reflects it.
 * Payment is never decided in the browser — the order only turns "Paid"
 * when the server has confirmed it with Razorpay.
 */
export default function OrdersPage() {
  return <AccountStateGuard active="orders">{({ user, profile }) => <Orders userId={user.id} profile={profile} />}</AccountStateGuard>;
}

function Orders({ userId, profile }) {
  const [state, setState] = useState({ status: "loading", error: null, orders: [], hasActivePlan: false });

  // `quiet` refreshes in place (after a payment) instead of blanking the list.
  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setState((s) => ({ ...s, status: "loading", error: null }));
      const [orders, plan] = await Promise.all([
        supabase
          .from("orders")
          .select(
            "id, status, total_amount, currency, has_membership, has_in_store, created_at, updated_at, paid_at, " +
              "order_items(name, quantity, category, unit_price), payments(id, gateway, status)"
          )
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(50),
        // Same rule the server applies: a plan with classes left blocks buying another.
        supabase
          .from("memberships")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("status", "active")
          .gte("end_date", todayISODate())
          .gt("credits_remaining", 0),
      ]);
      if (orders.error) {
        if (!quiet) setState({ status: "error", error: orders.error.message, orders: [], hasActivePlan: false });
        return;
      }
      setState({ status: "ready", error: null, orders: orders.data ?? [], hasActivePlan: !plan.error && (plan.count ?? 0) > 0 });
    },
    [userId]
  );

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <PageHeader
        title="My Orders"
        description="Memberships, tack and café orders. Tack and café items are collected in store."
        actions={
          <ActionButton href="/store" variant="secondary">
            Go to Store
          </ActionButton>
        }
      />

      {state.status === "loading" ? (
        <div className="space-y-4">
          <CardSkeleton lines={3} />
          <CardSkeleton lines={3} />
        </div>
      ) : state.status === "error" ? (
        <ErrorState title="Couldn't load your orders" detail={state.error} onRetry={() => load()} />
      ) : state.orders.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="No orders yet"
          detail="When you buy a membership or shop items, they appear here."
          action={
            <ActionButton href="/store" variant="primary">
              Browse the Store
            </ActionButton>
          }
        />
      ) : (
        <ul className="space-y-4">
          {state.orders.map((o) => (
            <OrderCard key={o.id} order={o} profile={profile} hasActivePlan={state.hasActivePlan} onPaid={() => load(true)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderCard({ order: o, profile, hasActivePlan, onPaid }) {
  // Stays true after a successful payment so the confirmation remains on
  // screen while the order underneath refreshes to "Paid".
  const [justPaid, setJustPaid] = useState(false);
  const payment = Array.isArray(o.payments) ? o.payments[0] : o.payments;
  const unpaid = o.status === "pending" && payment?.status === "created" && payment?.gateway === "razorpay";
  // Paying this would buy a second plan while one is still in use; the server refuses it too.
  const blocked = unpaid && o.has_membership && hasActivePlan && !justPaid;
  const pay = paymentSummary(o, o.payments);
  const note = collectionNote(o);
  const items = o.order_items ?? [];
  const when = (iso) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

  return (
    <li>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-serif text-lg text-charcoal">{orderNumber(o.id)}</p>
            <p className="mt-0.5 font-sans text-xs text-warm-grey">Placed {when(o.created_at)}</p>
          </div>
          <div className="text-right">
            <p className="font-serif text-xl tabular-nums text-charcoal">{formatINR(o.total_amount)}</p>
            <StatusPill value={o.status} label={orderStatusLabel(o.status)} />
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {GROUPS.map((g) => {
            const rows = items.filter((i) => i.category === g.key);
            if (rows.length === 0) return null;
            return (
              <div key={g.key}>
                <p className="font-sans text-[11px] tracking-[0.14em] text-warm-grey uppercase">{g.label}</p>
                <ul className="mt-1 space-y-0.5 font-sans text-sm text-charcoal">
                  {rows.map((i) => (
                    <li key={`${g.key}-${i.name}`} className="flex justify-between gap-3">
                      <span>
                        {i.name}
                        {i.quantity > 1 ? ` × ${i.quantity}` : ""}
                      </span>
                      <span className="tabular-nums text-warm-grey">{formatINR(i.unit_price * i.quantity)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-charcoal/10 pt-4 font-sans text-sm sm:grid-cols-3">
          <Fact label="Payment" value={pay.label} />
          <Fact label="Method" value={pay.method} />
          <Fact label="Last updated" value={when(o.updated_at)} />
        </dl>

        {note && <p className="mt-3 rounded-[10px] bg-soft-cream px-3.5 py-2.5 font-sans text-sm text-charcoal">{note}</p>}
        {blocked ? (
          <p className="mt-3 font-sans text-xs leading-relaxed text-warm-grey">
            You already have an active plan with classes left, so this order can&apos;t be paid. It will be cancelled automatically.
          </p>
        ) : (unpaid || justPaid) && payment ? (
          <div className="mt-4 border-t border-charcoal/10 pt-4">
            {!justPaid && (
              <p className="mb-4 font-sans text-sm text-charcoal">
                This order hasn&apos;t been paid yet.{o.has_membership ? " Your membership starts as soon as you pay." : ""}
              </p>
            )}
            <RazorpayPaymentFlow
              paymentId={payment.id}
              plan={{ name: `Order ${orderNumber(o.id)}`, amount: o.total_amount, currency: o.currency }}
              profile={profile}
              onActivated={() => {
                setJustPaid(true);
                onPaid();
              }}
              successTitle="Payment Confirmed"
              successMessage={
                o.has_membership
                  ? "Thank you — your membership is active. You can now book your first class."
                  : "Thank you — your order is confirmed. We'll let you know when it's ready to collect."
              }
              successHref={o.has_membership ? "/account" : "/store"}
              successLabel={o.has_membership ? "Go to Dashboard" : "Back to Store"}
            />
            {!justPaid && <p className="mt-3 font-sans text-xs leading-relaxed text-warm-grey">Unpaid orders are cancelled automatically after a while.</p>}
          </div>
        ) : o.status === "pending" ? (
          <p className="mt-3 font-sans text-xs leading-relaxed text-warm-grey">This order hasn&apos;t been paid. Unpaid orders are cancelled automatically after a while.</p>
        ) : null}
      </Card>
    </li>
  );
}

function Fact({ label, value }) {
  return (
    <div>
      <dt className="text-[11px] tracking-[0.14em] text-warm-grey uppercase">{label}</dt>
      <dd className="mt-0.5 text-charcoal">{value}</dd>
    </div>
  );
}
