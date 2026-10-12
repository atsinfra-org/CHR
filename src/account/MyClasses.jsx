import { CalendarCheck2 } from "lucide-react";
import AccountStateGuard from "./AccountStateGuard";
import { useMemberDashboard } from "./useMemberDashboard";
import BookingActions from "./dashboard/BookingActions";
import { describeOutcome } from "./dashboard/history";
import { formatDayShort, formatTimeRange, relativeDay, startsIn } from "./dashboardUtils";
import { ActionButton, CardSkeleton, ErrorState, PageHeader } from "./ui";

const TONE = {
  good: { dot: "bg-racing-green", text: "text-racing-green" },
  neutral: { dot: "bg-warm-grey/60", text: "text-charcoal" },
  bad: { dot: "bg-destructive", text: "text-destructive" },
};
const CARD = "rounded-[22px] border border-antique-gold/25 bg-white shadow-[0_1px_2px_rgba(27,27,24,0.04),0_12px_32px_-18px_rgba(8,28,21,0.13)]";

/**
 * Every class the rider has. Left: what is booked, each as a card with its
 * date, time and the same move / calendar / cancel actions as the dashboard.
 * Right: a dark summary of the plan, then the history of classes already
 * ridden. On desktop and laptop screens the spacing scales with the screen
 * height so a typical list fits one screen; a long list simply scrolls.
 */
export default function MyClasses() {
  return <AccountStateGuard active="classes">{({ user }) => <Classes userId={user.id} />}</AccountStateGuard>;
}

/** "13" and "Oct" from a "YYYY-MM-DD" date, for the date tile. */
function dateTile(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return {
    day: d.toLocaleDateString("en-GB", { day: "numeric", timeZone: "UTC" }),
    month: d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
  };
}

