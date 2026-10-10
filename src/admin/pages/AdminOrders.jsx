import { useMemo, useState } from "react";
import { RefreshCw, ShoppingBag } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import {
  ActionButton,
  Empty,
  ErrorBox,
  InlineError,
  Loading,
  PageHeader,
  SectionHeader,
  SelectField,
  StatusPill,
  TableShell,
  Toolbar,
} from "../ui";
import { fmtDateTime, fmtMoney, titleCase } from "../adminUtils";
import { orderNumber } from "../../lib/labels";

const STATUS_FILTERS = ["all", "paid", "ready_for_collection", "collected", "pending", "failed", "cancelled"];

/**
 * Store orders (memberships, tack, café). Customers pay online through
 * Razorpay and the server marks an order paid when Razorpay confirms it —
 * nobody marks an order paid by hand. An order that is started but not paid
 * stays "pending" until the customer pays or it expires. Tack and café are
 * in-store only, so the fulfilment workflow here is: paid → ready for
 * collection → collected. Status changes go through admin_set_order_status() (staff or
 * admin, audited); there is no shipping state anywhere. Prices for the
 * unpriced café items (Cold Drink, Water) are set below by an admin via
 * admin_set_product_price() — nothing is priced on anyone's behalf.
 */
export default function AdminOrders({ isAdmin }) {
  const [filter, setFilter] = useState("all");
  const orders = useAdminQuery(() =>
    supabase
      .from("orders")
      .select(
        "id, status, total_amount, currency, has_membership, has_in_store, created_at, paid_at, " +
          "member:profiles!orders_user_id_fkey(full_name, email), order_items(name, quantity, category)"
      )
      .order("created_at", { ascending: false })
      .limit(300)
  );

  const rows = useMemo(() => {
    const all = orders.data ?? [];
    return filter === "all" ? all : all.filter((o) => o.status === filter);
  }, [orders.data, filter]);

  return (
    <div>
      <PageHeader
        route="orders"
        actions={
          <ActionButton icon={RefreshCw} onClick={orders.reload}>
            Refresh
          </ActionButton>
        }
      />

      <Toolbar>
        <SelectField label="Status" value={filter} onChange={(e) => setFilter(e.target.value)} className="min-w-[200px]">
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All orders" : titleCase(s)}
            </option>
          ))}
        </SelectField>
      </Toolbar>

      {orders.status === "error" && <ErrorBox message={orders.error} onRetry={orders.reload} />}
      {orders.status === "loading" && <Loading>Loading orders…</Loading>}
      {orders.status === "ready" &&
        (rows.length === 0 ? (
          <Empty icon={ShoppingBag} detail="Paid orders from the store appear here.">
            No orders
          </Empty>
        ) : (
          <TableShell head={["Placed", "Customer", "Items", "Total", "Status", ""]} minWidth="900px">
            {rows.map((o) => (
              <OrderRow key={`${o.id}:${o.status}`} order={o} onChanged={orders.reload} />
            ))}
          </TableShell>
        ))}

      {isAdmin && <ProductPrices />}
    </div>
  );
}

