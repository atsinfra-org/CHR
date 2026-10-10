import { formatDayShort, formatTimeRange, relativeDay } from "../dashboardUtils";
import BookingActions from "./BookingActions";

/**
 * The rider's other booked classes (the next one leads the page in
 * NextRide). A quiet list rather than another card: day, time, and what can
 * be done with it. Moving is the visible action; cancel lives in the menu.
 */
export default function UpcomingClasses({ bookings, plan, cancellationReturnsClass, onChanged }) {
  if (!bookings.length) return null;

  return (
    <section id="classes">
      <h2 className="font-serif text-2xl text-charcoal">Also booked</h2>
      <ul className="mt-4 divide-y divide-charcoal/10 border-y border-charcoal/10">
        {bookings.map((booking) => {
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
    </section>
  );
}
