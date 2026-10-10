import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatDayLong, formatTimeRange, todayISODate } from "../dashboardUtils";
import { CardSkeleton, ErrorState } from "../ui";
import {
  addMonths,
  fetchDaySessions,
  fetchMyBookedDays,
  fetchRidingDays,
  groupByPartOfDay,
  monthInRange,
  monthMatrix,
  monthOf,
  placesText,
  slotState,
} from "./availability";

const POLL_MS = 10000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Pick a day on a month calendar, then a time. Shared by "Book a class" and
 * "Reschedule".
 *
 * Riders book a place in a class, so the calendar only ever shows how many
 * places are left. Availability is read from the server and refreshed every
 * 10 seconds; book_class() / reschedule_booking() still decide atomically
 * (a lost race comes back as an error and the caller bumps `reloadKey`).
 *
 * `onSelect({ sessionId, session })`, or `onSelect(null)` when the day changes.
 */
export default function ClassCalendar({ min, max, selected, onSelect, reloadKey = 0, currentSessionId = null }) {
  const today = todayISODate();
  const [ridingDays, setRidingDays] = useState(undefined); // undefined = loading · null = unknown · Set of ISO dates
  const [bookedDays, setBookedDays] = useState(() => new Set());
  const [date, setDate] = useState(null);
  const [view, setView] = useState(() => monthOf(min || today));
  const [day, setDay] = useState({ status: "idle", error: null, sessions: [] });
  const requestId = useRef(0);

  // Which days can be picked, and which already hold one of the rider's classes.
  useEffect(() => {
    if (!min || !max) return undefined;
    let active = true;
    Promise.all([fetchRidingDays(min, max), fetchMyBookedDays(min, max)]).then(([riding, booked]) => {
      if (!active) return;
      setRidingDays(riding);
      setBookedDays(booked);
      setDate((current) => {
        if (current) return current;
        const first = firstRidingDay(riding, min, max);
        setView(monthOf(first));
        return first;
      });
    });
    return () => {
      active = false;
    };
  }, [min, max, reloadKey]);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!date) return;
      const id = ++requestId.current;
      if (!silent) setDay((s) => ({ ...s, status: "loading", error: null }));
      const { sessions, error } = await fetchDaySessions(date);
      if (id !== requestId.current) return; // a newer request superseded this one
      if (error) {
        if (!silent) setDay({ status: "error", error: error.message, sessions: [] });
        return;
      }
      setDay({ status: "ready", error: null, sessions });
    },
    [date]
  );

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") load({ silent: true });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load, reloadKey]);

  const isSelectable = useCallback(
    (iso) => iso >= min && iso <= max && (ridingDays == null || ridingDays.has(iso)),
    [min, max, ridingDays]
  );

  const pickDate = (iso) => {
    if (iso === date) return;
    onSelect(null);
    setDate(iso);
  };

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-10">
      <MonthCalendar
        view={view}
        setView={setView}
        min={min}
        max={max}
        today={today}
        date={date}
        bookedDays={bookedDays}
        isSelectable={isSelectable}
        onPick={pickDate}
      />
      <DayPanel
        date={date}
        day={day}
        selected={selected}
        onSelect={onSelect}
        currentSessionId={currentSessionId}
        onRetry={() => load()}
      />
    </div>
  );
}

function firstRidingDay(riding, min, max) {
  if (riding && riding.size) {
    const first = [...riding].filter((d) => d >= min && d <= max).sort()[0];
    if (first) return first;
  }
  return min;
}

/* ------------------------------------------------------------ month grid */

