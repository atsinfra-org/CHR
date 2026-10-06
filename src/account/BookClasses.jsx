import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, CalendarX, ChevronLeft, ChevronRight, ShieldAlert } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import AccountStateGuard from "./AccountStateGuard";
import { useBookingEligibility } from "./useBookingEligibility";
import { useMembershipStatus } from "./useMembershipStatus";
import { formatDate, formatTime, todayISODate } from "./dashboardUtils";
import {
  PageHeader,
  Card,
  SectionHeader,
  ActionButton,
  StatusPill,
  ConfirmDialog,
  CardSkeleton,
  ErrorState,
  EmptyState,
  useToast,
} from "./ui";

/**
 * Book a Riding Class — a presentation/interaction layer only. Every rule
 * that decides whether a booking succeeds (membership validity, credits,
 * weekly block, capacity, duplicates, past sessions, the bookable date
 * window) is enforced server-side: member_booking_eligibility() for the
 * envelope shown here, available_sessions() (a thin wrapper over the real
 * class_sessions/bookings rows) for what's on the page, and book_class()
 * alone for whether any given attempt is actually allowed. Nothing here
 * recomputes any of that — this component only formats and displays what
 * those calls return, and reports book_class()'s own response.
 *
 * Two things intentionally do NOT appear on this page:
 *  - "Morning"/"Evening" session labels: class_sessions has no session_type
 *    column (checked against supabase/proposals/0002_riding_club_core.sql)
 *    and neither does schedule_templates, so grouping sessions into those
 *    buckets would be a fabricated taxonomy, not a real one. Sessions are
 *    simply listed in start-time order, exactly as available_sessions()
 *    returns them.
 *  - Per-session horse display: bookings.horse_id is nullable and never
 *    set by book_class() (a horse is assigned later, not at booking time),
 *    and available_sessions()/class_sessions_availability expose no horse
 *    relationship at all. There is nothing real to show, so nothing is
 *    shown, rather than listing the farm's horses as if they were tied to
 *    a specific session.
 */
export default function BookClasses() {
  return <AccountStateGuard active="book">{({ user }) => <Booking user={user} />}</AccountStateGuard>;
}

function Booking({ user }) {
  const eligibility = useBookingEligibility(user?.id);
  // Reused only for its plan name — the same hook the dashboard's
  // MembershipCard already relies on. Booking eligibility itself still
  // comes exclusively from useBookingEligibility() below.
  const membership = useMembershipStatus(user?.id);

  if (eligibility.status === "loading" || eligibility.status === "idle") {
    return (
      <PageShell>
        <CardSkeleton lines={2} />
        <div className="mt-6 space-y-3">
          <CardSkeleton lines={1} />
          <CardSkeleton lines={1} />
        </div>
      </PageShell>
    );
  }

  if (eligibility.status === "error") {
    return (
      <PageShell>
        <ErrorState title="Unable to load your booking eligibility" detail={eligibility.error} onRetry={eligibility.retry} />
      </PageShell>
    );
  }

  const elig = eligibility.data;

  if (!elig?.has_active_membership) {
    return (
      <PageShell>
        <EmptyState
          icon={ShieldAlert}
          title="You need an active membership to book classes"
          detail="Purchase or renew a riding membership to start booking sessions."
          action={
            <ActionButton href="/account/purchase" variant="primary">
              View Membership Plans
            </ActionButton>
          }
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <BookingContext elig={elig} plan={membership.plan} />
      <SessionBooking elig={elig} userId={user.id} onBooked={eligibility.retry} />
    </PageShell>
  );
}

/**
 * Compact booking-context strip — real membership/credit numbers already
 * authoritative via member_booking_eligibility(), condensed to what a
 * member needs while choosing a class. Deliberately not another KPI grid;
 * that already exists on the dashboard.
 */
function BookingContext({ elig, plan }) {
  const noCredits = elig.credits_remaining <= 0;
  const blockFull = elig.block_classes_remaining <= 0;

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-sans text-[11px] tracking-[0.18em] text-warm-grey uppercase">Your Membership</p>
          <p className="mt-1 font-serif text-lg text-charcoal">{plan?.name ?? "Riding Membership"}</p>
          <p className="mt-1 font-sans text-sm text-warm-grey">
            {elig.credits_remaining} class{elig.credits_remaining === 1 ? "" : "es"} remaining · Valid until{" "}
            {formatDate(elig.membership_end_date) ?? "—"}
          </p>
        </div>
        <ActionButton href="/account#membership" variant="secondary">
          View Membership
        </ActionButton>
      </div>

      {noCredits && (
        <InlineNotice
          title="No classes remaining"
          detail="You've used all classes included in your current membership."
          actionLabel="View Membership"
          actionHref="/account/purchase"
        />
      )}
      {!noCredits && blockFull && (
        <InlineNotice
          title="Weekly limit reached"
          detail={`You've booked ${elig.block_classes_used} of ${elig.block_class_limit} classes for this week's block (${formatDate(elig.current_block_start)} – ${formatDate(elig.current_block_end)}).`}
        />
      )}
    </Card>
  );
}

