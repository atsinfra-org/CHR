import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Repeat, ShieldAlert } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import AccountStateGuard from "./AccountStateGuard";
import { useBookingEligibility } from "./useBookingEligibility";
import { useMembershipStatus } from "./useMembershipStatus";
import ClassCalendar from "./booking/ClassCalendar";
import { fetchWaitlist } from "./booking/availability";
import { friendlyBookingError, isStaleSlotError } from "./bookingErrors";
import { formatDayLong, formatDayShort, formatTimeRange } from "./dashboardUtils";
import CurrentSchedule from "./weekly/CurrentSchedule";
import { bookSingle, limitMessage, planWeeklySlots, removeWeeklySlot, saveWeekly, slotOfSession } from "./weekly/submit";
import { friendlyRecurringError, slotKey, timeRange12, WEEKDAY_NAMES, weekdayOf } from "./weekly/weeklyLogic";
import { PageHeader, ActionButton, ConfirmDialog, CardSkeleton, ErrorState, EmptyState, InlineError, useToast } from "./ui";

/**
 * Book a class — pick a day on the calendar, then a time. A booking is a
 * place in a class and nothing more.
 *
 * A presentation layer only: eligibility comes from
 * member_booking_eligibility(), availability from the server, and
 * book_class() alone decides whether the attempt succeeds. The class is only
 * taken off the plan inside the same database transaction that creates the
 * booking.
 */
export default function BookClasses() {
  return <AccountStateGuard active="book">{({ user }) => <Booking user={user} />}</AccountStateGuard>;
}

