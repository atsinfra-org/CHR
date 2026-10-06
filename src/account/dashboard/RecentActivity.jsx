import { CalendarPlus, CalendarX2, RotateCcw, Sparkles, SlidersHorizontal, TimerOff } from "lucide-react";
import { Card, SectionHeader, CardSkeleton, ErrorState, EmptyState } from "../ui";
import { relativeTime } from "../dashboardUtils";

// public.credit_ledger.transaction_type is the only source used here — no
// activity is invented; anything not in this table simply isn't shown.
const ACTIVITY = {
  membership_purchase: { icon: Sparkles, label: "Membership activated" },
  booking: { icon: CalendarPlus, label: "Class booked" },
  cancellation: { icon: CalendarX2, label: "Class cancelled" },
  admin_adjustment: { icon: SlidersHorizontal, label: "Credit adjustment" },
  refund: { icon: RotateCcw, label: "Refund issued" },
  expiry: { icon: TimerOff, label: "Credits expired" },
};

/**
 * Recent member activity, sourced entirely from public.credit_ledger (own
 * rows, via "Members read own credit ledger" RLS). Deliberately the only
 * source — the one table that gives a clean, real activity feed without
 * new infrastructure.
 */
export default function RecentActivity({ activity }) {
  return (
    <Card>
      <SectionHeader title="Recent Activity" />

      {activity.status === "loading" || activity.status === "idle" ? (
        <CardSkeleton lines={3} />
      ) : activity.status === "error" ? (
        <ErrorState detail={activity.error} onRetry={activity.retry} />
      ) : activity.items.length === 0 ? (
        <EmptyState icon={Sparkles} title="No recent activity" detail="Your bookings and membership updates will show up here." />
      ) : (
        <ul className="divide-y divide-charcoal/5">
          {activity.items.map((entry) => {
            const meta = ACTIVITY[entry.transaction_type] ?? { icon: Sparkles, label: entry.transaction_type };
            const Icon = meta.icon;
            const sign = entry.amount > 0 ? "+" : "";
            return (
              <li key={entry.id} className="flex items-center justify-between gap-3 py-3.5 first:pt-0 last:pb-0">
                <div className="flex items-center gap-3">
                  <Icon size={15} strokeWidth={1.75} className="shrink-0 text-antique-gold" />
                  <div>
                    <p className="font-sans text-sm text-charcoal">{entry.description || meta.label}</p>
                    <p className="mt-0.5 font-sans text-xs text-warm-grey">{relativeTime(entry.created_at)}</p>
                  </div>
                </div>
                <span className={`font-sans text-sm ${entry.amount > 0 ? "text-racing-green" : "text-warm-grey"}`}>
                  {sign}
                  {entry.amount} credit{Math.abs(entry.amount) === 1 ? "" : "s"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
