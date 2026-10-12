import { MapPin } from "lucide-react";
import { daysBetween, formatDayLong, formatTimeRange, relativeDay, startsIn, todayISODate } from "../dashboardUtils";
import { Skeleton } from "../ui";
import BookingActions from "./BookingActions";

/**
 * The lead panel of the dashboard: the rider's next class, in plain words
 * ("Tomorrow", "7 – 8 am"), with the things they might want to do about it.
 */
export default function NextRide({ upcoming, plan, classesLeft, cancellationReturnsClass, onChanged }) {
  const label = <p className="font-serif text-lg italic text-champagne-gold">Your next ride</p>;

  if (upcoming.status === "loading" || upcoming.status === "idle") {
    return (
      <Panel busy>
        {label}
        <Skeleton className="mt-5 h-12 w-48 bg-warm-ivory/10" />
        <Skeleton className="mt-4 h-5 w-64 bg-warm-ivory/10" />
      </Panel>
    );
  }

  if (upcoming.status === "error") {
    return (
      <Panel wordy>
        {label}
        <p className="mt-4 font-sans text-sm text-warm-ivory/75">We couldn&apos;t load your classes just now.</p>
        <button type="button" onClick={upcoming.retry} className="mt-4 w-fit font-sans text-xs tracking-[0.12em] text-champagne-gold uppercase underline underline-offset-4">
          Try again
        </button>
      </Panel>
    );
  }

  const next = upcoming.bookings[0];

  if (!next) {
    return (
      <Panel wordy>
        {label}
        <h2 className="mt-3 font-serif text-[2.4rem] leading-[1.08] sm:text-[2.9rem]">Nothing booked yet</h2>
        <p className="mt-3 max-w-[18rem] font-sans text-base text-warm-ivory/80">
          {classesLeft > 0
            ? `You have ${classesLeft} class${classesLeft === 1 ? "" : "es"} ready to use. Pick a day and a time.`
            : "You've used every class on this plan. Choose another plan in the store to keep riding."}
        </p>
        <span className="block h-7" aria-hidden="true" />
        <a
          href={classesLeft > 0 ? "/account/book" : "/store"}
          className="mt-auto inline-flex min-h-[44px] w-fit items-center rounded-[10px] bg-warm-ivory px-5 font-sans text-xs tracking-[0.12em] text-racing-green uppercase transition-colors hover:bg-white"
        >
          {classesLeft > 0 ? "Book a class" : "Go to store"}
        </a>
      </Panel>
    );
  }

  const s = next.class_sessions;
  const far = (daysBetween(todayISODate(), s.session_date) ?? 0) >= 7;
  const countdown = startsIn(s.session_date, s.start_time);

  return (
    <Panel>
      {label}
      <h2 className="mt-3 font-serif text-[2.6rem] leading-[1.05] sm:text-[3.2rem]">{far ? formatDayLong(s.session_date) : relativeDay(s.session_date)}</h2>
      <p className="mt-3 font-sans text-lg text-warm-ivory/95">
        {formatTimeRange(s.start_time, s.end_time)}
        {!far && <span className="text-warm-ivory/70"> · {formatDayLong(s.session_date)}</span>}
      </p>
      {countdown && <p className="mt-1 font-sans text-sm text-warm-ivory/65">Starts {countdown}</p>}

      <div className="mt-auto pt-8">
        <BookingActions booking={next} plan={plan} cancellationReturnsClass={cancellationReturnsClass} onChanged={onChanged} tone="dark" showCalendar>
          <a
            href="/#visit"
            className="inline-flex min-h-[40px] items-center gap-2 rounded-[10px] border border-warm-ivory/30 px-3.5 font-sans text-xs tracking-[0.1em] text-warm-ivory uppercase transition-colors duration-200 hover:border-warm-ivory hover:bg-warm-ivory/10"
          >
            <MapPin size={14} strokeWidth={1.75} /> Getting here
          </a>
        </BookingActions>
      </div>
    </Panel>
  );
}

/**
 * The green card with a rider in the arena behind it. The photograph is kept
 * to the right; a green wash holds the left, where the words are, and the
 * foot of the card, where the buttons are, dark enough to read. On a phone
 * the words run the full width, so the wash is heavier there; `wordy` does
 * the same on larger screens for the states that are a sentence, not a time.
 */
function Panel({ children, busy = false, wordy = false }) {
  const wash = wordy
    ? "sm:bg-[linear-gradient(100deg,#0c261c_0%,rgba(12,38,28,0.95)_48%,rgba(12,38,28,0.6)_76%,rgba(12,38,28,0.25)_100%)]"
    : "sm:bg-[linear-gradient(100deg,#0c261c_0%,rgba(12,38,28,0.95)_32%,rgba(12,38,28,0.45)_62%,rgba(12,38,28,0.12)_100%)]";
  return (
    <section
      aria-busy={busy || undefined}
      className="relative isolate flex h-full flex-col overflow-hidden rounded-[22px] border border-[#1d4a37] bg-[#0c261c] p-6 text-warm-ivory shadow-[0_24px_48px_-28px_rgba(8,28,21,0.6)] sm:p-8"
    >
      <img src="/assests/next-ride.webp" alt="" className="absolute inset-0 -z-10 h-full w-full object-cover object-[40%_30%] sm:object-left" />
      <div className={`absolute inset-0 -z-10 bg-[linear-gradient(100deg,rgba(12,38,28,0.97)_0%,rgba(12,38,28,0.9)_55%,rgba(12,38,28,0.7)_100%)] ${wash}`} aria-hidden="true" />
      <div className="absolute inset-x-0 bottom-0 -z-10 h-1/2 bg-gradient-to-t from-[#0c261c]/95 via-[#0c261c]/50 to-transparent" aria-hidden="true" />
      {children}
    </section>
  );
}
