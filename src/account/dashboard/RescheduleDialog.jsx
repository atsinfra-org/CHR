import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import ClassCalendar from "../booking/ClassCalendar";
import { friendlyBookingError, isStaleSlotError } from "../bookingErrors";
import { formatDayLong, formatDayShort, formatTimeRange, todayISODate } from "../dashboardUtils";
import { ActionButton, InlineError, useToast } from "../ui";

/**
 * Move one booked class to another day or time. The class moves with it —
 * reschedule_booking() releases the old place, creates the new booking and
 * counts one reschedule in a single transaction, and takes no extra class
 * off the plan.
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
    notify("Class moved — no extra class used", "success");
    onDone();
  };

  return (
    <div data-lenis-prevent className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center sm:px-4" role="dialog" aria-modal="true" aria-label="Move class">
      <div className="absolute inset-0 bg-deep-forest/55" onClick={() => !busy && onClose()} />
      <div className="relative flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-[18px] bg-soft-cream text-charcoal shadow-[0_24px_60px_-20px_rgba(8,28,21,0.5)] sm:rounded-[18px]">
        <div className="flex items-start justify-between gap-4 border-b border-antique-gold/20 bg-white px-5 py-4 sm:px-7">
          <div>
            <h2 className="font-serif text-xl text-charcoal">Move this class</h2>
            <p className="mt-1 font-sans text-sm text-warm-grey">
              Currently {formatDayLong(session?.session_date)}, {formatTimeRange(session?.start_time, session?.end_time)}. You have {remaining} reschedule
              {remaining === 1 ? "" : "s"} left, and moving a class doesn&apos;t use another one.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-warm-grey hover:bg-soft-cream hover:text-charcoal">
            <X size={20} strokeWidth={1.75} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-6 sm:px-7">
          <ClassCalendar
            min={todayISODate()}
            max={maxDate}
            selected={selected}
            reloadKey={reloadKey}
            currentSessionId={booking.session_id}
            onSelect={(slot) => {
              setError(null);
              setSelected(slot);
            }}
          />
          {error && (
            <div className="mt-5">
              <InlineError message={error} />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-antique-gold/20 bg-white px-5 py-4 sm:px-7">
          <p className="font-sans text-sm text-warm-grey">
            {selected ? (
              <>
                Move to{" "}
                <span className="font-medium text-charcoal">
                  {formatDayShort(selected.session.session_date)}, {formatTimeRange(selected.session.start_time, selected.session.end_time)}
                </span>
              </>
            ) : (
              "Pick a new day and time."
            )}
          </p>
          <div className="flex gap-2.5">
            <ActionButton variant="ghost" onClick={onClose} disabled={busy}>
              Keep as is
            </ActionButton>
            <ActionButton variant="primary" disabled={!selected} loading={busy} onClick={submit}>
              Move class
            </ActionButton>
          </div>
        </div>
      </div>
    </div>
  );
}