function OrderRow({ order: o, onChanged }) {
  const [state, setState] = useState({ busy: false, error: null });

  const act = async (status) => {
    if (status === "cancelled" && !window.confirm("Cancel this order? Any refund must be handled separately in Razorpay.")) return;
    setState({ busy: true, error: null });
    const { error } = await adminApi.setOrderStatus(o.id, status);
    if (error) {
      setState({ busy: false, error });
      return;
    }
    setState({ busy: false, error: null });
    onChanged();
  };

  const items = (o.order_items ?? []).map((i) => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join(", ");

  return (
    <tr className="border-b border-charcoal/[0.06] align-top last:border-0 hover:bg-soft-cream/40">
      <td className="whitespace-nowrap px-4 py-3.5 font-sans text-xs text-warm-grey">
        <span className="block font-medium text-charcoal">{orderNumber(o.id)}</span>
        {fmtDateTime(o.created_at)}
      </td>
      <td className="px-4 py-3.5 font-sans text-sm text-charcoal">{o.member?.full_name || o.member?.email || "—"}</td>
      <td className="px-4 py-3.5 font-sans text-sm text-charcoal">
        {items}
        <span className="mt-0.5 block font-sans text-[11px] text-warm-grey">
          {[o.has_membership && "membership", o.has_in_store && "in-store collection"].filter(Boolean).join(" · ")}
        </span>
      </td>
      <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm tabular-nums text-charcoal">{fmtMoney(o.total_amount, o.currency)}</td>
      <td className="px-4 py-3.5">
        <StatusPill value={o.status} />
        {o.status === "pending" && <span className="mt-1 block font-sans text-[11px] text-warm-grey">Not paid yet</span>}
        {state.error && (
          <div className="mt-2">
            <InlineError message={state.error} />
          </div>
        )}
      </td>
      <td className="px-4 py-3.5 text-right">
        <div className="flex flex-wrap justify-end gap-2">
          {o.has_in_store && o.status === "paid" && (
            <ActionButton variant="primary" disabled={state.busy} className="px-3 py-2" onClick={() => act("ready_for_collection")}>
              Ready
            </ActionButton>
          )}
          {o.has_in_store && (o.status === "paid" || o.status === "ready_for_collection") && (
            <ActionButton variant="secondary" disabled={state.busy} className="px-3 py-2" onClick={() => act("collected")}>
              Collected
            </ActionButton>
          )}
          {["pending", "paid", "ready_for_collection"].includes(o.status) && (
            <ActionButton variant="danger" disabled={state.busy} className="px-3 py-2" onClick={() => act("cancelled")}>
              Cancel
            </ActionButton>
          )}
        </div>
      </td>
    </tr>
  );
}

function ProductPrices() {
  const products = useAdminQuery(() =>
    supabase.from("store_products").select("id, name, category, price, is_active").neq("category", "membership").order("category").order("sort_order")
  );

  return (
    <section className="mt-10">
      <SectionHeader title="Tack & café prices" hint="Cold Drink and Water have no price until you set one here — they can't be bought while unpriced." />
      {products.status === "error" && <ErrorBox message={products.error} onRetry={products.reload} />}
      {products.status === "loading" && <Loading>Loading products…</Loading>}
      {products.status === "ready" && (
        <ul className="divide-y divide-charcoal/[0.06] rounded-[14px] border border-charcoal/10 bg-white">
          {(products.data ?? []).map((p) => (
            <PriceRow key={`${p.id}:${p.price}:${p.is_active}`} product={p} onSaved={products.reload} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PriceRow({ product: p, onSaved }) {
  const [price, setPrice] = useState(p.price ?? "");
  const [active, setActive] = useState(p.is_active);
  const [state, setState] = useState({ busy: false, error: null });
  const dirty = String(price) !== String(p.price ?? "") || active !== p.is_active;

  const save = async () => {
    setState({ busy: true, error: null });
    const value = price === "" ? null : Number(price);
    const { error } = await adminApi.setProductPrice(p.id, value, active);
    if (error) {
      setState({ busy: false, error });
      return;
    }
    setState({ busy: false, error: null });
    onSaved();
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
      <div className="min-w-0">
        <p className="font-sans text-sm text-charcoal">{p.name}</p>
        <p className="font-sans text-[11px] text-warm-grey">{titleCase(p.category)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 font-sans text-xs text-warm-grey">
          ₹
          <input
            type="number"
            min="0"
            step="1"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="Not set"
            aria-label={`Price for ${p.name}`}
            className="w-28 rounded-[10px] border border-antique-gold/25 bg-white px-2.5 py-2 font-sans text-sm text-charcoal outline-none focus:border-antique-gold"
          />
        </label>
        <label className="flex items-center gap-1.5 font-sans text-xs text-warm-grey">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Listed
        </label>
        <ActionButton variant={dirty ? "primary" : "secondary"} disabled={!dirty || state.busy} className="px-3 py-2" onClick={save}>
          {state.busy ? "Saving…" : "Save"}
        </ActionButton>
      </div>
      {state.error && (
        <div className="basis-full">
          <InlineError message={state.error} />
        </div>
      )}
    </li>
  );
}
