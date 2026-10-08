import { History } from "lucide-react";
import { Card, SectionHeader, StatusPill, CardSkeleton, ErrorState, EmptyState } from "../ui";
import { formatDate, formatTime } from "../dashboardUtils";

const OUTCOME_LABEL = {
  completed: "Attended",
  absent: "Absent",
  no_show: "No-show",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
};

/** Net credit effect of a booking, summed from its own append-only ledger rows. */
export function creditImpact(booking) {
  const rows = Array.isArray(booking.credit_ledger) ? booking.credit_ledger : booking.credit_ledger ? [booking.credit_ledger] : [];
  if (rows.length === 0) return 0;
  return rows.reduce((sum, r) => sum + (r.amount ?? 0), 0);
}

export default function ClassHistory({ history }) {
  return (
    <Card id="history">
      <SectionHeader title="Class History" hint="Past classes, attendance and credit impact" />
      {history.status === "loading" || history.status === "idle" ? (
        <CardSkeleton lines={3} />
      ) : history.status === "error" ? (
        <ErrorState detail={history.error} onRetry={history.retry} />
      ) : history.items.length === 0 ? (
        <EmptyState icon={History} title="No past classes yet" detail="Completed and changed bookings will appear here." />
      ) : (
        <ul className="divide-y divide-charcoal/5">
          {history.items.map((b) => {
            const s = b.class_sessions;
            const impact = creditImpact(b);
            return (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-3.5 first:pt-0 last:pb-0">
                <div>
                  <p className="font-sans text-sm text-charcoal">{formatDate(s?.session_date)}</p>
                  <p className="mt-0.5 font-sans text-xs text-warm-grey">
                    {formatTime(s?.start_time)} – {formatTime(s?.end_time)}
                    {b.horses?.name ? ` · ${b.horses.name}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <StatusPill value={b.status} label={OUTCOME_LABEL[b.status] ?? undefined} />
                  <span
                    className={`min-w-[3.5rem] text-right font-sans text-sm tabular-nums ${
                      impact > 0 ? "text-racing-green" : impact < 0 ? "text-charcoal" : "text-warm-grey"
                    }`}
                    title="Net credit effect for this class"
                  >
                    {impact > 0 ? `+${impact}` : impact} credit{Math.abs(impact) === 1 ? "" : "s"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
