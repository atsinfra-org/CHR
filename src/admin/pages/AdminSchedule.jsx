import { useMemo, useState } from "react";
import { CalendarRange, RefreshCw } from "lucide-react";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import { ActionButton, DayPicker, Empty, ErrorBox, Loading, PageHeader, StatusPill, Toolbar } from "../ui";
import { fmtDate, fmtTime, istToday, titleCase } from "../adminUtils";

/**
 * Day schedule: every session with its three horses and who is on each.
 * Read-only view over admin_session_roster() (staff/admin only).
 */
export default function AdminSchedule() {
  const [date, setDate] = useState(istToday());
  const roster = useAdminQuery(() => adminApi.sessionRoster(date).then((r) => ({ data: r.data, error: r.error ? { message: r.error } : null })), [date]);

  const sessions = useMemo(() => {
    const map = new Map();
    for (const r of roster.data ?? []) {
      if (!map.has(r.session_id)) map.set(r.session_id, { id: r.session_id, start: r.start_time, end: r.end_time, status: r.session_status, rows: [] });
      map.get(r.session_id).rows.push(r);
    }
    return [...map.values()];
  }, [roster.data]);

  return (
    <div>
      <PageHeader
        route="schedule"
        actions={
          <ActionButton icon={RefreshCw} onClick={roster.reload}>
            Refresh
          </ActionButton>
        }
      />
      <Toolbar>
        <DayPicker value={date} onChange={setDate} />
      </Toolbar>

      {roster.status === "error" && <ErrorBox message={roster.error} onRetry={roster.reload} />}
      {roster.status === "loading" && <Loading>Loading schedule…</Loading>}
      {roster.status === "ready" &&
        (sessions.length === 0 ? (
          <Empty icon={CalendarRange} detail="We ride Tuesday to Sunday.">
            No sessions on {fmtDate(date)}
          </Empty>
        ) : (
          <div className="space-y-4">
            {sessions.map((s) => {
              const taken = s.rows.filter((r) => r.booking_id).length;
              return (
                <section key={s.id} className="rounded-[14px] border border-charcoal/10 bg-white">
                  <header className="flex items-center justify-between border-b border-charcoal/[0.06] px-5 py-3.5">
                    <h2 className="font-serif text-lg text-charcoal">
                      {fmtTime(s.start)} – {fmtTime(s.end)}
                    </h2>
                    <div className="flex items-center gap-3">
                      <StatusPill value={s.status} />
                      <span className="font-sans text-xs text-warm-grey">
                        {taken} / {s.rows.length} horses booked
                      </span>
                    </div>
                  </header>
                  <ul className="divide-y divide-charcoal/[0.06]">
                    {s.rows.map((r) => (
                      <li key={r.horse_id} className="grid grid-cols-1 gap-1 px-5 py-3 sm:grid-cols-[140px_1fr_auto] sm:items-center sm:gap-4">
                        <span className="font-sans text-sm font-medium text-charcoal">{r.horse_name}</span>
                        {r.booking_id ? (
                          <span className="font-sans text-sm text-charcoal">
                            {r.customer_name || r.customer_email}
                            <span className="ml-2 font-sans text-xs text-warm-grey">
                              {r.plan_name} · {r.credits_remaining} credits · reschedules {r.reschedules_used}/{r.reschedules_allowed}
                              {r.reschedule_count > 0 ? " · moved from another slot" : ""}
                            </span>
                          </span>
                        ) : (
                          <span className="font-sans text-sm text-racing-green">
                            {r.horse_status === "available" ? "Available" : titleCase(r.horse_status)}
                          </span>
                        )}
                        {r.booking_id && (
                          <span className="flex items-center gap-3">
                            <StatusPill value={r.booking_status} />
                            <span className="font-sans text-xs text-warm-grey">{r.attendance_status ? titleCase(r.attendance_status) : "Pending"}</span>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        ))}
    </div>
  );
}
