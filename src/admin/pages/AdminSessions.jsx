import { useMemo, useState } from "react";
import { RefreshCw, CalendarRange, CalendarPlus } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import {
  ActionButton,
  Card,
  DayPicker,
  Empty,
  ErrorBox,
  InlineError,
  Loading,
  PageHeader,
  SectionHeader,
  StatusPill,
  Toolbar,
} from "../ui";
import { addDays, fmtDate, fmtTime, istToday, titleCase } from "../adminUtils";

const SESSION_STATUSES = ["open", "closed", "cancelled", "completed"];

/**
 * Session schedule (§36) — presented as a day timeline rather than a CRUD
 * table, which is what the data actually is.
 *
 * available_sessions() is the authoritative source for occupancy: it is
 * SECURITY DEFINER and counts every member's held/confirmed bookings, so
 * booked_count / available_slots are global figures rather than a slice
 * visible to this admin.
 *
 * class_sessions and schedule_templates carry no instructor or horse
 * assignment, so the timeline deliberately shows time, status and occupancy
 * only — §36/§45 forbid inventing those relationships.
 *
 * Generating sessions calls admin_generate_sessions(), which wraps the
 * locked generate_sessions(); capacity is derived there from
 * system_settings / the active-available horse count and is never set from
 * the client (§67).
 */
