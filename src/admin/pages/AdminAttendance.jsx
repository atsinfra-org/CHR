import { useMemo, useState } from "react";
import { RefreshCw, ClipboardCheck } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import {
  ActionButton,
  DayPicker,
  Empty,
  ErrorBox,
  InlineError,
  Loading,
  PageHeader,
  StatusPill,
  TableShell,
  Toolbar,
} from "../ui";
import { fmtDate, fmtTime, istToday, titleCase } from "../adminUtils";

const ATTENDANCE_STATUSES = ["present", "absent", "no_show", "excused"];

/**
 * Attendance marking for a day's sessions (§38). Reads via "Staff/admin read
 * all bookings" + "Staff/admin manage attendance"; each save goes through
 * admin_mark_attendance(), which upserts the attendance row and moves the
 * booking to completed / no_show accordingly, in one audited transaction.
 *
 * No invented attendance metrics (§38). The only figures shown are a tally
 * of attendance already recorded for the selected day, derived from the rows
 * on screen and labelled to that date.
 */
export default function AdminAttendance() {
  const [date, setDate] = useState(istToday());

  const { data, status, error, reload } = useAdminQuery(
    () =>
      supabase
        .from("bookings")
        .select(
          "id, status, " +
            "member:profiles!bookings_user_id_fkey(full_name, email), " +
            "session:class_sessions!inner(session_date, start_time, end_time), " +
            "attendance(status, notes)"
        )
        .eq("session.session_date", date)
        .in("status", ["confirmed", "completed", "no_show"]),
    [date]
  );

  const rows = useMemo(
    () =>
      [...(data ?? [])].sort((a, b) => {
        const ta = a.session?.start_time ?? "";
        const tb = b.session?.start_time ?? "";
        if (ta !== tb) return ta < tb ? -1 : 1;
        const na = a.member?.full_name ?? a.member?.email ?? "";
        const nb = b.member?.full_name ?? b.member?.email ?? "";
        return na < nb ? -1 : na > nb ? 1 : 0;
      }),
    [data]
  );

  const tally = useMemo(() => {
    const t = { marked: 0, unmarked: 0 };
    for (const b of rows) {
      const att = attendanceOf(b);
      if (att?.status) t.marked += 1;
      else t.unmarked += 1;
    }
    return t;
  }, [rows]);

  return (
    <div>
      <PageHeader
        route="attendance"
        actions={
          <ActionButton icon={RefreshCw} onClick={reload}>
            Refresh
          </ActionButton>
        }
      />

      <Toolbar>
        <DayPicker value={date} onChange={setDate} />
        <div className="flex items-center gap-4">
          {date !== istToday() && (
            <ActionButton variant="ghost" onClick={() => setDate(istToday())}>
              Today
            </ActionButton>
          )}
          {status === "ready" && rows.length > 0 && (
            <p className="font-sans text-xs text-warm-grey">
              <span className="font-medium text-charcoal">{tally.marked}</span> of {rows.length} marked
              {tally.unmarked > 0 && ` · ${tally.unmarked} awaiting`}
            </p>
          )}
        </div>
      </Toolbar>

      {status === "error" && <ErrorBox message={error} onRetry={reload} />}
      {status === "loading" && <Loading>Loading roster…</Loading>}
      {status === "ready" &&
        (rows.length === 0 ? (
          <Empty icon={ClipboardCheck} detail="Riders appear here once they have a confirmed booking for this day.">
            No bookings on {fmtDate(date)}
          </Empty>
        ) : (
          <TableShell head={["Session", "Rider", "Booking", "Attendance", ""]} minWidth="760px">
            {rows.map((b) => {
              const att = attendanceOf(b);
              // Keyed on the persisted attendance too, so a reload that
              // changes the saved values re-seeds the row's local draft
              // instead of leaving it showing stale input and a stale "Saved".
              return (
                <AttendanceRow
                  key={`${b.id}:${att?.status ?? ""}:${att?.notes ?? ""}`}
                  booking={b}
                  existing={att}
                  onSaved={reload}
                />
              );
            })}
          </TableShell>
        ))}
    </div>
  );
}

function attendanceOf(booking) {
  return Array.isArray(booking.attendance) ? booking.attendance[0] : booking.attendance;
}

/**
 * Rendered as a component rather than inline <tr> markup. TableShell's
 * mobile reflow is scoped CSS precisely so that it still applies here, so
 * the <tr>/<td> structure must stay flat — no wrapper elements around cells.
 */
function AttendanceRow({ booking, existing, onSaved }) {
  const [value, setValue] = useState(existing?.status ?? "present");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [state, setState] = useState({ busy: false, error: null });

  const dirty = value !== (existing?.status ?? "present") || notes !== (existing?.notes ?? "") || !existing;

  const save = async () => {
    setState({ busy: true, error: null });
    const { error } = await adminApi.markAttendance(booking.id, value, notes.trim());
    if (error) {
      setState({ busy: false, error });
      return;
    }
    setState({ busy: false, error: null });
    onSaved();
  };

  const rider = booking.member?.full_name || booking.member?.email || "—";

  return (
    <tr className="border-b border-charcoal/[0.06] align-top last:border-0 hover:bg-soft-cream/40">
      <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm font-medium text-charcoal">
        {booking.session ? `${fmtTime(booking.session.start_time)} – ${fmtTime(booking.session.end_time)}` : "—"}
      </td>
      <td className="px-4 py-3.5">
        <span className="block font-sans text-sm text-charcoal">{rider}</span>
        {booking.member?.full_name && booking.member?.email && (
          <span className="mt-0.5 block font-sans text-xs text-warm-grey">{booking.member.email}</span>
        )}
      </td>
      <td className="px-4 py-3.5">
        <StatusPill value={booking.status} />
      </td>
      <td className="px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`Attendance for ${rider}`}
            className="rounded-[10px] border border-antique-gold/25 bg-white px-2.5 py-2 font-sans text-xs text-charcoal outline-none transition-colors focus:border-antique-gold"
          >
            {ATTENDANCE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {titleCase(s)}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional)"
            aria-label={`Attendance notes for ${rider}`}
            className="w-44 rounded-[10px] border border-antique-gold/25 bg-white px-2.5 py-2 font-sans text-xs text-charcoal outline-none transition-colors focus:border-antique-gold"
          />
        </div>
        {existing?.status && !dirty && (
          <p className="mt-1.5 font-sans text-[11px] text-racing-green">Recorded as {titleCase(existing.status)}</p>
        )}
        {state.error && (
          <div className="mt-2">
            <InlineError message={state.error} />
          </div>
        )}
      </td>
      <td className="px-4 py-3.5 text-right">
        <ActionButton
          variant={dirty ? "primary" : "secondary"}
          disabled={state.busy || !dirty}
          className="px-3.5 py-2"
          onClick={save}
        >
          {state.busy ? "Saving…" : existing ? "Update" : "Save"}
        </ActionButton>
      </td>
    </tr>
  );
}
