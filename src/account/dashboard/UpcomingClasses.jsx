import { useState } from "react";
import { CalendarDays, X } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { Card, SectionHeader, StatusPill, ActionButton, ConfirmDialog, CardSkeleton, ErrorState, EmptyState, useToast } from "../ui";
import { formatDate, formatTime } from "../dashboardUtils";

const CANCELLABLE_STATUSES = new Set(["held", "confirmed"]);

/**
 * The member's own upcoming bookings, read straight through RLS
 * ("Members read own bookings" — user_id = auth.uid()). No client-side
 * filtering by identity happens here; the query itself is scoped to the
 * signed-in user and to future sessions.
 *
 * Cancellation goes through cancel_booking() alone — this component never
 * decides whether a credit is returned (that depends on
 * system_settings.cancellation_cutoff_hours, enforced server-side); it just
 * reports the call's outcome and asks the parent to refresh every affected
 * section (credits, block usage, activity) from the database.
 */
export default function UpcomingClasses({ upcoming, onCancelled }) {
  return (
    <Card id="classes">
      <SectionHeader title="Upcoming Classes" />

      {upcoming.status === "loading" || upcoming.status === "idle" ? (
        <CardSkeleton lines={3} />
      ) : upcoming.status === "error" ? (
        <ErrorState detail={upcoming.error} onRetry={upcoming.retry} />
      ) : upcoming.bookings.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No upcoming classes"
          detail="Book your next riding session to see it here."
          action={
            <ActionButton href="/account/book" variant="primary">
              Book Your First Class
            </ActionButton>
          }
        />
      ) : (
        <ul className="divide-y divide-charcoal/5">
          {upcoming.bookings.map((booking) => (
            <BookingRow key={booking.id} booking={booking} onCancelled={onCancelled} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function BookingRow({ booking, onCancelled }) {
  const { notify } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [state, setState] = useState({ status: "idle", error: null }); // idle | cancelling | error
  const session = booking.class_sessions;
  const cancellable = CANCELLABLE_STATUSES.has(booking.status);

  const handleCancel = async () => {
    setState({ status: "cancelling", error: null });
    const { error } = await supabase.rpc("cancel_booking", { p_booking_id: booking.id, p_reason: null });
    if (error) {
      const message = friendlyCancelError(error);
      setState({ status: "error", error: message });
      setConfirmOpen(false);
      notify(message, "error");
      return;
    }
    setState({ status: "idle", error: null });
    setConfirmOpen(false);
    notify("Booking cancelled", "success");
    onCancelled?.();
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        <CalendarDays size={16} strokeWidth={1.75} className="shrink-0 text-antique-gold" />
        <div>
          <p className="font-sans text-sm text-charcoal">{formatDate(session?.session_date)}</p>
          <p className="mt-0.5 font-sans text-xs text-warm-grey">
            {formatTime(session?.start_time)} – {formatTime(session?.end_time)}
            {booking.horses?.name ? ` · ${booking.horses.name}` : ""}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <StatusPill value={booking.status} />
        {cancellable && (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={state.status === "cancelling"}
            aria-label="Cancel booking"
            title="Cancel booking"
            className="flex h-9 w-9 items-center justify-center rounded-full text-warm-grey transition-colors hover:bg-destructive/5 hover:text-destructive disabled:opacity-50"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Cancel this class?"
        description={`${formatDate(session?.session_date)} at ${formatTime(session?.start_time)}. Whether a credit is returned depends on the cancellation window.`}
        confirmLabel="Cancel Booking"
        danger
        busy={state.status === "cancelling"}
        onConfirm={handleCancel}
        onClose={() => setConfirmOpen(false)}
      />
    </li>
  );
}

function friendlyCancelError(error) {
  const known = {
    BOOKING_NOT_FOUND: "This booking couldn't be found.",
    BOOKING_NOT_CANCELLABLE: error.details || "This booking can no longer be cancelled.",
    "Not authorized to cancel this booking": "You can only cancel your own bookings.",
    "Not authenticated": "Your session has expired — please sign in again.",
  }[error.message];
  return known || error.details || "Couldn't cancel this booking. Please try again.";
}