export default function AdminSessions() {
  const [date, setDate] = useState(istToday());
  const [generating, setGenerating] = useState(false);

  const { data, status, error, reload } = useAdminQuery(
    () => supabase.rpc("available_sessions", { p_date: date }),
    [date]
  );

  const [rowError, setRowError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const rows = useMemo(
    () => [...(data ?? [])].sort((a, b) => (a.start_time < b.start_time ? -1 : 1)),
    [data]
  );

  // Summed from the rows actually returned for this day — a real figure,
  // scoped to the selected date rather than implied as a global total.
  const day = useMemo(() => {
    const live = rows.filter((s) => s.status !== "cancelled");
    return {
      sessions: rows.length,
      capacity: live.reduce((n, s) => n + Number(s.capacity ?? 0), 0),
      booked: live.reduce((n, s) => n + Number(s.booked_count ?? 0), 0),
    };
  }, [rows]);

  const setStatus = async (sessionId, next) => {
    setBusyId(sessionId);
    setRowError(null);
    const { error: e } = await adminApi.setSessionStatus(sessionId, next);
    setBusyId(null);
    if (e) setRowError(e);
    else reload();
  };

  const isToday = date === istToday();

  return (
    <div>
      <PageHeader
        route="sessions"
        actions={
          <>
            <ActionButton icon={RefreshCw} onClick={reload}>
              Refresh
            </ActionButton>
            <ActionButton variant="primary" icon={CalendarPlus} onClick={() => setGenerating((v) => !v)}>
              Generate
            </ActionButton>
          </>
        }
      />

      {generating && <GenerateSessions onGenerated={reload} onClose={() => setGenerating(false)} />}

      <Toolbar>
        <DayPicker value={date} onChange={setDate} />
        <div className="flex items-center gap-4">
          {!isToday && (
            <ActionButton variant="ghost" onClick={() => setDate(istToday())}>
              Today
            </ActionButton>
          )}
          {status === "ready" && day.sessions > 0 && (
            <p className="font-sans text-xs text-warm-grey">
              <span className="font-medium text-charcoal">{day.booked}</span> of {day.capacity} seats booked
              {" · "}
              {day.sessions} {day.sessions === 1 ? "session" : "sessions"}
            </p>
          )}
        </div>
      </Toolbar>

      {rowError && (
        <div className="mb-4">
          <InlineError message={rowError} />
        </div>
      )}
      {status === "error" && <ErrorBox message={error} onRetry={reload} />}
      {status === "loading" && <Loading rows={4}>Loading sessions…</Loading>}
      {status === "ready" &&
        (rows.length === 0 ? (
          <Empty icon={CalendarRange} detail="Generate sessions from the schedule templates to populate this day.">
            No sessions scheduled for {fmtDate(date)}
          </Empty>
        ) : (
          <ol className="relative space-y-2 pl-6">
            <span className="absolute left-[7px] top-2 bottom-2 w-px bg-antique-gold/25" aria-hidden="true" />
            {rows.map((s) => (
              <SessionRow
                key={s.session_id}
                session={s}
                busy={busyId === s.session_id}
                onStatus={(next) => setStatus(s.session_id, next)}
              />
            ))}
          </ol>
        ))}
    </div>
  );
}

function SessionRow({ session, busy, onStatus }) {
  const capacity = Number(session.capacity ?? 0);
  const booked = Number(session.booked_count ?? 0);
  const full = Number(session.available_slots ?? 0) <= 0;
  const cancelled = session.status === "cancelled";
  // Guarded so a zero-capacity session can never produce NaN width.
  const pct = capacity > 0 ? Math.min(100, Math.round((booked / capacity) * 100)) : 0;

  return (
    <li className="relative">
      <span
        aria-hidden="true"
        className={`absolute -left-[22px] top-6 h-2.5 w-2.5 rounded-full border-2 border-warm-ivory ${
          cancelled ? "bg-warm-grey/60" : full ? "bg-destructive" : session.status === "open" ? "bg-racing-green" : "bg-warm-grey/60"
        }`}
      />
      <Card className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="font-serif text-lg leading-tight text-charcoal">
            {fmtTime(session.start_time)} – {fmtTime(session.end_time)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusPill value={session.status} />
            {full && !cancelled && (
              <span className="font-sans text-[11px] tracking-[0.1em] text-destructive uppercase">Full</span>
            )}
          </div>
        </div>

        <div className="flex flex-1 items-center justify-end gap-5">
          <div className="w-40 max-w-full">
            <div className="flex items-baseline justify-between">
              <span className="font-sans text-sm text-charcoal">
                {booked} <span className="text-warm-grey">/ {capacity}</span>
              </span>
              <span className="font-sans text-[11px] text-warm-grey">{capacity > 0 ? `${pct}%` : "—"}</span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-charcoal/[0.08]">
              <div
                className={`h-full rounded-full ${full ? "bg-destructive" : "bg-racing-green"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-1 font-sans text-[11px] text-warm-grey/80">seats booked</p>
          </div>

          <select
            value={session.status}
            disabled={busy}
            aria-label="Session status"
            onChange={(e) => onStatus(e.target.value)}
            className="rounded-[10px] border border-antique-gold/25 bg-white px-2.5 py-2 font-sans text-xs text-charcoal outline-none transition-colors focus:border-antique-gold disabled:opacity-50"
          >
            {SESSION_STATUSES.map((v) => (
              <option key={v} value={v}>
                {titleCase(v)}
              </option>
            ))}
          </select>
        </div>
      </Card>
    </li>
  );
}

function GenerateSessions({ onGenerated, onClose }) {
  const [from, setFrom] = useState(istToday());
  const [to, setTo] = useState(addDays(istToday(), 13));
  const [state, setState] = useState({ busy: false, error: null, result: null });

  const submit = async (e) => {
    e.preventDefault();
    setState({ busy: true, error: null, result: null });
    const { data, error } = await adminApi.generateSessions(from, to);
    if (error) {
      setState({ busy: false, error, result: null });
      return;
    }
    setState({ busy: false, error: null, result: data ?? 0 });
    onGenerated();
  };

  return (
    <Card className="mb-6">
      <form onSubmit={submit}>
        <SectionHeader
          title="Generate sessions"
          hint="Creates sessions from the active schedule templates. Existing slots are left untouched, and capacity is derived server-side."
        />
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => e.target.value && setFrom(e.target.value)}
              className="mt-1.5 block rounded-[12px] border border-antique-gold/25 bg-white px-3 py-2.5 font-sans text-sm text-charcoal outline-none transition-colors focus:border-antique-gold"
            />
          </label>
          <label className="block">
            <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => e.target.value && setTo(e.target.value)}
              className="mt-1.5 block rounded-[12px] border border-antique-gold/25 bg-white px-3 py-2.5 font-sans text-sm text-charcoal outline-none transition-colors focus:border-antique-gold"
            />
          </label>
          <ActionButton type="submit" variant="primary" disabled={state.busy}>
            {state.busy ? "Generating…" : "Generate"}
          </ActionButton>
          <ActionButton variant="ghost" onClick={onClose}>
            Close
          </ActionButton>
        </div>

        {state.result != null && (
          <p className="mt-4 font-sans text-sm text-racing-green">
            {state.result} new session{state.result === 1 ? "" : "s"} created. Existing slots were left untouched.
          </p>
        )}
        {state.error && (
          <div className="mt-4 max-w-md">
            <InlineError message={state.error} />
          </div>
        )}
      </form>
    </Card>
  );
}