function InlineNotice({ title, detail, actionLabel, actionHref }) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-warning/30 bg-warning/[0.06] px-4 py-3">
      <div>
        <p className="font-sans text-sm font-medium text-warning">{title}</p>
        <p className="mt-0.5 font-sans text-xs leading-relaxed text-warm-grey">{detail}</p>
      </div>
      {actionLabel && (
        <ActionButton href={actionHref} variant="secondary" className="shrink-0">
          {actionLabel}
        </ActionButton>
      )}
    </div>
  );
}

function SessionBooking({ elig, userId, onBooked }) {
  const { notify } = useToast();
  const [date, setDate] = useState(elig.min_bookable_date || todayISODate());
  const [sessions, setSessions] = useState({ status: "idle", error: null, rows: [] });
  const [bookedIds, setBookedIds] = useState(new Set());
  const [selected, setSelected] = useState(new Set());
  const [outcome, setOutcome] = useState(null); // { status: 'submitting'|'done', results: [{session, ok, message}] }
  const [confirmOpen, setConfirmOpen] = useState(false);

  const noCredits = elig.credits_remaining <= 0;
  const blockFull = elig.block_classes_remaining <= 0;
  const bookingBlocked = noCredits || blockFull;
  const blockedReason = noCredits ? "No classes remaining" : "Weekly limit reached";

  const loadSessions = useCallback(
    async (forDate) => {
      setSessions({ status: "loading", error: null, rows: [] });
      const [{ data, error }, ownBookings] = await Promise.all([
        supabase.rpc("available_sessions", { p_date: forDate }),
        supabase
          .from("bookings")
          .select("session_id, class_sessions!inner(session_date)")
          .eq("user_id", userId)
          .in("status", ["held", "confirmed"])
          .eq("class_sessions.session_date", forDate),
      ]);

      if (error) {
        setSessions({ status: "error", error: error.message, rows: [] });
        return;
      }
      const already = new Set((ownBookings.data ?? []).map((b) => b.session_id));
      setBookedIds(already);
      setSessions({ status: "ready", error: null, rows: data ?? [] });
    },
    [userId]
  );

  useEffect(() => {
    setSelected(new Set());
    setOutcome(null);
    loadSessions(date);
  }, [date, loadSessions]);

  const changeDate = (nextDate) => {
    if (nextDate < elig.min_bookable_date || nextDate > elig.max_bookable_date) return;
    setDate(nextDate);
  };

  const toggleSelect = (sessionId) => {
    if (bookingBlocked) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const nowMs = Date.now();
  const isPast = (row) => new Date(`${row.session_date}T${row.start_time}`).getTime() <= nowMs;

  const selectedRows = sessions.rows.filter((r) => selected.has(r.session_id));

  const handleConfirm = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setConfirmOpen(false);
    setOutcome({ status: "submitting", results: [] });

    const results = [];
    // Sequential, not Promise.all — each call is independently authoritative
    // and later calls should see the effect of earlier ones (credits,
    // weekly block) in this same batch, exactly as a real backend decision
    // chain should.
    for (const sessionId of ids) {
      const row = sessions.rows.find((r) => r.session_id === sessionId);
      // eslint-disable-next-line no-await-in-loop
      const { error } = await supabase.rpc("book_class", { p_session_id: sessionId });
      results.push({
        session: row,
        ok: !error,
        code: error?.message,
        message: error ? friendlyBookingError(error) : "Confirmed",
      });
    }

    setOutcome({ status: "done", results });
    setSelected(new Set());
    loadSessions(date);
    onBooked?.();

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;
    if (succeeded > 0 && failed === 0) {
      notify(succeeded === 1 ? "Class booked successfully" : `${succeeded} classes booked successfully`, "success");
    } else if (succeeded > 0 && failed > 0) {
      notify(`${succeeded} booked, ${failed} couldn't be booked`, "warning");
    } else {
      notify(`Unable to book the selected class${results.length === 1 ? "" : "es"}`, "error");
    }
  };

  if (outcome?.status === "done") {
    return <BookingOutcome results={outcome.results} onBookAnother={() => setOutcome(null)} />;
  }

  return (
    <div>
      <DateStrip date={date} min={elig.min_bookable_date} max={elig.max_bookable_date} onChange={changeDate} />

      <SectionHeader title="Available Sessions" className="mt-8" />

      {sessions.status === "loading" || sessions.status === "idle" ? (
        <div className="space-y-3">
          <CardSkeleton lines={2} />
          <CardSkeleton lines={2} />
        </div>
      ) : sessions.status === "error" ? (
        <ErrorState title="Unable to load classes" detail="We couldn't retrieve availability for this date." onRetry={() => loadSessions(date)} />
      ) : sessions.rows.length === 0 ? (
        <EmptyState icon={CalendarX} title="No classes available" detail="There are no bookable riding sessions for this date." />
      ) : (
        <div className="space-y-3">
          {sessions.rows.map((row) => (
            <SessionCard
              key={row.session_id}
              row={row}
              already={bookedIds.has(row.session_id)}
              past={isPast(row)}
              selected={selected.has(row.session_id)}
              blocked={bookingBlocked}
              blockedReason={blockedReason}
              onToggle={() => toggleSelect(row.session_id)}
              disabled={outcome?.status === "submitting"}
            />
          ))}
        </div>
      )}

      {selected.size > 0 && (
        // bottom-20 clears MemberLayout's fixed mobile bottom nav; that nav
        // is hidden from md up, where bottom-4 applies.
        <div className="sticky bottom-20 mt-6 flex items-center justify-between gap-4 rounded-[12px] border border-antique-gold/40 bg-white px-5 py-4 shadow-[0_12px_32px_-16px_rgba(24,32,28,0.3)] md:bottom-4">
          <p className="font-sans text-sm text-charcoal">
            {selected.size} class{selected.size === 1 ? "" : "es"} selected
          </p>
          <ActionButton variant="primary" onClick={() => setConfirmOpen(true)} loading={outcome?.status === "submitting"}>
            Review &amp; Confirm
          </ActionButton>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Confirm Your Class"
        description={
          selectedRows.length > 0
            ? `${selectedRows
                .map((r) => `${formatDate(r.session_date)} at ${formatTime(r.start_time)}`)
                .join("; ")}. This will use ${selectedRows.length} of your remaining riding classes.`
            : ""
        }
        confirmLabel="Confirm Booking"
        busy={outcome?.status === "submitting"}
        onConfirm={handleConfirm}
        onClose={() => setConfirmOpen(false)}
      />
    </div>
  );
}

/**
 * Every real date in the server-authoritative [min_bookable_date,
 * max_bookable_date] window — nothing outside it is ever rendered, so
 * there's no separate "disable out-of-window dates" step to get wrong.
 */
function DateStrip({ date, min, max, onChange }) {
  const scrollerRef = useRef(null);
  const dates = buildDateRange(min, max);
  const today = todayISODate();

  const scrollBy = (dir) => {
    scrollerRef.current?.scrollBy({ left: dir * 240, behavior: "smooth" });
  };

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
            const isToday = iso === today;
            return (
              <button
                key={iso}
                type="button"
                onClick={() => onChange(iso)}
                className={`flex min-w-[64px] shrink-0 flex-col items-center gap-0.5 rounded-[12px] border px-3 py-2.5 font-sans transition-colors ${
                  isSelected
                    ? "border-racing-green bg-racing-green text-warm-ivory"
                    : "border-charcoal/12 bg-white text-charcoal hover:border-antique-gold/50"
                }`}
              >
                <span className={`text-[10px] tracking-[0.1em] uppercase ${isSelected ? "text-warm-ivory/70" : "text-warm-grey"}`}>{weekday}</span>
                <span className="font-serif text-lg leading-none">{day}</span>
                <span className={`text-[10px] tracking-[0.1em] uppercase ${isSelected ? "text-warm-ivory/70" : "text-warm-grey"}`}>{month}</span>
                {isToday && !isSelected && <span className="mt-0.5 h-1 w-1 rounded-full bg-antique-gold" aria-hidden="true" />}
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

function SessionCard({ row, already, past, selected, blocked, blockedReason, onToggle, disabled }) {
  // Priority order: closed/cancelled/completed session > past > already
  // booked > member-wide restriction (credits/weekly block) > full >
  // almost full > available. Availability itself (available_slots) comes
  // straight from available_sessions() — never recomputed here.
  const availabilityUnknown = row.available_slots === null || row.available_slots === undefined;
  const full = !availabilityUnknown && row.available_slots <= 0;
  const almostFull = !availabilityUnknown && !full && row.available_slots <= 2;
  const notOpen = row.status !== "open";

  let state = "available";
  if (availabilityUnknown) state = "unavailable_data";
  else if (notOpen) state = "closed";
  else if (past) state = "past";
  else if (already) state = "booked";
  else if (blocked) state = "blocked";
  else if (full) state = "full";
  else if (almostFull) state = "almost_full";

  const canBook = state === "available" || state === "almost_full";

  return (
    <Card className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-4">
        <CalendarDays size={18} strokeWidth={1.75} className="shrink-0 text-antique-gold" />
        <div>
          <p className="font-sans text-sm font-medium text-charcoal">
            {formatTime(row.start_time)} – {formatTime(row.end_time)}
          </p>
          <SessionStateLabel state={state} slots={row.available_slots} status={row.status} blockedReason={blockedReason} />
        </div>
      </div>

      <SessionAction state={state} canBook={canBook} selected={selected} onToggle={onToggle} disabled={disabled} />
    </Card>
  );
}

// class_sessions.status (open/closed/cancelled/completed) is a real backend
// enum, so that state alone goes through StatusPill. The other states here
// (available/full/almost-full/already-booked) are derived presentation
// labels, not backend enum values, so they get their own small pill rather
// than borrowing an unrelated status's tone.
function SessionStateLabel({ state, slots, status, blockedReason }) {
  switch (state) {
    case "unavailable_data":
      return <p className="mt-1 font-sans text-xs text-warm-grey">Availability unavailable</p>;
    case "closed":
      return <StatusPill value={status} label={status === "cancelled" ? "Cancelled" : status === "completed" ? "Completed" : "Closed"} />;
    case "past":
      return <p className="mt-1 font-sans text-xs text-warm-grey">Past</p>;
    case "booked":
      return <Pill tone="success">Already Booked</Pill>;
    case "blocked":
      return <p className="mt-1 font-sans text-xs text-warning">{blockedReason}</p>;
    case "full":
      return <Pill tone="danger">Full</Pill>;
    case "almost_full":
      return (
        <p className="mt-1 font-sans text-xs text-warning">
          {slots} slot{slots === 1 ? "" : "s"} remaining
        </p>
      );
    default:
      return <Pill tone="success">Available</Pill>;
  }
}

const PILL_DOT = { success: "bg-racing-green", danger: "bg-destructive" };
const PILL_TEXT = { success: "text-racing-green", danger: "text-destructive" };

function Pill({ tone, children }) {
  return (
    <span className={`mt-1 inline-flex items-center gap-1.5 font-sans text-xs font-medium ${PILL_TEXT[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${PILL_DOT[tone]}`} aria-hidden="true" />
      {children}
    </span>
  );
}

function SessionAction({ state, canBook, selected, onToggle, disabled }) {
  if (state === "booked") return <span className="font-sans text-xs text-warm-grey">—</span>;
  if (!canBook) return null;

  return (
    <ActionButton variant={selected ? "primary" : "secondary"} onClick={onToggle} disabled={disabled}>
      {selected ? "Selected" : "Book Class"}
    </ActionButton>
  );
}

function BookingOutcome({ results, onBookAnother }) {
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const allSucceeded = failed.length === 0;

  return (
    <Card>
      <h2 className="font-serif text-xl text-charcoal">{allSucceeded ? "Booking Confirmed" : "Booking Result"}</h2>
      <p className="mt-1.5 font-sans text-sm text-warm-grey">
        {allSucceeded
          ? `Your riding class${succeeded.length === 1 ? " has" : "es have"} been successfully booked.`
          : `${succeeded.length} of ${results.length} classes booked. See details below.`}
      </p>

      <ul className="mt-6 space-y-3 divide-y divide-charcoal/5">
        {results.map((r, i) => (
          <li key={i} className="flex items-start justify-between gap-4 pt-3 first:pt-0">
            <div>
              <p className="font-sans text-sm text-charcoal">
                {r.session ? `${formatDate(r.session.session_date)}, ${formatTime(r.session.start_time)}` : "Session"}
              </p>
              <p className={`mt-0.5 font-sans text-xs ${r.ok ? "text-racing-green" : "text-destructive"}`}>{r.message}</p>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex flex-wrap gap-3">
        <ActionButton href="/account#classes" variant="primary">
          View My Bookings
        </ActionButton>
        <ActionButton href="/account" variant="secondary">
          Back to Dashboard
        </ActionButton>
        {!allSucceeded && (
          <ActionButton variant="ghost" onClick={onBookAnother}>
            Try Another Date
          </ActionButton>
        )}
      </div>
    </Card>
  );
}

function friendlyBookingError(error) {
  const code = error?.message;
  const detail = error?.details;
  const known = {
    NO_ACTIVE_MEMBERSHIP: "You don't have an active membership.",
    MEMBERSHIP_EXPIRED: detail || "This class falls after your membership ends.",
    NO_CREDITS_REMAINING: "You have no class credits remaining.",
    WEEKLY_LIMIT_REACHED: detail || "You've reached this week's class limit.",
    SESSION_NOT_FOUND: "This class no longer exists.",
    SESSION_NOT_AVAILABLE: detail || "This class is not open for booking.",
    SESSION_FULL: "This class is now full.",
    DUPLICATE_BOOKING: "You've already booked this class.",
    INVALID_SESSION_DATE: detail || "This class can't be booked.",
    "Not authenticated": "Your session has expired — please sign in again.",
  }[code];
  return known || "Unable to book this class. Please try again.";
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildDateRange(min, max) {
  if (!min || !max) return [];
  const dates = [];
  let cursor = min;
  // A bounded, server-defined window (booking_window_days, clamped to
  // membership end) — never an arbitrary or unbounded client loop.
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

function PageShell({ children }) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <PageHeader title="Book a Riding Class" description="Choose a date and find an available session." />
      {children}
    </div>
  );
}