function Classes({ userId }) {
  const { membership, upcoming, history, extras, refreshAll } = useMemberDashboard(userId);
  const left = membership.record?.credits_remaining ?? 0;
  const canBook = membership.kind === "active" && left > 0;
  const booked = upcoming.status === "ready" ? upcoming.bookings : null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 md:px-10 md:pt-12 md:pb-4 lg:pt-[clamp(1.5rem,calc(13.8vh-53px),3rem)]">
      <PageHeader
        title="My classes"
        description="Everything you have booked, and the classes you've already ridden."
        className="lg:mb-[clamp(1rem,calc(7.7vh-28px),1.75rem)]"
        actions={
          canBook ? (
            <ActionButton href="/account/book" variant="primary" icon={CalendarCheck2}>
              Book a class
            </ActionButton>
          ) : null
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5 lg:items-start">
        <section className="lg:col-span-3" aria-labelledby="upcoming-title">
          <h2 id="upcoming-title" className="font-serif text-2xl text-charcoal">
            Upcoming{booked ? ` (${booked.length})` : ""}
          </h2>

          {upcoming.status === "loading" || upcoming.status === "idle" ? (
            <div className="mt-4"><CardSkeleton lines={3} /></div>
          ) : upcoming.status === "error" ? (
            <div className="mt-4"><ErrorState title="We couldn't load your booked classes" detail={upcoming.error} onRetry={upcoming.retry} /></div>
          ) : booked.length === 0 ? (
            <div className={`${CARD} mt-4 px-6 py-10 text-center`}>
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-soft-cream text-racing-green">
                <CalendarCheck2 size={20} strokeWidth={1.5} />
              </span>
              <p className="mt-4 font-serif text-xl text-charcoal">Nothing booked yet</p>
              <ActionButton href={canBook ? "/account/book" : "/store"} variant="primary" className="mt-5">
                {canBook ? "Pick a day and a time" : "Choose a plan to start booking"}
              </ActionButton>
            </div>
          ) : (
            <ul className="mt-4 space-y-3 lg:space-y-[clamp(0.5rem,1.6vh,0.75rem)]">
              {booked.map((b, i) => {
                const s = b.class_sessions;
                const tile = dateTile(s.session_date);
                const rel = relativeDay(s.session_date);
                const soon = i === 0 ? startsIn(s.session_date, s.start_time) : null;
                return (
                  <li key={b.id} className={`${CARD} flex flex-wrap items-center gap-x-5 gap-y-3 p-3.5 pr-4 sm:p-4 lg:py-[clamp(0.5rem,1.9vh,1rem)] ${i === 0 ? "border-racing-green/40" : ""}`}>
                    <span className={`flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-[14px] leading-none ${i === 0 ? "bg-racing-green text-warm-ivory" : "bg-soft-cream text-racing-green"}`}>
                      <span className="font-serif text-[1.6rem]">{tile.day}</span>
                      <span className="mt-0.5 font-sans text-[10px] tracking-[0.14em] uppercase">{tile.month}</span>
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-serif text-xl leading-tight text-charcoal">{rel === "Today" || rel === "Tomorrow" ? `${rel}, ${formatDayShort(s.session_date)}` : formatDayShort(s.session_date)}</span>
                      <span className="mt-0.5 block font-sans text-sm text-warm-grey">
                        {formatTimeRange(s.start_time, s.end_time)}
                        {soon ? <span className="text-racing-green"> · starts {soon}</span> : null}
                      </span>
                    </span>
                    <BookingActions booking={b} plan={membership.record} cancellationReturnsClass={extras.cancellationReturnsClass} onChanged={refreshAll} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="space-y-6 lg:col-span-2 lg:space-y-[clamp(0.75rem,2.4vh,1.5rem)]">
          <section className="rounded-[22px] border border-[#1d4a37] bg-[linear-gradient(140deg,#0c261c_0%,#16402f_100%)] p-6 text-warm-ivory shadow-[0_24px_48px_-28px_rgba(8,28,21,0.6)] lg:p-[clamp(1rem,3vh,1.5rem)]">
            <p className="font-serif text-lg italic text-champagne-gold">Your plan</p>
            {membership.kind === "active" ? (
              <>
                <p className="mt-1 font-serif text-[1.6rem] leading-tight">{membership.record?.plan?.name ?? "Membership"}</p>
                <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-warm-ivory/15 pt-4 text-center lg:mt-[clamp(0.6rem,2vh,1rem)] lg:pt-[clamp(0.6rem,2vh,1rem)]">
                  {[
                    ["Left", left],
                    ["Booked", booked ? booked.length : "–"],
                    ["Ridden", extras.ridden ?? "–"],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dd className="font-serif text-[2rem] leading-none">{value}</dd>
                      <dt className="mt-1 font-sans text-[11px] tracking-[0.14em] text-warm-ivory/60 uppercase">{label}</dt>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <p className="mt-2 font-sans text-sm leading-relaxed text-warm-ivory/75">
                You don&apos;t have an active plan.{" "}
                <a href="/store" className="text-champagne-gold underline underline-offset-4">
                  Choose one in the store
                </a>
                .
              </p>
            )}
          </section>

          <section aria-labelledby="history-title">
            <h2 id="history-title" className="font-serif text-2xl text-charcoal">
              Class history
            </h2>
            <div className={`${CARD} mt-4 px-5 py-1 lg:mt-[clamp(0.5rem,1.6vh,1rem)]`}>
              {history.status === "loading" || history.status === "idle" ? (
                <div className="py-4"><CardSkeleton lines={2} /></div>
              ) : history.status === "error" ? (
                <div className="py-4"><ErrorState title="We couldn't load your class history" detail={history.error} onRetry={history.retry} /></div>
              ) : history.items.length === 0 ? (
                <p className="py-5 font-sans text-sm text-warm-grey">Your past classes will appear here after your first ride.</p>
              ) : (
                <ul className="divide-y divide-charcoal/[0.08]">
                  {history.items.map((b) => {
                    const s = b.class_sessions;
                    const outcome = describeOutcome(b);
                    const tone = TONE[outcome.tone] ?? TONE.neutral;
                    return (
                      <li key={b.id} className="py-3 lg:py-[clamp(0.4rem,1.4vh,0.75rem)]">
                        <p className="font-sans text-sm text-charcoal">
                          {formatDayShort(s?.session_date)}
                          <span className="text-warm-grey"> · {formatTimeRange(s?.start_time, s?.end_time)}</span>
                        </p>
                        <p className="mt-0.5 flex items-baseline gap-2 font-sans text-[13px]">
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
        </div>
      </div>
    </div>
  );
}
