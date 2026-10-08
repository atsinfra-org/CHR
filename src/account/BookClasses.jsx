import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import AccountStateGuard from "./AccountStateGuard";
import { useBookingEligibility } from "./useBookingEligibility";
import { useMembershipStatus } from "./useMembershipStatus";
import SlotPicker from "./booking/SlotPicker";
import { friendlyBookingError, isStaleSlotError } from "./bookingErrors";
import { formatDate, formatTime } from "./dashboardUtils";
import {
  PageHeader,
  Card,
  ActionButton,
  ConfirmDialog,
  CardSkeleton,
  ErrorState,
  EmptyState,
  InlineError,
  useToast,
} from "./ui";

/**
 * Book a Riding Class — date → session → horse. A presentation layer only:
 * eligibility comes from member_booking_eligibility(), availability from
 * session_horse_availability(), and book_class() alone decides whether the
 * attempt succeeds. A lost race on a horse comes back as
 * SLOT_NO_LONGER_AVAILABLE and the grid is reloaded; the credit is only
 * consumed inside the same database transaction that creates the booking.
 */
export default function BookClasses() {
  return <AccountStateGuard active="book">{({ user }) => <Booking user={user} />}</AccountStateGuard>;
}

function Booking({ user }) {
  const eligibility = useBookingEligibility(user?.id);
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
          detail="Choose a membership in the store to start booking sessions."
          action={
            <ActionButton href="/store" variant="primary">
              Go to Store
            </ActionButton>
          }
        />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <BookingContext elig={elig} membership={membership} />
      <BookingFlow elig={elig} onBooked={() => { eligibility.retry(); membership.retry(); }} />
    </PageShell>
  );
}

function BookingContext({ elig, membership }) {
  const m = membership.record;
  const plan = membership.plan;
  const total = m?.total_credits ?? plan?.class_credits ?? null;
  const noCredits = elig.credits_remaining <= 0;
  const blockFull = elig.block_classes_remaining <= 0;

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-sans text-[11px] tracking-[0.18em] text-warm-grey uppercase">Your Membership</p>
          <p className="mt-1 font-serif text-lg text-charcoal">{plan?.name ?? "Riding Membership"}</p>
          <p className="mt-1 font-sans text-sm text-warm-grey">
            {elig.credits_remaining}
            {total ? ` of ${total}` : ""} class{elig.credits_remaining === 1 ? "" : "es"} remaining · Valid until{" "}
            {formatDate(elig.membership_end_date) ?? "—"}
          </p>
        </div>
        <ActionButton href="/account#membership" variant="secondary">
          View Membership
        </ActionButton>
      </div>

      {noCredits && (
        <InlineNotice title="No classes remaining" detail="You've used all classes included in your current membership." />
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

function InlineNotice({ title, detail }) {
  return (
    <div className="mt-4 rounded-[10px] border border-warning/30 bg-warning/[0.06] px-4 py-3">
      <p className="font-sans text-sm font-medium text-warning">{title}</p>
      <p className="mt-0.5 font-sans text-xs leading-relaxed text-warm-grey">{detail}</p>
    </div>
  );
}

function BookingFlow({ elig, onBooked }) {
  const { notify } = useToast();
  const [selected, setSelected] = useState(null); // { sessionId, horseId, horseName, session }
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const canBook = elig.credits_remaining > 0 && elig.block_classes_remaining > 0;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("book_class", {
      p_session_id: selected.sessionId,
      p_horse_id: selected.horseId,
    });
    setBusy(false);

    if (rpcError) {
      setConfirmOpen(false);
      setError(friendlyBookingError(rpcError));
      if (isStaleSlotError(rpcError)) {
        setSelected(null);
        setReloadKey((k) => k + 1);
      }
      return;
    }

    setConfirmOpen(false);
    notify(`Class booked — ${selected.horseName}, ${formatTime(selected.session.start_time)}`, "success");
    setSelected(null);
    setReloadKey((k) => k + 1);
    onBooked();
  };

  return (
    <Card>
      <SlotPicker
        min={elig.min_bookable_date}
        max={elig.max_bookable_date}
        selected={selected}
        reloadKey={reloadKey}
        onSelect={(slot) => {
          setError(null);
          setSelected(slot);
        }}
      />

      {error && (
        <div className="mt-4">
          <InlineError message={error} />
        </div>
      )}

      <div className="sticky bottom-20 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-charcoal/10 bg-white/95 px-4 py-3 backdrop-blur md:static md:bg-transparent md:px-0 md:py-0 md:backdrop-blur-none md:border-0">
        <p className="font-sans text-sm text-warm-grey">
          {selected ? (
            <>
              <span className="text-charcoal">{formatDate(selected.session.session_date)}</span> ·{" "}
              {formatTime(selected.session.start_time)} – {formatTime(selected.session.end_time)} · {selected.horseName}
              <span className="ml-2 text-xs">(uses 1 class)</span>
            </>
          ) : (
            "Select a horse in an available session."
          )}
        </p>
        <ActionButton variant="primary" disabled={!selected || !canBook} onClick={() => setConfirmOpen(true)}>
          Book This Class
        </ActionButton>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Confirm booking"
        description={
          selected
            ? `${formatDate(selected.session.session_date)}, ${formatTime(selected.session.start_time)} – ${formatTime(selected.session.end_time)} on ${selected.horseName}. This uses 1 of your classes.`
            : ""
        }
        confirmLabel="Confirm Booking"
        busy={busy}
        onConfirm={confirm}
        onClose={() => !busy && setConfirmOpen(false)}
      />
    </Card>
  );
}

function PageShell({ children }) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <PageHeader title="Book a Riding Class" description="Choose a date, a session and your horse." />
      {children}
    </div>
  );
}
