import { Card, SectionHeader, ProgressBar, CardSkeleton, ErrorState } from "../ui";
import { formatDateShort } from "../dashboardUtils";

/**
 * Displays the current membership block's usage. The block boundaries and
 * count are fetched — not computed — from
 * public.member_current_block_usage() (see useMemberDashboard.js), the same
 * database function book_class() shares its constants with. This component
 * only formats those values (percentage, date strings) — it does no block/
 * eligibility math of its own, and never implies a booking would be
 * allowed; book_class() is still what decides that.
 *
 * Only rendered for an active membership — no block exists without one.
 */
export default function WeeklyProgress({ weekly }) {
  if (weekly.status === "loading" || weekly.status === "idle") {
    return (
      <Card>
        <SectionHeader title="This Week" />
        <CardSkeleton lines={1} />
      </Card>
    );
  }

  if (weekly.status === "error") {
    return (
      <Card>
        <SectionHeader title="This Week" />
        <ErrorState detail={weekly.error} onRetry={weekly.retry} />
      </Card>
    );
  }

  if (!weekly.data) return null;

  const { used, max, remaining, blockStart, blockEnd } = weekly.data;
  const tone = max > 0 && used >= max ? "warning" : "success";

  return (
    <Card>
      <SectionHeader title="This Week" hint={`${formatDateShort(blockStart)} – ${formatDateShort(blockEnd)}`} />

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-sans text-sm text-charcoal">
          {used} / {max} classes booked
        </p>
      </div>

      <ProgressBar value={used} max={max} tone={tone} className="mt-3" />

      <p className="mt-3 font-sans text-xs text-warm-grey">
        {remaining > 0
          ? `${remaining} class${remaining === 1 ? "" : "es"} remaining this week`
          : "You've used all classes for this week's block"}
      </p>
    </Card>
  );
}
