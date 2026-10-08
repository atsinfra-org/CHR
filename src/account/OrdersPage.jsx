import { useCallback, useEffect, useState } from "react";
import { Receipt } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import AccountStateGuard from "./AccountStateGuard";
import { ActionButton, Card, CardSkeleton, EmptyState, ErrorState, PageHeader, StatusPill } from "./ui";
import { collectionNote, orderNumber, orderStatusLabel, paymentSummary } from "../lib/labels";
import { formatINR } from "../store/cartMath";

const GROUPS = [
  { key: "membership", label: "Membership" },
  { key: "tack", label: "Tack shop" },
  { key: "cafe", label: "Café" },
];

/**
 * The customer's own orders (RLS: orders/order_items/payments are readable
 * only by their owner). Read-only — payment confirmation and collection are
 * staff actions; this page just reflects the database.
 */
export default function OrdersPage() {
  return <AccountStateGuard active="orders">{({ user }) => <Orders userId={user.id} />}</AccountStateGuard>;
}

function Orders({ userId }) {
  const [state, setState] = useState({ status: "loading", error: null, orders: [] });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: "loading", error: null }));
    const { data, error } = await supabase
      .from("orders")
      .select(
        "id, status, total_amount, currency, has_membership, has_in_store, created_at, updated_at, paid_at, " +
          "order_items(name, quantity, category, unit_price), payments(gateway, status)"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      setState({ status: "error", error: error.message, orders: [] });
      return;
    }
    setState({ status: "ready", error: null, orders: data ?? [] });
  }, [userId]);

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
        <ErrorState title="Couldn't load your orders" detail={state.error} onRetry={load} />
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
            <OrderCard key={o.id} order={o} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderCard({ order: o }) {
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
        {o.status === "pending" && (
          <p className="mt-3 font-sans text-xs leading-relaxed text-warm-grey">
            Your payment hasn&apos;t been confirmed yet. {o.has_membership ? "Your membership activates once it is. " : ""}
            Unpaid orders are cancelled automatically after a while.
          </p>
        )}
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
