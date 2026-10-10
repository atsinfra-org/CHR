import { useMemo, useState } from "react";
import { RefreshCw, ClipboardCheck } from "lucide-react";
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
  SelectField,
  StatusPill,
  TableShell,
  Toolbar,
} from "../ui";
import { fmtDate, fmtTime, groupRoster, istToday, titleCase } from "../adminUtils";

const ATTENDANCE_STATUSES = ["present", "absent", "no_show", "excused"];

/**
 * Attendance for one session (pick a date, then a session). Staff/admin
 * only — enforced by admin_mark_attendance(), which checks
 * is_staff_or_admin() itself; customers have no write path to attendance.
 *
 * Present   → booking completed, the credit stays consumed.
 * Absent    → booking absent; the credit is restored ONCE (policy in
 *             system_settings: absence_credit_restore_enabled /
 *             max_restored_absences). Re-saving the same status cannot
 *             restore it twice — the database guarantees that.
 * Excused   → treated like Absent for credit purposes.
 * No-show   → recorded, credit stays consumed.
 */
export default function AdminAttendance() {
  const [date, setDate] = useState(istToday());
  const [sessionId, setSessionId] = useState("");

  const roster = useAdminQuery(() => adminApi.sessionRoster(date).then((r) => ({ data: r.data, error: r.error ? { message: r.error } : null })), [date]);

  const sessions = useMemo(() => groupRoster(roster.data).map((s) => ({ ...s, booked: s.riders.length })), [roster.data]);

  // Default to the first session that has riders, falling back to the first session.
  const activeSessionId =
    sessionId && sessions.some((s) => s.id === sessionId) ? sessionId : (sessions.find((s) => s.booked > 0) ?? sessions[0])?.id ?? "";

  const rows = useMemo(() => sessions.find((s) => s.id === activeSessionId)?.riders ?? [], [sessions, activeSessionId]);
  const marked = rows.filter((r) => r.attendance_status).length;

  return (
    <div>
      <PageHeader
        route="attendance"
        actions={
          <ActionButton icon={RefreshCw} onClick={roster.reload}>
            Refresh
          </ActionButton>
        }
      />

      <Toolbar>
        <div className="flex flex-wrap items-end gap-4">
          <DayPicker value={date} onChange={(d) => { setDate(d); setSessionId(""); }} />
          <SelectField label="Session" value={activeSessionId} onChange={(e) => setSessionId(e.target.value)} className="min-w-[200px]">
            {sessions.length === 0 && <option value="">No sessions</option>}
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {fmtTime(s.start)} – {fmtTime(s.end)} ({s.booked} booked)
              </option>
            ))}
          </SelectField>
        </div>
        <div className="flex items-center gap-4">
          {date !== istToday() && (
            <ActionButton variant="ghost" onClick={() => { setDate(istToday()); setSessionId(""); }}>
              Today
            </ActionButton>
          )}
          {roster.status === "ready" && rows.length > 0 && (
            <p className="font-sans text-xs text-warm-grey">
              <span className="font-medium text-charcoal">{marked}</span> of {rows.length} marked
              {rows.length - marked > 0 && ` · ${rows.length - marked} pending`}
            </p>
          )}
        </div>
      </Toolbar>

      {roster.status === "error" && <ErrorBox message={roster.error} onRetry={roster.reload} />}
      {roster.status === "loading" && <Loading>Loading roster…</Loading>}
      {roster.status === "ready" &&
        (sessions.length === 0 ? (
          <Empty icon={ClipboardCheck} detail="We ride Tuesday to Sunday. Generate sessions on the Sessions page if this day should have some.">
            No sessions on {fmtDate(date)}
          </Empty>
        ) : rows.length === 0 ? (
          <Empty icon={ClipboardCheck} detail="Riders appear here once they have a booking for this session.">
            No bookings in this session
          </Empty>
        ) : (
          <TableShell head={["Customer", "Booking", "Attendance", ""]} minWidth="700px">
            {rows.map((r) => (
              <AttendanceRow key={`${r.booking_id}:${r.attendance_status ?? ""}`} row={r} onSaved={roster.reload} />
            ))}
          </TableShell>
        ))}
    </div>
  );
}

function AttendanceRow({ row, onSaved }) {
  const current = row.attendance_status ?? "pending";
  const [value, setValue] = useState(row.attendance_status ?? "present");
  const [state, setState] = useState({ busy: false, error: null });
  const dirty = value !== row.attendance_status;
  const customer = row.customer_name || row.customer_email || "—";

  const save = async () => {
    setState({ busy: true, error: null });
    const { error } = await adminApi.markAttendance(row.booking_id, value, "");
    if (error) {
      setState({ busy: false, error });
      return;
    }
    setState({ busy: false, error: null });
    onSaved();
  };

  return (
    <tr className="border-b border-charcoal/[0.06] align-top last:border-0 hover:bg-soft-cream/40">
      <td className="px-4 py-3.5">
        <span className="block font-sans text-sm text-charcoal">{customer}</span>
        <span className="mt-0.5 block font-sans text-xs text-warm-grey">
          {row.plan_name ?? "—"} · {row.credits_remaining ?? 0} credits left
          {row.reschedule_count > 0 ? " · rescheduled" : ""}
        </span>
      </td>
      <td className="px-4 py-3.5">
        <StatusPill value={row.booking_status} />
      </td>
      <td className="px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`Attendance for ${customer}`}
            className="rounded-[10px] border border-antique-gold/25 bg-white px-2.5 py-2 font-sans text-xs text-charcoal outline-none transition-colors focus:border-antique-gold"
          >
            {ATTENDANCE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {titleCase(s)}
              </option>
            ))}
          </select>
          <span className="font-sans text-[11px] text-warm-grey">now: {titleCase(current)}</span>
        </div>
        {value !== "present" && value !== "no_show" && dirty && (
          <p className="mt-1.5 font-sans text-[11px] text-warm-grey">Saving restores 1 credit (once, per policy).</p>
        )}
        {state.error && (
          <div className="mt-2">
            <InlineError message={state.error} />
          </div>
        )}
      </td>
      <td className="px-4 py-3.5 text-right">
        <ActionButton variant={dirty ? "primary" : "secondary"} disabled={state.busy || !dirty} className="px-3.5 py-2" onClick={save}>
          {state.busy ? "Saving…" : row.attendance_status ? "Update" : "Save"}
        </ActionButton>
      </td>
    </tr>
  );
}
