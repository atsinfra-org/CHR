import { useMemo, useState } from "react";
import { RefreshCw, IndianRupee, CheckCircle2, Clock, XCircle } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import {
  ActionButton,
  StatusPill,
  Empty,
  ErrorBox,
  Loading,
  PageHeader,
  SelectField,
  StatCard,
  StatGrid,
  TableShell,
  Toolbar,
} from "../ui";
import { fmtDateTime, fmtMoney, titleCase } from "../adminUtils";

const PAGE_SIZE = 500;

const STATUS_FILTERS = [
  "all",
  "created",
  "pending",
  "processing",
  "success",
  "failed",
  "expired",
  "refunded",
  "partially_refunded",
];

/**
 * Financial workspace (§39). Read-only: payment state is owned entirely by
 * the Razorpay Edge Functions / process_payment_webhook() (Phase 4.4), which
 * this redesign does not touch.
 *
 * Revenue deliberately comes from admin_dashboard_metrics().revenue_total —
 * the application's own definition (status='success' AND currency='INR') —
 * rather than re-summing the rows loaded here. Summing locally would produce
 * a second, divergent revenue figure for the same business concept, and it
 * would silently describe only the most recent PAGE_SIZE payments.
 */
export default function AdminPayments() {
  const payments = useAdminQuery(() =>
    supabase
      .from("payments")
      .select("*, member:profiles!payments_user_id_fkey(full_name, email)")
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE)
  );
  const metrics = useAdminQuery(() => adminApi.dashboardMetrics());

  const [filter, setFilter] = useState("all");

  const all = useMemo(() => payments.data ?? [], [payments.data]);
  const rows = useMemo(() => (filter === "all" ? all : all.filter((p) => p.status === filter)), [all, filter]);

  // These describe the loaded page, not the whole table — the labels below
  // say "loaded" wherever that distinction could mislead (§62).
  const capped = all.length >= PAGE_SIZE;
  const countBy = (s) => all.filter((p) => p.status === s).length;

  const m = Array.isArray(metrics.data) ? metrics.data[0] : metrics.data;
  const metricsLoading = metrics.status === "loading";
  // null (not 0) when the figure can't be established, so StatCard renders
  // "—" rather than claiming a real zero (§20).
  const revenue = metrics.status === "ready" && m ? Number(m.revenue_total) : null;
  const pendingPayments = metrics.status === "ready" && m ? m.pending_payments : null;

  const loading = payments.status === "loading";

  return (
    <div>
      <PageHeader
        route="payments"
        actions={
          <ActionButton icon={RefreshCw} onClick={() => { payments.reload(); metrics.reload(); }}>
            Refresh
          </ActionButton>
        }
      />

      <p className="mb-5 rounded-[12px] border border-antique-gold/30 bg-antique-gold/[0.07] px-4 py-3 font-sans text-sm text-charcoal">
        This page is a read-only record. To confirm a customer's manual or cash payment, open{" "}
        <a href="#orders" className="font-medium text-racing-green underline underline-offset-4">Orders</a> and use <strong className="font-medium">Mark paid</strong>.
      </p>

      <StatGrid className="mb-7">
        <StatCard
          icon={IndianRupee}
          label="Revenue"
          value={revenue === null ? null : fmtMoney(revenue, "INR")}
          hint="Successful payments, all time"
          loading={metricsLoading}
          tone="accent"
        />
        <StatCard
          icon={CheckCircle2}
          label="Successful"
          value={loading ? null : countBy("success")}
          hint={capped ? `of ${PAGE_SIZE} loaded` : "all payments"}
          loading={loading}
        />
        <StatCard
          icon={Clock}
          label="Awaiting Payment"
          value={pendingPayments}
          hint="Created, pending or processing"
          loading={metricsLoading}
        />
        <StatCard
          icon={XCircle}
          label="Failed"
          value={loading ? null : countBy("failed")}
          hint={capped ? `of ${PAGE_SIZE} loaded` : "all payments"}
          loading={loading}
        />
      </StatGrid>

      <Toolbar>
        <SelectField
          label="Status"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-full sm:w-52"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All statuses" : titleCase(s)}
            </option>
          ))}
        </SelectField>
        <p className="font-sans text-xs text-warm-grey">
          {payments.status === "ready"
            ? `${rows.length} shown${capped ? ` · most recent ${PAGE_SIZE}` : ""}`
            : ""}
        </p>
      </Toolbar>

      {payments.status === "error" && <ErrorBox message={payments.error} onRetry={payments.reload} />}
      {loading && <Loading>Loading payments…</Loading>}
      {payments.status === "ready" &&
        (rows.length === 0 ? (
          <Empty
            icon={IndianRupee}
            detail={
              filter === "all"
                ? "Successful payment transactions will appear here once members purchase a membership."
                : "Try a different status filter."
            }
          >
            {filter === "all" ? "No payments recorded" : `No ${titleCase(filter)} payments`}
          </Empty>
        ) : (
          <TableShell
            head={["When", "Member", "Gateway", "Amount", "Status", "Paid At", "Reference"]}
            minWidth="900px"
          >
            {rows.map((p) => (
              <tr key={p.id} className="border-b border-charcoal/[0.06] last:border-0 hover:bg-soft-cream/40">
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">
                  {fmtDateTime(p.created_at)}
                </td>
                <td className="px-4 py-3.5 font-sans text-sm text-charcoal">
                  {p.member?.full_name || p.member?.email || "—"}
                </td>
                <td className="px-4 py-3.5 font-sans text-sm text-warm-grey">{titleCase(p.gateway)}</td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm font-medium text-charcoal">
                  {fmtMoney(p.amount, p.currency)}
                </td>
                <td className="px-4 py-3.5">
                  <StatusPill value={p.status} />
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">
                  {fmtDateTime(p.paid_at)}
                </td>
                <td className="px-4 py-3.5 font-mono text-[11px] text-warm-grey/80">
                  {p.gateway_order_id || "—"}
                  {p.gateway_payment_id ? ` / ${p.gateway_payment_id}` : ""}
                </td>
              </tr>
            ))}
          </TableShell>
        ))}
    </div>
  );
}