function MonthCalendar({ view, setView, min, max, today, date, bookedDays, isSelectable, onPick }) {
  const weeks = useMemo(() => monthMatrix(view.year, view.monthIndex), [view]);
  const label = new Date(Date.UTC(view.year, view.monthIndex, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const prev = addMonths(view, -1);
  const next = addMonths(view, 1);
  const canPrev = monthInRange(prev, min, max);
  const canNext = monthInRange(next, min, max);

  const navButton =
    "flex h-9 w-9 items-center justify-center rounded-full border border-antique-gold/30 text-charcoal transition-colors hover:border-antique-gold hover:bg-soft-cream/60 disabled:pointer-events-none disabled:opacity-30";

  return (
    <div className="h-fit rounded-[18px] border border-antique-gold/20 bg-white p-5 shadow-[0_1px_2px_rgba(27,27,24,0.04),0_12px_32px_-18px_rgba(8,28,21,0.13)] sm:p-6">
      <div className="flex items-center justify-between">
        <button type="button" aria-label="Previous month" disabled={!canPrev} onClick={() => setView(prev)} className={navButton}>
          <ChevronLeft size={16} strokeWidth={1.75} />
        </button>
        <p className="font-serif text-xl text-charcoal" aria-live="polite">
          {label}
        </p>
        <button type="button" aria-label="Next month" disabled={!canNext} onClick={() => setView(next)} className={navButton}>
          <ChevronRight size={16} strokeWidth={1.75} />
        </button>
      </div>

      <div className="mt-5 grid grid-cols-7 gap-y-1 text-center">
        {WEEKDAYS.map((d) => (
          <span key={d} className="pb-2 font-sans text-[11px] text-warm-grey">
            {d}
          </span>
        ))}
        {weeks.flat().map((iso, i) => {
          if (!iso) return <span key={`pad-${i}`} aria-hidden="true" />;
          const selectable = isSelectable(iso);
          const isSelected = iso === date;
          const booked = bookedDays.has(iso);
          const isToday = iso === today;
          return (
            <button
              key={iso}
              type="button"
              disabled={!selectable}
              aria-pressed={isSelected}
              aria-label={`${formatDayLong(iso)}${booked ? ", you have a class" : ""}${selectable ? "" : ", not available"}`}
              onClick={() => onPick(iso)}
              className={`relative mx-auto flex h-10 w-10 items-center justify-center rounded-full font-sans text-sm tabular-nums transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-antique-gold ${
                isSelected
                  ? "bg-racing-green font-medium text-warm-ivory"
                  : selectable
                    ? "text-charcoal hover:bg-soft-cream"
                    : "cursor-not-allowed text-charcoal/25"
              } ${isToday && !isSelected ? "ring-1 ring-antique-gold" : ""}`}
            >
              {Number(iso.slice(8))}
              {booked && (
                <span
                  aria-hidden="true"
                  className={`absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full ${isSelected ? "bg-champagne-gold" : "bg-antique-gold"}`}
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-charcoal/[0.07] pt-4 font-sans text-[11px] text-warm-grey">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-antique-gold" aria-hidden="true" /> Your class
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full ring-1 ring-antique-gold" aria-hidden="true" /> Today
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-charcoal/30" aria-hidden="true">
            12
          </span>
          No riding
        </span>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- time slots */

function DayPanel({ date, day, selected, onSelect, currentSessionId, onRetry }) {
  if (!date) {
    return (
      <div>
        <CardSkeleton lines={3} />
      </div>
    );
  }

  const groups = groupByPartOfDay(day.sessions);

  return (
    <div>
      <h2 className="font-serif text-[1.7rem] leading-tight text-charcoal">{formatDayLong(date)}</h2>
      <p className="mt-1 font-sans text-sm text-warm-grey">Choose a time. Each class is one hour.</p>

      <div className="mt-6">
        {day.status === "loading" || day.status === "idle" ? (
          <CardSkeleton lines={3} />
        ) : day.status === "error" ? (
          <ErrorState title="Couldn't load the times for this day" detail={day.error} onRetry={onRetry} />
        ) : day.sessions.length === 0 ? (
          <p className="rounded-[14px] border border-dashed border-antique-gold/30 bg-soft-cream/40 px-5 py-8 text-center font-sans text-sm text-warm-grey">
            There are no classes on this day. We ride Tuesday to Sunday.
          </p>
        ) : (
          <div className="space-y-6">
            {groups.map(([label, sessions]) => (
              <div key={label}>
                <p className="font-serif text-lg italic text-[#8a6a33]">{label}</p>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {sessions.map((s) => (
                    <SlotButton key={s.id} session={s} isSelected={selected?.sessionId === s.id} onSelect={onSelect} currentSessionId={currentSessionId} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="mt-6 font-sans text-xs leading-relaxed text-warm-grey">Your coach will assign your horse at the ground.</p>
    </div>
  );
}

function SlotButton({ session: s, isSelected, onSelect, currentSessionId }) {
  const state = slotState(s, currentSessionId);
  const open = state === "open";
  const label = {
    open: placesText(s),
    full: "Full",
    mine: "You're booked",
    current: "Your current time",
    closed: s.status === "cancelled" ? "Cancelled" : "Not available",
  }[state];

  const tone = isSelected
    ? "border-racing-green bg-racing-green text-warm-ivory shadow-[0_16px_32px_-20px_rgba(18,55,42,0.7)]"
    : open
      ? "border-antique-gold/30 bg-white text-charcoal hover:-translate-y-0.5 hover:border-antique-gold hover:shadow-[0_16px_32px_-22px_rgba(8,28,21,0.4)]"
      : state === "mine" || state === "current"
        ? "cursor-not-allowed border-racing-green/25 bg-racing-green/[0.06] text-racing-green"
        : "cursor-not-allowed border-charcoal/[0.08] bg-soft-cream/50 text-warm-grey";

  return (
    <button
      type="button"
      disabled={!open}
      aria-pressed={isSelected}
      aria-label={`${formatTimeRange(s.start_time, s.end_time)}, ${label}`}
      onClick={() => onSelect({ sessionId: s.id, session: s })}
      className={`flex flex-col rounded-[14px] border p-4 text-left transition-all duration-200 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-antique-gold ${tone}`}
    >
      <span className="font-serif text-[1.4rem] leading-none">{formatTimeRange(s.start_time, s.end_time)}</span>
      <span className="mt-4 flex items-center justify-between gap-3">
        <Places capacity={s.capacity} left={s.places_left} inverted={isSelected} />
        <span className="font-sans text-xs">{isSelected ? "Selected" : label}</span>
      </span>
    </button>
  );
}

/** One mark per place in the session: filled = taken, hollow = free. No names. */
function Places({ capacity, left, inverted }) {
  const total = Math.min(Math.max(capacity ?? 0, 0), 8);
  const taken = Math.max(total - Math.max(left ?? 0, 0), 0);
  return (
    <span className="flex items-center gap-1.5" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`h-2 w-2 rounded-full border ${
            i < taken
              ? inverted
                ? "border-warm-ivory/60 bg-warm-ivory/60"
                : "border-current bg-current opacity-45"
              : inverted
                ? "border-warm-ivory/70"
                : "border-current opacity-45"
          }`}
        />
      ))}
    </span>
  );
}
