import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import SlotPicker from "../booking/SlotPicker";
import { friendlyBookingError, isStaleSlotError } from "../bookingErrors";
import { formatDate, formatTime, todayISODate } from "../dashboardUtils";
import { ActionButton, InlineError, useToast } from "../ui";

/**
 * Move one booked class to another session/horse. The credit entitlement
 * moves with it — reschedule_booking() releases the old horse, creates the
 * new booking and increments reschedules_used in one transaction, and uses
 * no additional credit.
 */
export default function RescheduleDialog({ booking, remaining, maxDate, onClose, onDone }) {
  const { notify } = useToast();
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const session = booking.class_sessions;

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [busy, onClose]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc("reschedule_booking", {
      p_booking_id: booking.id,
      p_new_session_id: selected.sessionId,
      p_new_horse_id: selected.horseId,
    });
    setBusy(false);
    if (rpcError) {
      setError(friendlyBookingError(rpcError));
      if (isStaleSlotError(rpcError)) {
        setSelected(null);
        setReloadKey((k) => k + 1);
      }
      return;
    }
    notify("Class rescheduled — no extra class used", "success");
    onDone();
  };

  return (
    <div data-lenis-prevent className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center sm:px-4" role="dialog" aria-modal="true" aria-label="Reschedule class">
      <div className="absolute inset-0 bg-charcoal/40" onClick={() => !busy && onClose()} />
      <div className="relative flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-[16px] bg-white shadow-[0_24px_60px_-20px_rgba(24,32,28,0.35)] sm:rounded-[16px]">
        <div className="flex items-start justify-between gap-4 border-b border-charcoal/10 px-5 py-4 sm:px-6">
          <div>
            <h2 className="font-serif text-lg text-charcoal">Reschedule class</h2>
            <p className="mt-1 font-sans text-xs text-warm-grey">
              Currently {formatDate(session?.session_date)}, {formatTime(session?.start_time)}
              {booking.horses?.name ? ` · ${booking.horses.name}` : ""}. You have {remaining} reschedule
              {remaining === 1 ? "" : "s"} left. No extra class is used.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="text-warm-grey hover:text-charcoal">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          <SlotPicker
            min={todayISODate()}
            max={maxDate}
            selected={selected}
            reloadKey={reloadKey}
            excludeBookingSessionId={booking.session_id}
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
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-charcoal/10 px-5 py-4 sm:px-6">
          <p className="font-sans text-xs text-warm-grey">
            {selected
              ? `${formatDate(selected.session.session_date)} · ${formatTime(selected.session.start_time)} · ${selected.horseName}`
              : "Pick a new session and horse."}
          </p>
          <div className="flex gap-2.5">
            <ActionButton variant="ghost" onClick={onClose} disabled={busy}>
              Keep Current
            </ActionButton>
            <ActionButton variant="primary" disabled={!selected} loading={busy} onClick={submit}>
              Confirm Reschedule
            </ActionButton>
          </div>
        </div>
      </div>
    </div>
  );
}
