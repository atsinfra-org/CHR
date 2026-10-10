import { CheckCircle2, ClipboardCheck, CalendarDays, Coins, Crown, Hourglass, PackageCheck, Users } from "lucide-react";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import { ErrorBox, SectionHeader, StatCard, StatGrid } from "../ui";
import { fmtMoney } from "../adminUtils";

/**
 * Phase 5 business KPIs from admin_store_metrics() (one server-side read).
 * Uses StatCard's contract: a real zero renders "0", a failed/absent value
 * renders "—". Nothing here is computed in the browser.
 */
export default function StoreKpis() {
  const q = useAdminQuery(() => adminApi.storeMetrics().then((r) => ({ data: r.data, error: r.error ? { message: r.error } : null })));
  const m = Array.isArray(q.data) ? q.data[0] : q.data;
  const loading = q.status === "loading";
  const v = (key) => (q.status === "ready" && m ? m[key] : null);

  return (
    <section>
      <SectionHeader title="Memberships, Classes & Orders" hint="Live counts from the database" />
      {q.status === "error" ? (
        <ErrorBox message={q.error} onRetry={q.reload} />
      ) : (
        <StatGrid>
          <StatCard icon={Users} label="Members" value={v("members")} loading={loading} />
          <StatCard icon={Crown} label="Active Memberships" value={v("active_memberships")} loading={loading}
            hint={m ? `${m.gold_memberships} Gold · ${m.platinum_memberships} Platinum · ${m.one_time_rides} One-Time` : ""} />
          <StatCard icon={Coins} label="Remaining Credits" value={v("remaining_credits")} loading={loading} hint="Across active memberships" />
          <StatCard icon={CalendarDays} label="Upcoming Sessions" value={v("upcoming_sessions")} loading={loading}
            hint={m ? `${m.upcoming_bookings} bookings` : ""} />
          <StatCard icon={CheckCircle2} label="Classes Completed" value={v("completed_classes")} loading={loading}
            hint={m ? `${m.absent_classes} absent` : ""} />
          <StatCard icon={Hourglass} label="Pending Orders" value={v("pending_orders")} loading={loading} tone="accent" hint="Started but not yet paid" />
          <StatCard icon={ClipboardCheck} label="Paid Orders" value={v("paid_orders")} loading={loading} />
          <StatCard icon={PackageCheck} label="Ready for Collection" value={v("ready_orders")} loading={loading}
            hint={m ? `${m.collected_orders} collected` : ""} />
          <StatCard icon={Coins} label="Order Value" value={m ? fmtMoney(m.order_value) : null} loading={loading} hint="Paid, ready and collected orders" />
        </StatGrid>
      )}
    </section>
  );
}