function Booking({ user }) {
  const eligibility = useBookingEligibility(user?.id);
  const membership = useMembershipStatus(user?.id);

  // Only the first load shows a placeholder. A refresh after booking keeps the
  // calendar (and the "you're booked" note) on screen while the numbers update.
  if (!eligibility.data && (eligibility.status === "loading" || eligibility.status === "idle")) {
    return (
      <PageShell>
        <CardSkeleton lines={2} />
        <div className="mt-6 space-y-3">
          <CardSkeleton lines={3} />
        </div>
      </PageShell>
    );
  }

  if (eligibility.status === "error") {
    return (
      <PageShell>
        <ErrorState title="We couldn't load your booking details" detail={eligibility.error} onRetry={eligibility.retry} />
      </PageShell>
    );
  }

  const elig = eligibility.data;

  if (!elig?.has_active_membership) {
    return (
      <PageShell>
        <EmptyState
          icon={ShieldAlert}
          title="You need a plan to book classes"
          detail="Choose a plan in the store. Once your payment is confirmed you can book here."
          action={
            <ActionButton href="/store" variant="primary">
              Go to store
            </ActionButton>
          }
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PlanStrip elig={elig} membership={membership} />
      <BookingFlow
        elig={elig}
        weekly={{ slotsPerWeek: Number(membership.plan?.recurring_slots_per_week ?? 0) }}
        onBooked={() => {
          eligibility.retry();
          membership.retry();
        }}
      />
    </PageShell>
  );
}

/** One line of context: which plan, how many classes are left, and any limit that applies right now. */
function PlanStrip({ elig, membership }) {
  const total = membership.record?.total_credits ?? membership.plan?.class_credits ?? null;
  const left = elig.credits_remaining;
  const noClasses = left <= 0;
  const weekFull = !noClasses && elig.block_classes_remaining <= 0;

  return (
    <div className="mb-8 border-y border-antique-gold/25 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1">
        <p className="font-serif text-xl text-charcoal">{membership.plan?.name ?? "Your plan"}</p>
        <p className="font-sans text-sm text-warm-grey">
          <span className="font-medium text-charcoal">
            {left}
            {total ? ` of ${total}` : ""}
          </span>{" "}
          class{left === 1 ? "" : "es"} left · valid until {formatDayShort(elig.membership_end_date) ?? "—"}
        </p>
      </div>

      {noClasses && (
        <p className="mt-3 font-sans text-sm text-warning">You have used every class on this plan. Choose another plan in the store to keep riding.</p>
      )}
      {weekFull && (
        <p className="mt-3 font-sans text-sm text-warning">
          You have booked {elig.block_classes_used} of {elig.block_class_limit} classes for this week (until {formatDayShort(elig.current_block_end)}). Pick a
          day after that.
        </p>
      )}
    </div>
  );
}

export function BookingFlow({ elig, onBooked, weekly }) {
  const { notify } = useToast();
  const [selected, setSelected] = useState(null); // { sessionId, session }
  const [confirmMode, setConfirmMode] = useState(null); // "single" | "weekly" | null
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [booked, setBooked] = useState(null); // { text, weekly } for the confirmation note
  const [reloadKey, setReloadKey] = useState(0);
  const [waitlist, setWaitlist] = useState({ enabled: false, ids: new Set() });
  const [waitBusy, setWaitBusy] = useState(null);
  const [schedule, setSchedule] = useState({ status: "idle", data: null });

  const slotsPerWeek = weekly?.slotsPerWeek ?? 0;
  const canRepeat = slotsPerWeek > 0;

  // The two weekly calls, as the helpers expect them.
  const api = useMemo(
    () => ({
      confirm: (slots) => supabase.rpc("confirm_recurring_schedule", { p_slots: slots }),
      fetchSchedule: () => supabase.rpc("my_recurring_schedule"),
      stop: () => supabase.rpc("end_recurring_schedule"),
      book: (sessionId) => supabase.rpc("book_class", { p_session_id: sessionId }),
    }),
    []
  );

  useEffect(() => {
    let live = true;
    fetchWaitlist().then((w) => live && setWaitlist(w));
    if (canRepeat) {
      api.fetchSchedule().then(({ data, error: err }) => live && setSchedule(err ? { status: "error", data: null } : { status: "ready", data: data ?? null }));
    }
    return () => {
      live = false;
    };
  }, [reloadKey, canRepeat, api]);

  const changeWaitlist = useCallback(
    (fn) => async (sessionId) => {
      setWaitBusy(sessionId);
      setError(null);
      const { error: rpcError } = await supabase.rpc(fn, { p_session_id: sessionId });
      if (rpcError) {
        setError(friendlyBookingError(rpcError));
        if (isStaleSlotError(rpcError)) setReloadKey((k) => k + 1);
      } else {
        notify(fn === "join_waitlist" ? "You're on the waitlist. We'll tell you if a place opens." : "Removed from the waitlist", "success");
        setWaitlist(await fetchWaitlist());
      }
      setWaitBusy(null);
    },
    [notify]
  );

  // The weekly limit depends on the week of the class being booked, so it is
  // left to book_class() to judge; only "no classes left" disables the button.
  const canBook = elig.credits_remaining > 0;
  const existingSlots = schedule.data?.slots ?? [];
  const alreadyWeekly = selected ? existingSlots.some((s) => slotKey(s.day_of_week, s.start_time) === slotOfSession(selected.session).key) : false;

  const when = selected ? `${formatDayLong(selected.session.session_date)}, ${formatTimeRange(selected.session.start_time, selected.session.end_time)}` : "";
  const weekdayName = selected ? WEEKDAY_NAMES[weekdayOf(selected.session.session_date)] : "";
  const weekPlan = selected && canRepeat ? planWeeklySlots({ existingSlots, session: selected.session, slotsPerWeek }) : null;

  const finish = (text, isWeekly) => {
    notify(isWeekly ? "Weekly schedule saved" : "Class booked", "success");
    setBooked({ text, weekly: isWeekly });
    setSelected(null);
    setReloadKey((k) => k + 1);
    onBooked();
  };

  const confirm = async () => {
    // A plan that can repeat weekly never books a lone class from this page.
    if (canRepeat && confirmMode !== "weekly") return;
    setBusy(true);
    setError(null);
    if (confirmMode === "weekly") {
      const out = await saveWeekly({ api, existingSlots, session: selected.session, slotsPerWeek });
      setBusy(false);
      setConfirmMode(null);
      if (!out.ok) {
        setError(out.error);
        setReloadKey((k) => k + 1);
        return;
      }
      finish(out.message, true);
      return;
    }
    const out = await bookSingle({ api, sessionId: selected.sessionId });
    setBusy(false);
    setConfirmMode(null);
    if (!out.ok) {
      setError(out.error);
      if (isStaleSlotError(out.raw)) {
        setSelected(null);
        setReloadKey((k) => k + 1);
      }
      return;
    }
    finish(`You're booked for ${when}.`, false);
  };

  const manage = async (job) => {
    setBusy(true);
    setError(null);
    const out = await job();
    setBusy(false);
    if (!out.ok) {
      setError(out.error);
      setReloadKey((k) => k + 1);
      return;
    }
    notify(out.message, "success");
    setBooked({ text: out.message, weekly: true });
    setReloadKey((k) => k + 1);
    onBooked();
  };

  return (
    <div>
      {booked && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-racing-green/25 bg-racing-green/[0.06] px-5 py-4">
          <p className="flex items-center gap-2.5 font-sans text-sm text-racing-green">
            <CheckCircle2 size={17} strokeWidth={1.75} />
            {booked.text}
          </p>
          <a href={booked.weekly ? "/account/classes" : "/account"} className="font-sans text-xs tracking-[0.12em] text-racing-green uppercase underline underline-offset-4">
            {booked.weekly ? "See my classes" : "See it on your dashboard"}
          </a>
        </div>
      )}

      {canRepeat && schedule.status === "ready" && schedule.data && (
        <CurrentSchedule
          schedule={schedule.data}
          busy={busy}
          onRemoveSlot={(key) => manage(() => removeWeeklySlot({ api, existingSlots, key }))}
          onStop={() => manage(async () => {
            const { error: stopError } = await api.stop();
            return stopError ? { ok: false, error: friendlyRecurringError(stopError) } : { ok: true, message: "Your weekly schedule has stopped. Classes already booked stay as they are." };
          })}
        />
      )}

      <ClassCalendar
        min={elig.min_bookable_date}
        max={elig.max_bookable_date}
        selected={selected}
        reloadKey={reloadKey}
        waitlist={waitlist.enabled ? { ids: waitlist.ids, busyId: waitBusy, onJoin: changeWaitlist("join_waitlist"), onLeave: changeWaitlist("leave_waitlist") } : null}
        onSelect={(slot) => {
          setError(null);
          if (slot) setBooked(null);
          setSelected(slot);
        }}
      />

      {error && (
        <div className="mt-5">
          <InlineError message={error} />
        </div>
      )}

      {/* On phones the bar only pins to the bottom once a time is chosen, so it never covers the times while browsing. */}
      <div
        className={`z-10 mt-8 flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-antique-gold/25 bg-white/95 px-5 py-4 shadow-[0_18px_40px_-24px_rgba(8,28,21,0.25)] ${
          selected ? "sticky bottom-20" : ""
        }`}
      >
        <p className="font-sans text-sm text-warm-grey">
          {selected ? (
            <>
              <span className="font-medium text-charcoal">{when}</span>
              <span className="ml-2 text-xs">{canRepeat ? `· repeats every ${weekdayName}` : "· uses 1 class"}</span>
            </>
          ) : (
            "Pick a day, then a time."
          )}
        </p>
        {/* Gold and Platinum book ONLY by repeating weekly. A plan with no weekly allowance (One-Time Ride) cannot repeat, so it keeps its single booking. */}
        {canRepeat ? (
          <ActionButton variant="primary" icon={Repeat} className="w-full sm:w-auto sm:min-w-[230px]" disabled={!selected || !canBook || alreadyWeekly} onClick={() => setConfirmMode("weekly")}>
            {alreadyWeekly ? "Already in your weekly schedule" : "Repeat every week"}
          </ActionButton>
        ) : (
          <ActionButton variant="primary" className="w-full sm:w-auto" disabled={!selected || !canBook} onClick={() => setConfirmMode("single")}>
            Book this class
          </ActionButton>
        )}
      </div>
      {canRepeat && (
        <p className="mt-2 font-sans text-xs text-warm-grey">
          Your class repeats every week: this day and time is saved to your weekly schedule (up to {slotsPerWeek} a week on your plan), and we book it for you week after week until
          your plan ends or your classes run out. Your coach will assign your horse at the ground.
        </p>
      )}

      <ConfirmDialog
        open={confirmMode !== null}
        title={confirmMode === "weekly" ? "Repeat this class every week?" : "Book this class?"}
        description={
          !selected ? "" : confirmMode === "weekly" ? (
            <WeeklyConfirmText weekdayName={weekdayName} session={selected.session} plan={weekPlan} slotsPerWeek={slotsPerWeek} classesLeft={elig.credits_remaining} validUntil={elig.membership_end_date} />
          ) : (
            `${when}. This uses 1 of your classes. Your coach will assign your horse at the ground.`
          )
        }
        confirmLabel={confirmMode === "weekly" ? "Save weekly schedule" : "Book class"}
        busy={busy}
        onConfirm={confirm}
        onClose={() => !busy && setConfirmMode(null)}
      />
    </div>
  );
}

/** What "repeat every week" will do, in plain words, before anything is saved. */
function WeeklyConfirmText({ weekdayName, session, plan, slotsPerWeek, classesLeft, validUntil }) {
  if (plan && !plan.ok) return <p>{plan.code === "LIMIT" ? limitMessage(plan) : "Choose a class first."}</p>;
  const total = (plan?.slots ?? []).length;
  return (
    <div className="space-y-2 text-left">
      <p>
        Every {weekdayName} at {timeRange12(session.start_time, session.end_time)} will be added to your weekly schedule ({total} of {slotsPerWeek} weekly time{slotsPerWeek === 1 ? "" : "s"}).
      </p>
      <p>
        We book those classes for you, week after week, until {formatDayShort(validUntil) ?? "your plan ends"} or until your {classesLeft} remaining class{classesLeft === 1 ? "" : "es"} {classesLeft === 1 ? "is" : "are"} used.
        A class is only used when it is actually booked. A full class is skipped and tried again. Your coach will assign your horse at the ground.
      </p>
    </div>
  );
}

function PageShell({ children }) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <PageHeader title="Book a class" description="Pick a day, then a time. We ride Tuesday to Sunday." />
      {children}
    </div>
  );
}
