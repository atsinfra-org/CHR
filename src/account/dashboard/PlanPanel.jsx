import { daysBetween, formatDayShort, todayISODate } from "../dashboardUtils";
import { CardSkeleton, ErrorState } from "../ui";

/**
 * The rider's plan in one place: classes left (once, not three times), how
 * long it runs, the weekly limit, reschedules, and how many classes they
 * have ridden so far. Every number comes from the database; this only words
 * it. The "ending soon" nudge is a reminder, not a rule.
 */
export default function PlanPanel({ membership, weekly, ridden }) {
  const shell = "h-full rounded-[22px] border border-antique-gold/25 bg-white p-6 sm:p-7";

  if (membership.status === "loading" || membership.status === "idle") {
    return (
      <section className={shell} aria-busy="true">
        <CardSkeleton lines={4} />
      </section>
    );
  }
  if (membership.status === "error") {
    return (
      <section className={shell}>
        <ErrorState title="We couldn't load your plan" detail={membership.error} onRetry={membership.retry} />
      </section>
    );
  }

  const m = membership.record;
  const total = m.total_credits ?? membership.plan?.class_credits ?? null;
  const left = m.credits_remaining;
  const used = total != null ? Math.max(total - left, 0) : null;
  const daysLeft = daysBetween(todayISODate(), m.end_date);
  const allowed = m.reschedules_allowed ?? 0;
  const moved = m.reschedules_used ?? 0;
  const w = weekly.status === "ready" ? weekly.data : null;

  return (
    <section className={shell} id="membership">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-xl text-charcoal">{membership.plan?.name ?? "Your plan"}</h2>
        <span className="flex items-center gap-1.5 font-sans text-xs text-racing-green">
          <span className="h-1.5 w-1.5 rounded-full bg-racing-green" aria-hidden="true" /> Active
        </span>
      </div>

      <p className="mt-5 flex items-baseline gap-2.5">
        <span className="font-serif text-[3.4rem] leading-none text-racing-green">{left}</span>
        <span className="font-sans text-sm text-warm-grey">
          {total != null ? `of ${total} ` : ""}class{left === 1 && total == null ? "" : "es"} left
        </span>
      </p>

      {total != null && total > 0 && (
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-soft-cream" role="img" aria-label={`${used} of ${total} classes used`}>
          <div className="h-full rounded-full bg-racing-green transition-[width] duration-500" style={{ width: `${Math.min(100, Math.round((used / total) * 100))}%` }} />
        </div>
      )}

      <dl className="mt-6 divide-y divide-charcoal/[0.07] border-t border-charcoal/[0.07] font-sans text-sm">
        <Row label="Valid until">
          {formatDayShort(m.end_date)}
          {daysLeft != null && <span className="text-warm-grey"> · {daysLeft <= 0 ? "ends today" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}</span>}
        </Row>
        {w && (
          <Row label="Weekly limit">
            {w.used} of {w.max} booked
            <span className="text-warm-grey"> · resets after {formatDayShort(w.blockEnd)}</span>
          </Row>
        )}
        <Row label="Reschedules">
          {moved} of {allowed} used
        </Row>
        {ridden != null && <Row label="Classes ridden so far">{ridden}</Row>}
      </dl>

      {left === 0 ? (
        <p className="mt-5 font-sans text-sm leading-relaxed text-warm-grey">
          You&apos;ve used every class on this plan.{" "}
          <a href="/store" className="text-racing-green underline underline-offset-4">
            Choose another plan
          </a>{" "}
          to keep riding.
        </p>
      ) : (
        daysLeft != null &&
        daysLeft <= 7 && (
          <p className="mt-5 rounded-[10px] bg-warning/[0.08] px-3.5 py-2.5 font-sans text-sm leading-relaxed text-warning">
            {daysLeft <= 0 ? "Your plan ends today" : `Your plan ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`} with {left} class{left === 1 ? "" : "es"} still to
            use. Book {left === 1 ? "it" : "them"} soon.
          </p>
        )
      )}
    </section>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3">
      <dt className="text-warm-grey">{label}</dt>
      <dd className="text-right text-charcoal">{children}</dd>
    </div>
  );
}
