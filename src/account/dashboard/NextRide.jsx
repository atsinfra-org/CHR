import { MapPin } from "lucide-react";
import { daysBetween, formatDayLong, formatTimeRange, relativeDay, startsIn, todayISODate } from "../dashboardUtils";
import { Skeleton } from "../ui";
import BookingActions from "./BookingActions";

/**
 * The lead panel of the dashboard: the rider's next class, in plain words
 * ("Tomorrow", "7 – 8 am"), with the things they might want to do about it.
 */
export default function NextRide({ upcoming, plan, classesLeft, cancellationReturnsClass, onChanged }) {
  const shell = "relative flex h-full flex-col overflow-hidden rounded-[22px] border border-[#1d4a37] bg-[linear-gradient(140deg,#0c261c_0%,#16402f_100%)] p-6 text-warm-ivory sm:p-8";
  const label = <p className="font-serif text-lg italic text-champagne-gold">Your next ride</p>;

  if (upcoming.status === "loading" || upcoming.status === "idle") {
    return (
      <section className={shell} aria-busy="true">
        {label}
        <Skeleton className="mt-5 h-12 w-48 bg-warm-ivory/10" />
        <Skeleton className="mt-4 h-5 w-64 bg-warm-ivory/10" />
      </section>
    );
  }

  if (upcoming.status === "error") {
    return (
      <section className={shell}>
        {label}
        <p className="mt-4 font-sans text-sm text-warm-ivory/75">We couldn&apos;t load your classes just now.</p>
        <button type="button" onClick={upcoming.retry} className="mt-4 font-sans text-xs tracking-[0.12em] text-champagne-gold uppercase underline underline-offset-4">
          Try again
        </button>
      </section>
    );
  }

  const next = upcoming.bookings[0];

  if (!next) {
    return (
      <section className={shell}>
        {label}
        <h2 className="mt-3 font-serif text-[2.4rem] leading-[1.08] sm:text-[2.9rem]">Nothing booked yet</h2>
        <p className="mt-3 max-w-md font-sans text-base text-warm-ivory/75">
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
      </section>
    );
  }

  const s = next.class_sessions;
  const far = (daysBetween(todayISODate(), s.session_date) ?? 0) >= 7;
  const countdown = startsIn(s.session_date, s.start_time);

  return (
    <section className={shell}>
      {label}
      <h2 className="mt-3 font-serif text-[2.6rem] leading-[1.05] sm:text-[3.2rem]">{far ? formatDayLong(s.session_date) : relativeDay(s.session_date)}</h2>
      <p className="mt-3 font-sans text-lg text-warm-ivory/90">
        {formatTimeRange(s.start_time, s.end_time)}
        {!far && <span className="text-warm-ivory/60"> · {formatDayLong(s.session_date)}</span>}
      </p>
      {countdown && <p className="mt-1 font-sans text-sm text-warm-ivory/55">Starts {countdown}</p>}

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
    </section>
  );
}
