import { formatDayShort, formatTimeRange, relativeDay } from "../dashboardUtils";
import BookingActions from "./BookingActions";

/**
 * A list of booked classes: day, time, and what can be done with each.
 * Moving is the visible action; cancel lives in the menu. A quiet list
 * rather than another card.
 *
 * The dashboard uses it for the classes after the next one (which leads the
 * page in NextRide) with a `limit`, and links to the full list; the My
 * classes page shows them all under its own `title`.
 */
export default function UpcomingClasses({ bookings, plan, cancellationReturnsClass, onChanged, title = "Also booked", limit = null, moreHref = null }) {
  if (!bookings.length) return null;
  const shown = limit ? bookings.slice(0, limit) : bookings;
  const hidden = bookings.length - shown.length;

  return (
    <section id="classes">
      <h2 className="font-serif text-2xl text-charcoal">{title}</h2>
      <ul className="mt-4 divide-y divide-charcoal/10 border-y border-charcoal/10">
        {shown.map((booking) => {
          const s = booking.class_sessions;
          const rel = relativeDay(s.session_date);
          const day = formatDayShort(s.session_date);
          return (
            <li key={booking.id} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4">
              <div>
                {/* "Tomorrow, Sun 11 Oct" — but never "Tuesday, Tue 13 Oct" */}
                <p className="font-serif text-xl text-charcoal">{rel === "Today" || rel === "Tomorrow" ? `${rel}, ${day}` : day}</p>
                <p className="mt-0.5 font-sans text-sm text-warm-grey">{formatTimeRange(s.start_time, s.end_time)}</p>
              </div>
              <BookingActions booking={booking} plan={plan} cancellationReturnsClass={cancellationReturnsClass} onChanged={onChanged} />
            </li>
          );
        })}
      </ul>
      {hidden > 0 && moreHref && (
        <a href={moreHref} className="mt-3 inline-block font-sans text-sm text-racing-green underline underline-offset-4">
          See all your classes ({hidden} more)
        </a>
      )}
    </section>
  );
}
