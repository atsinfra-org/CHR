import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { formatTime, todayISODate } from "../dashboardUtils";
import { CardSkeleton, ErrorState, EmptyState } from "../ui";

const POLL_MS = 10000;

/**
 * Date → session → horse chooser, shared by "Book a Class" and
 * "Reschedule". Availability comes from session_horse_availability() — a
 * server read that returns one row per session × horse with a state of
 * available / booked / mine / unavailable. This component never decides
 * whether a slot is bookable: it renders what the server says, polls every
 * 10s so horses taken by other riders grey out, and the book_class() /
 * reschedule_booking() call still re-checks atomically (a lost race returns
 * SLOT_NO_LONGER_AVAILABLE and the caller reloads via `reloadKey`).
 *
 * `onSelect({ sessionId, horseId, horseName, session })`
 */
export default function SlotPicker({ min, max, selected, onSelect, reloadKey = 0, excludeBookingSessionId = null }) {
  const [date, setDate] = useState(min || todayISODate());
  const [state, setState] = useState({ status: "idle", error: null, sessions: [] });
  const requestId = useRef(0);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      const id = ++requestId.current;
      if (!silent) setState((s) => ({ ...s, status: "loading", error: null }));
      const { data, error } = await supabase.rpc("session_horse_availability", { p_date: date });
      if (id !== requestId.current) return; // a newer request superseded this one
      if (error) {
        if (!silent) setState({ status: "error", error: error.message, sessions: [] });
        return;
      }
      setState({ status: "ready", error: null, sessions: groupSessions(data ?? []) });
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

  return (
    <div>
      <DateStrip date={date} min={min} max={max} onChange={setDate} />

      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <p className="font-sans text-[11px] tracking-[0.18em] text-warm-grey uppercase">Sessions &amp; horses</p>
          <button
            type="button"
            onClick={() => load()}
            className="flex items-center gap-1.5 font-sans text-[11px] tracking-[0.12em] text-warm-grey uppercase transition-colors hover:text-charcoal"
          >
            <RefreshCw size={12} strokeWidth={1.75} /> Refresh
          </button>
        </div>

        {state.status === "loading" || state.status === "idle" ? (
          <CardSkeleton lines={3} />
        ) : state.status === "error" ? (
          <ErrorState title="Couldn't load sessions" detail={state.error} onRetry={() => load()} />
        ) : state.sessions.length === 0 ? (
          <EmptyState title="No sessions on this day" detail="We ride Tuesday to Sunday. Try another date." />
        ) : (
          <ul className="space-y-3">
            {state.sessions.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                selected={selected}
                onSelect={onSelect}
                isCurrent={excludeBookingSessionId === s.id}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SessionRow({ session: s, selected, onSelect, isCurrent }) {
  const full = s.available_count <= 0;
  const closed = !s.is_bookable;
  const disabledAll = full || closed;

  let badge = `${s.available_count} of ${s.capacity} horses free`;
  let badgeTone = "text-racing-green";
  if (s.status !== "open") {
    badge = s.status === "cancelled" ? "Cancelled" : "Closed";
    badgeTone = "text-warm-grey";
  } else if (closed) {
    badge = "Not bookable";
    badgeTone = "text-warm-grey";
  } else if (full) {
    badge = "Full";
    badgeTone = "text-destructive";
  }

  return (
    <li className={`rounded-[12px] border bg-white p-4 ${disabledAll ? "border-charcoal/8 opacity-70" : "border-charcoal/12"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-serif text-lg text-charcoal">
          {formatTime(s.start_time)} – {formatTime(s.end_time)}
        </p>
        <span className={`font-sans text-xs font-medium ${badgeTone}`}>{badge}</span>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {s.horses.map((h) => {
          const isSel = selected?.sessionId === s.id && selected?.horseId === h.horse_id;
          const available = h.horse_state === "available" && !disabledAll;
          const label =
            h.horse_state === "mine" ? "Your booking" : h.horse_state === "booked" ? "Booked" : h.horse_state === "unavailable" ? "Unavailable" : full ? "—" : "Available";
          return (
            <button
              key={h.horse_id}
              type="button"
              disabled={!available}
              aria-pressed={isSel}
              onClick={() =>
                onSelect({ sessionId: s.id, horseId: h.horse_id, horseName: h.horse_name, session: s })
              }
              className={`flex items-center justify-between rounded-[10px] border px-3.5 py-2.5 text-left font-sans text-sm transition-colors disabled:cursor-not-allowed ${
                isSel
                  ? "border-racing-green bg-racing-green text-warm-ivory"
                  : available
                    ? "border-charcoal/15 bg-white text-charcoal hover:border-antique-gold"
                    : "border-charcoal/8 bg-soft-cream/50 text-warm-grey"
              }`}
            >
              <span className={available || isSel ? "" : "line-through decoration-warm-grey/40"}>{h.horse_name}</span>
              <span className={`text-[11px] uppercase tracking-[0.08em] ${isSel ? "text-warm-ivory/80" : ""}`}>
                {isSel ? "Selected" : isCurrent && h.horse_state === "mine" ? "Current" : label}
              </span>
            </button>
          );
        })}
      </div>
    </li>
  );
}

/** Folds the flat session × horse rows into one entry per session. */
export function groupSessions(rows) {
  const bySession = new Map();
  for (const r of rows) {
    if (!bySession.has(r.session_id)) {
      bySession.set(r.session_id, {
        id: r.session_id,
        session_date: r.session_date,
        start_time: r.start_time,
        end_time: r.end_time,
        status: r.session_status,
        capacity: r.capacity,
        booked_count: r.booked_count,
        available_count: r.available_count,
        is_bookable: r.is_bookable,
        horses: [],
      });
    }
    bySession.get(r.session_id).horses.push({ horse_id: r.horse_id, horse_name: r.horse_name, horse_state: r.horse_state });
  }
  return [...bySession.values()];
}

function DateStrip({ date, min, max, onChange }) {
  const scrollerRef = useRef(null);
  const dates = buildDateRange(min, max);
  const today = todayISODate();
  const scrollBy = (dir) => scrollerRef.current?.scrollBy({ left: dir * 240, behavior: "smooth" });

  return (
    <div>
      <p className="mb-3 font-sans text-[11px] tracking-[0.18em] text-warm-grey uppercase">Date</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Scroll dates earlier"
          onClick={() => scrollBy(-1)}
          className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-full border border-charcoal/15 text-charcoal transition-colors hover:border-antique-gold sm:flex"
        >
          <ChevronLeft size={16} strokeWidth={1.75} />
        </button>
        <div ref={scrollerRef} className="flex flex-1 gap-2 overflow-x-auto scroll-smooth pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {dates.map((iso) => {
            const { weekday, day, month } = dateParts(iso);
            const isSelected = iso === date;
            return (
              <button
                key={iso}
                type="button"
                onClick={() => onChange(iso)}
                aria-pressed={isSelected}
                className={`flex min-w-[64px] shrink-0 flex-col items-center gap-0.5 rounded-[12px] border px-3 py-2.5 font-sans transition-colors ${
                  isSelected
                    ? "border-racing-green bg-racing-green text-warm-ivory"
                    : "border-charcoal/12 bg-white text-charcoal hover:border-antique-gold/50"
                }`}
              >
                <span className={`text-[10px] tracking-[0.1em] uppercase ${isSelected ? "text-warm-ivory/70" : "text-warm-grey"}`}>{weekday}</span>
                <span className="font-serif text-lg leading-none">{day}</span>
                <span className={`text-[10px] tracking-[0.1em] uppercase ${isSelected ? "text-warm-ivory/70" : "text-warm-grey"}`}>{month}</span>
                {iso === today && !isSelected && <span className="mt-0.5 h-1 w-1 rounded-full bg-antique-gold" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          aria-label="Scroll dates later"
          onClick={() => scrollBy(1)}
          className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-full border border-charcoal/15 text-charcoal transition-colors hover:border-antique-gold sm:flex"
        >
          <ChevronRight size={16} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function buildDateRange(min, max) {
  if (!min || !max) return [];
  const dates = [];
  let cursor = min;
  while (cursor <= max && dates.length < 60) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function dateParts(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return {
    weekday: d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" }),
    day: d.toLocaleDateString("en-GB", { day: "2-digit", timeZone: "UTC" }),
    month: d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
  };
}
