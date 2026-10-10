import { formatDayShort, formatTimeRange } from "../dashboardUtils";
import { CardSkeleton, ErrorState } from "../ui";
import { describeOutcome } from "./history";

const TONE = {
  good: { dot: "bg-racing-green", text: "text-racing-green" },
  neutral: { dot: "bg-warm-grey/60", text: "text-charcoal" },
  bad: { dot: "bg-destructive", text: "text-destructive" },
};

/**
 * Past classes, worded for riders: "Attended · used 1 class", "Absent ·
 * class returned to your plan", "Moved". The one history on the dashboard —
 * the notification bell covers everything else.
 */
export default function ClassHistory({ history }) {
  return (
    <section id="history">
      <h2 className="font-serif text-2xl text-charcoal">Class history</h2>

      <div className="mt-4">
        {history.status === "loading" || history.status === "idle" ? (
          <CardSkeleton lines={3} />
        ) : history.status === "error" ? (
          <ErrorState title="We couldn't load your class history" detail={history.error} onRetry={history.retry} />
        ) : history.items.length === 0 ? (
          <p className="border-y border-charcoal/10 py-6 font-sans text-sm text-warm-grey">Your past classes will appear here after your first ride.</p>
        ) : (
          <ul className="divide-y divide-charcoal/10 border-y border-charcoal/10">
            {history.items.map((b) => {
              const s = b.class_sessions;
              const outcome = describeOutcome(b);
              const tone = TONE[outcome.tone] ?? TONE.neutral;
              return (
                <li key={b.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3.5">
                  <p className="font-sans text-sm text-charcoal">
                    {formatDayShort(s?.session_date)}
                    <span className="text-warm-grey"> · {formatTimeRange(s?.start_time, s?.end_time)}</span>
                  </p>
                  <p className="flex items-baseline gap-2 font-sans text-sm">
                    <span className={`inline-flex items-center gap-1.5 font-medium ${tone.text}`}>
                      <span className={`h-1.5 w-1.5 shrink-0 self-center rounded-full ${tone.dot}`} aria-hidden="true" />
                      {outcome.label}
                    </span>
                    {outcome.note && <span className="text-warm-grey">· {outcome.note}</span>}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
