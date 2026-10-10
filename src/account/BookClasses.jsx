import { useState } from "react";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import AccountStateGuard from "./AccountStateGuard";
import { useBookingEligibility } from "./useBookingEligibility";
import { useMembershipStatus } from "./useMembershipStatus";
import ClassCalendar from "./booking/ClassCalendar";
import { friendlyBookingError, isStaleSlotError } from "./bookingErrors";
import { formatDayLong, formatDayShort, formatTimeRange } from "./dashboardUtils";
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

function BookingFlow({ elig, onBooked }) {
  const { notify } = useToast();
  const [selected, setSelected] = useState(null); // { sessionId, session }
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [booked, setBooked] = useState(null); // last successful booking, for the confirmation note
  const [reloadKey, setReloadKey] = useState(0);

  // The weekly limit depends on the week of the class being booked, so it is
  // left to book_class() to judge; only "no classes left" disables the button.
  const canBook = elig.credits_remaining > 0;

  const when = selected ? `${formatDayLong(selected.session.session_date)}, ${formatTimeRange(selected.session.start_time, selected.session.end_time)}` : "";

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("book_class", { p_session_id: selected.sessionId });
    setBusy(false);
    setConfirmOpen(false);

    if (rpcError) {
      setError(friendlyBookingError(rpcError));
      if (isStaleSlotError(rpcError)) {
        setSelected(null);
        setReloadKey((k) => k + 1);
      }
      return;
    }

    notify("Class booked", "success");
    setBooked(when);
    setSelected(null);
    setReloadKey((k) => k + 1);
    onBooked();
  };

  return (
    <div>
      {booked && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-racing-green/25 bg-racing-green/[0.06] px-5 py-4">
          <p className="flex items-center gap-2.5 font-sans text-sm text-racing-green">
            <CheckCircle2 size={17} strokeWidth={1.75} />
            You&apos;re booked for {booked}.
          </p>
          <a href="/account" className="font-sans text-xs tracking-[0.12em] text-racing-green uppercase underline underline-offset-4">
            See it on your dashboard
          </a>
        </div>
      )}

      <ClassCalendar
        min={elig.min_bookable_date}
        max={elig.max_bookable_date}
        selected={selected}
        reloadKey={reloadKey}
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
        className={`z-10 mt-8 flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-antique-gold/25 bg-white/95 px-5 py-4 shadow-[0_18px_40px_-24px_rgba(8,28,21,0.35)] backdrop-blur md:sticky md:bottom-6 ${
          selected ? "sticky bottom-20" : ""
        }`}
      >
        <p className="font-sans text-sm text-warm-grey">
          {selected ? (
            <>
              <span className="font-medium text-charcoal">{when}</span>
              <span className="ml-2 text-xs">· uses 1 class</span>
            </>
          ) : (
            "Pick a day, then a time."
          )}
        </p>
        <ActionButton variant="primary" disabled={!selected || !canBook} onClick={() => setConfirmOpen(true)}>
          Book this class
        </ActionButton>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Book this class?"
        description={selected ? `${when}. This uses 1 of your classes. Your coach will assign your horse at the ground.` : ""}
        confirmLabel="Book class"
        busy={busy}
        onConfirm={confirm}
        onClose={() => !busy && setConfirmOpen(false)}
      />
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
