import { useCallback, useEffect, useState } from "react";
import { Receipt } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import AccountStateGuard from "./AccountStateGuard";
import { ActionButton, CardSkeleton, EmptyState, ErrorState } from "./ui";
import { collectionNote, orderNumber, orderStatusLabel, paymentSummary } from "../lib/labels";
import RazorpayPaymentFlow from "./purchase/RazorpayPaymentFlow";
import { todayISODate } from "./dashboardUtils";
import { formatINR } from "../store/cartMath";

/**
 * The customer's own orders (RLS: orders/order_items/payments are readable
 * only by their owner). An order that has not been paid can be paid from
 * here; collection status is set by staff and this page just reflects it.
 * Payment is never decided in the browser â€” the order only turns "Paid"
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
      // wallet_applied exists once the referral/wallet database update is applied; until then ask without it.
      const ordersQuery = (cols) =>
        supabase
          .from("orders")
          .select(
            cols +
              "id, status, total_amount, currency, has_membership, has_in_store, created_at, updated_at, paid_at, " +
              "order_items(name, quantity, category, unit_price), payments(id, gateway, status)"
          )
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(50);
      const planQuery = () =>
        // Same rule the server applies: a plan with classes left blocks buying another.
        supabase
          .from("memberships")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("status", "active")
          .gte("end_date", todayISODate())
          .gt("credits_remaining", 0);
      let [orders, plan] = await Promise.all([ordersQuery("wallet_applied, "), planQuery()]);
      if (orders.error) orders = await ordersQuery("");
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
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-[2.4rem] leading-none text-[#1F3A2E] sm:text-[2.8rem]">Orders</h1>
          <p className="mt-3 max-w-md font-sans text-sm leading-relaxed text-warm-grey">
            Your memberships and shop purchases, kept like receipts. Tack and cafÃ© items are collected at the club.
          </p>
        </div>
        <a href="/store" className="font-serif text-lg italic text-[#8a6a33] underline decoration-[#C9A86A]/60 underline-offset-[6px] transition-colors hover:text-[#1F3A2E]">
          Visit the store
        </a>
      </header>

      {state.status === "loading" ? (
        <div className="space-y-5">
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
        <ul className="space-y-7">
          {state.orders.map((o) => (
            <OrderCard key={o.id} order={o} profile={profile} hasActivePlan={state.hasActivePlan} onPaid={() => load(true)} />
          ))}
        </ul>
      )}
    </div>
  );
}

const SEAL = {
  paid: ["Paid", "text-[#1F3A2E] border-[#1F3A2E]/70"],
  ready_for_collection: ["Ready to collect", "text-[#1F3A2E] border-[#1F3A2E]/70"],
  collected: ["Collected", "text-[#1F3A2E] border-[#1F3A2E]/70"],
  pending: ["Awaiting payment", "text-[#8a6a33] border-[#B08D57]/70"],
  cancelled: ["Cancelled", "text-warm-grey border-warm-grey/50"],
  failed: ["Not paid", "text-destructive border-destructive/50"],
};

/** The serrated bottom edge of a printed receipt: small half-circles cut out of the card. */
const TEAR = {
  WebkitMaskImage: "radial-gradient(circle at 7px 100%, transparent 5px, #000 5.5px)",
  WebkitMaskSize: "14px 100%",
  WebkitMaskPosition: "bottom",
  maskImage: "radial-gradient(circle at 7px 100%, transparent 5px, #000 5.5px)",
  maskSize: "14px 100%",
  maskPosition: "bottom",
};

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
  const day = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
  const time = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
  const [sealText, sealTone] = SEAL[o.status] ?? [orderStatusLabel(o.status), "text-warm-grey border-warm-grey/50"];
  const wallet = Number(o.wallet_applied) > 0 ? Number(o.wallet_applied) : 0;
  const settled = pay.label === "Paid";

  return (
    <li className="relative">
      {/* the receipt itself */}
      <article style={TEAR} className="relative bg-[#fdfbf6] px-6 pt-7 pb-9 shadow-[0_1px_0_rgba(27,27,24,0.04),0_18px_40px_-28px_rgba(8,28,21,0.45)] sm:px-9">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-serif text-[1.55rem] leading-tight text-[#1F3A2E]">{day(o.created_at)}</p>
            <p className="mt-1 font-sans text-[13px] text-warm-grey">
              Order {orderNumber(o.id)} Â· {time(o.created_at)}
            </p>
          </div>
          <span className={`shrink-0 rotate-[-4deg] rounded-full border-[1.5px] px-3.5 py-1 font-serif text-[15px] italic ${sealTone}`}>{sealText}</span>
        </div>

        <div className="mt-6 border-t border-dashed border-[#B08D57]/40 pt-5">
          <ul className="space-y-3">
            {items.map((i, n) => (
              <li key={`${i.name}-${n}`} className="font-sans text-[15px] text-charcoal">
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0">
                    {i.name}
                    {i.quantity > 1 && <span className="text-warm-grey"> Ã— {i.quantity}</span>}
                  </span>
                  <span aria-hidden="true" className="min-w-6 flex-1 translate-y-[-4px] border-b border-dotted border-charcoal/25" />
                  <span className="tabular-nums">{formatINR(i.unit_price * i.quantity)}</span>
                </div>
                {KIND[i.category] && <p className="font-serif text-[14px] italic text-warm-grey">{KIND[i.category]}</p>}
              </li>
            ))}
          </ul>

          {wallet > 0 && (
            <p className="mt-3 flex items-baseline gap-3 font-sans text-[14px] text-warm-grey">
              <span>Paid from wallet</span>
              <span aria-hidden="true" className="min-w-6 flex-1 translate-y-[-4px] border-b border-dotted border-charcoal/20" />
              <span className="tabular-nums">âˆ’{formatINR(wallet)}</span>
            </p>
          )}

          <div className="mt-5 flex items-baseline justify-between border-y-[3px] border-double border-[#1F3A2E]/20 py-3">
            <span className="font-serif text-lg text-charcoal">{settled ? "Total paid" : "Total"}</span>
            <span className="font-serif text-[1.7rem] leading-none tabular-nums text-[#1F3A2E]">{formatINR(Number(o.total_amount) - wallet)}</span>
          </div>

          <p className="mt-4 font-sans text-[13px] leading-relaxed text-warm-grey">
            {settled
              ? `Paid with ${pay.method === "â€”" ? "card or UPI" : pay.method} Â· updated ${day(o.updated_at)}, ${time(o.updated_at)}`
              : `${pay.label} Â· updated ${day(o.updated_at)}, ${time(o.updated_at)}`}
          </p>
          {note && <p className="mt-2 font-serif text-[15px] italic text-[#8a6a33]">{note}</p>}
        </div>

        {blocked ? (
          <p className="mt-5 font-sans text-[13px] leading-relaxed text-warm-grey">
            You already have an active plan with classes left, so this order can&apos;t be paid. It will be cancelled automatically.
          </p>
        ) : (unpaid || justPaid) && payment ? (
          <div className="mt-6 border-t border-dashed border-[#B08D57]/40 pt-5">
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
                  ? "Thank you â€” your membership is active. You can now book your first class."
                  : "Thank you â€” your order is confirmed. We'll let you know when it's ready to collect."
              }
              successHref={o.has_membership ? "/account" : "/store"}
              successLabel={o.has_membership ? "Go to Dashboard" : "Back to Store"}
            />
            {!justPaid && <p className="mt-3 font-sans text-xs leading-relaxed text-warm-grey">Unpaid orders are cancelled automatically after a while.</p>}
          </div>
        ) : o.status === "pending" ? (
          <p className="mt-5 font-sans text-[13px] leading-relaxed text-warm-grey">This order hasn&apos;t been paid. Unpaid orders are cancelled automatically after a while.</p>
        ) : null}
      </article>
    </li>
  );
}

const KIND = { membership: "Membership", tack: "Tack shop Â· collect at the club", cafe: "CafÃ© Â· collect at the club" };
