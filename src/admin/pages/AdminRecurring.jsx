import { useMemo, useState } from "react";
import { Repeat, RefreshCw } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { useAdminQuery } from "../useAdminQuery";
import { ActionButton, Empty, ErrorBox, Loading, PageHeader, SearchField, SelectField, StatusPill, TableShell, Toolbar } from "../ui";
import { fmtDate } from "../adminUtils";
import { timeRange12, WEEKDAY_NAMES } from "../../account/weekly/weeklyLogic";

/**
 * Read-only view of every member's weekly schedule: who rides when, how many classes the plan holds and has
 * given out, and WHY a class was not booked. Nothing here changes a booking or a credit; the database does that
 * (generate_recurring_bookings runs daily). Reads use the existing staff/admin policies on the recurring tables.
 */
const SKIP_REASON = {
  skipped_full: "Class was full (retried until it starts)",
  skipped_no_credits: "Plan has no classes left",
  skipped_other: "Weekly limit already reached",
};

const loadSchedules = () =>
  supabase
    .from("recurring_schedules")
    .select(
      `id, status, end_reason, created_at, ended_at,
       profile:profiles(full_name),
       membership:memberships(end_date, total_credits, credits_remaining, plan:membership_plans(name)),
       slots:recurring_schedule_slots(day_of_week, start_time, end_time),
       occurrences:recurring_occurrences(id, status, session:class_sessions(session_date, start_time, end_time), booking:bookings!recurring_occurrences_booking_id_fkey(status))`
    )
    .order("created_at", { ascending: false })
    .limit(200);

export default function AdminRecurring() {
  const { data, status, error, reload } = useAdminQuery(loadSchedules);
  const [filter, setFilter] = useState("active");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? [])
      .filter((r) => filter === "all" || r.status === filter)
      .filter((r) => !needle || String(r.profile?.full_name ?? "").toLowerCase().includes(needle));
  }, [data, filter, q]);

  return (
    <div>
      <PageHeader route="recurring" actions={<ActionButton icon={RefreshCw} onClick={reload}>Refresh</ActionButton>} />
      <Toolbar>
        <SearchField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by member name" className="w-full sm:w-64" />
        <SelectField label="Status" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-full sm:w-44">
          <option value="active">Active</option>
          <option value="ended">Ended</option>
          <option value="all">All</option>
        </SelectField>
        <p className="font-sans text-xs text-warm-grey">A booking is a place in a class. The daily job books classes from each schedule until the plan ends or its classes run out.</p>
      </Toolbar>

      {status === "error" && <ErrorBox message={error} onRetry={reload} />}
      {status === "loading" && <Loading>Loading weekly schedules…</Loading>}
      {status === "ready" &&
        (rows.length === 0 ? (
          <Empty icon={Repeat} detail="Schedules appear here when a Gold or Platinum member sets their weekly times.">No weekly schedules</Empty>
        ) : (
          <TableShell head={["Member", "Plan", "Valid until", "Weekly times", "Classes", "Booked", "Not booked", "Status"]} minWidth="1040px">
            {rows.map((r) => <Row key={r.id} r={r} />)}
          </TableShell>
        ))}
    </div>
  );
}

function Row({ r }) {
  const total = Number(r.membership?.total_credits ?? 0);
  const left = Number(r.membership?.credits_remaining ?? 0);
  const occ = r.occurrences ?? [];
  const live = occ.filter((o) => o.status === "booked" && !["cancelled", "rescheduled"].includes(o.booking?.status ?? ""));
  const skipped = occ.filter((o) => SKIP_REASON[o.status]);
  const byReason = Object.entries(skipped.reduce((acc, o) => ({ ...acc, [o.status]: (acc[o.status] ?? 0) + 1 }), {}));
  const next = live
    .map((o) => o.session)
    .filter((s) => s?.session_date >= new Date().toISOString().slice(0, 10))
    .sort((a, b) => `${a.session_date}${a.start_time}`.localeCompare(`${b.session_date}${b.start_time}`))[0];
  return (
    <tr className="border-b border-charcoal/[0.06] align-top last:border-0 hover:bg-soft-cream/40">
      <td className="px-4 py-3.5 font-sans text-sm font-medium text-charcoal">{r.profile?.full_name || "—"}</td>
      <td className="px-4 py-3.5 font-sans text-sm text-warm-grey">{r.membership?.plan?.name ?? "—"}</td>
      <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">{r.membership?.end_date ? fmtDate(r.membership.end_date) : "—"}</td>
      <td className="px-4 py-3.5 font-sans text-sm text-charcoal">
        {(r.slots ?? []).slice().sort((a, b) => a.day_of_week - b.day_of_week).map((s) => (
          <div key={`${s.day_of_week}${s.start_time}`}>{WEEKDAY_NAMES[s.day_of_week]} {timeRange12(s.start_time, s.end_time)}</div>
        ))}
      </td>
      <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">{total - left} used · {left} left of {total}</td>
      <td className="px-4 py-3.5 font-sans text-sm text-charcoal">
        {live.length}
        {next && <div className="text-xs text-warm-grey">Next {fmtDate(next.session_date)}</div>}
      </td>
      <td className="px-4 py-3.5 font-sans text-sm text-charcoal">
        {skipped.length === 0 ? "—" : byReason.map(([k, n]) => <div key={k}>{n} · {SKIP_REASON[k]}</div>)}
      </td>
      <td className="px-4 py-3.5">
        <StatusPill value={r.status} />
        {r.status === "ended" && r.end_reason && <div className="mt-1 font-sans text-xs text-warm-grey">{r.end_reason.replace(/_/g, " ")}</div>}
      </td>
    </tr>
  );
}
