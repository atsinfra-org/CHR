import { useEffect, useRef, useState } from "react";
import { CalendarPlus, MoreHorizontal, Repeat2 } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { bookingToIcs, downloadIcs } from "../../lib/ics";
import { formatDayLong, formatTimeRange } from "../dashboardUtils";
import { ConfirmDialog, useToast } from "../ui";
import RescheduleDialog from "./RescheduleDialog";
import { rescheduleState } from "./history";

/**
 * What a rider can do with a booked class. Moving it is the obvious action;
 * cancelling is tucked into the "more" menu, because cancelling normally
 * loses the class. `tone="dark"` is for the green "next ride" panel.
 *
 * `showCalendar` puts "Add to calendar" in the visible row (next ride) rather
 * than inside the menu (list rows).
 */
export default function BookingActions({ booking, plan, cancellationReturnsClass, onChanged, tone = "light", showCalendar = false, children }) {
  const { notify } = useToast();
  const [moveOpen, setMoveOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const move = rescheduleState(booking, plan);
  const session = booking.class_sessions;
  const dark = tone === "dark";

  const addToCalendar = () => downloadIcs("riding-class.ics", bookingToIcs(booking));

  const cancel = async () => {
    setCancelling(true);
    const { error } = await supabase.rpc("cancel_booking", { p_booking_id: booking.id, p_reason: null });
    setCancelling(false);
    setCancelOpen(false);
    if (error) {
      notify(friendlyCancelError(error), "error");
      return;
    }
    notify("Class cancelled", "success");
    onChanged?.();
  };

  const button = dark
    ? "border-warm-ivory/30 text-warm-ivory hover:border-warm-ivory hover:bg-warm-ivory/10"
    : "border-antique-gold/35 bg-white text-charcoal hover:border-antique-gold hover:bg-soft-cream/50";
  const base = "inline-flex min-h-[40px] items-center gap-2 rounded-[10px] border px-3.5 font-sans text-xs tracking-[0.1em] uppercase transition-colors duration-200";

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {move.canMove ? (
        <button
          type="button"
          onClick={() => setMoveOpen(true)}
          className={`${base} ${dark ? "border-warm-ivory bg-warm-ivory text-racing-green hover:bg-white" : "border-racing-green bg-racing-green text-warm-ivory hover:bg-deep-forest"}`}
        >
          <Repeat2 size={14} strokeWidth={1.75} /> Move class
        </button>
      ) : (
        <span className={`font-sans text-xs ${dark ? "text-warm-ivory/60" : "text-warm-grey"}`}>{move.reason}</span>
      )}

      {showCalendar && (
        <button type="button" onClick={addToCalendar} className={`${base} ${button}`}>
          <CalendarPlus size={14} strokeWidth={1.75} /> Add to calendar
        </button>
      )}

      {children}

      <MoreMenu dark={dark} label={`More options for ${formatDayLong(session?.session_date)}`}>
        {(close) => (
          <>
            {!showCalendar && (
              <MenuItem
                onClick={() => {
                  close();
                  addToCalendar();
                }}
              >
                Add to calendar
              </MenuItem>
            )}
            <MenuItem
              danger
              onClick={() => {
                close();
                setCancelOpen(true);
              }}
            >
              Cancel class
            </MenuItem>
          </>
        )}
      </MoreMenu>

      {moveOpen && (
        <RescheduleDialog
          booking={booking}
          remaining={move.remaining}
          maxDate={plan?.end_date}
          onClose={() => setMoveOpen(false)}
          onDone={() => {
            setMoveOpen(false);
            onChanged?.();
          }}
        />
      )}

      <ConfirmDialog
        open={cancelOpen}
        title="Cancel this class?"
        description={`${formatDayLong(session?.session_date)}, ${formatTimeRange(session?.start_time, session?.end_time)}. ${
          cancellationReturnsClass
            ? "If you cancel in good time the class goes back on your plan."
            : `Cancelling does not return the class to your plan.${move.canMove ? " To keep it, move it to another time instead." : ""}`
        }`}
        confirmLabel="Cancel class"
        cancelLabel="Keep class"
        danger
        busy={cancelling}
        onConfirm={cancel}
        onClose={() => !cancelling && setCancelOpen(false)}
      />
    </div>
  );
}

function MoreMenu({ children, dark, label }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors ${
          dark ? "text-warm-ivory/70 hover:bg-warm-ivory/10 hover:text-warm-ivory" : "text-warm-grey hover:bg-soft-cream hover:text-charcoal"
        }`}
      >
        <MoreHorizontal size={18} strokeWidth={1.75} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-xl border border-antique-gold/20 bg-white py-1 shadow-lg">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, danger = false }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`block w-full px-4 py-2.5 text-left font-sans text-sm transition-colors hover:bg-soft-cream/60 ${danger ? "text-destructive" : "text-charcoal"}`}
    >
      {children}
    </button>
  );
}

function friendlyCancelError(error) {
  const known = {
    BOOKING_NOT_FOUND: "This booking couldn't be found.",
    BOOKING_NOT_CANCELLABLE: error.details || "This class can no longer be cancelled.",
    "Not authorized to cancel this booking": "You can only cancel your own classes.",
    "Not authenticated": "Your session has expired — please sign in again.",
  }[error.message];
  return known || "We couldn't cancel this class. Please try again.";
}
