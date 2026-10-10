import { useMemo, useState } from "react";
import { CalendarRange, RefreshCw } from "lucide-react";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import { ActionButton, DayPicker, Empty, ErrorBox, Loading, PageHeader, StatusPill, Toolbar } from "../ui";
import { fmtDate, fmtTime, groupRoster, istToday, titleCase } from "../adminUtils";

/**
 * Day schedule: every class of the day and who is riding in it.
 * Read-only view over admin_session_roster() (staff/admin only).
 */
export default function AdminSchedule() {
  const [date, setDate] = useState(istToday());
  const roster = useAdminQuery(() => adminApi.sessionRoster(date).then((r) => ({ data: r.data, error: r.error ? { message: r.error } : null })), [date]);

  const sessions = useMemo(() => groupRoster(roster.data), [roster.data]);

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
              const free = Math.max(s.capacity - s.riders.length, 0);
              return (
                <section key={s.id} className="rounded-[14px] border border-charcoal/10 bg-white">
                  <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-charcoal/[0.06] px-5 py-3.5">
                    <h2 className="font-serif text-lg text-charcoal">
                      {fmtTime(s.start)} – {fmtTime(s.end)}
                    </h2>
                    <div className="flex items-center gap-3">
                      <StatusPill value={s.status} />
                      <span className="font-sans text-xs text-warm-grey">
                        <span className="font-medium text-charcoal">{s.riders.length}</span> of {s.capacity} places booked
                      </span>
                    </div>
                  </header>
                  {s.riders.length === 0 ? (
                    <p className="px-5 py-4 font-sans text-sm text-warm-grey">No riders booked yet.</p>
                  ) : (
                    <ul className="divide-y divide-charcoal/[0.06]">
                      {s.riders.map((r) => (
                        <li key={r.booking_id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3">
                          <span className="min-w-0">
                            <span className="block font-sans text-sm font-medium text-charcoal">{r.customer_name || r.customer_email}</span>
                            <span className="mt-0.5 block font-sans text-xs text-warm-grey">
                              {r.plan_name} · {r.credits_remaining} credits · reschedules {r.reschedules_used}/{r.reschedules_allowed}
                              {r.reschedule_count > 0 ? " · moved from another slot" : ""}
                            </span>
                          </span>
                          <span className="flex items-center gap-3">
                            <StatusPill value={r.booking_status} />
                            <span className="font-sans text-xs text-warm-grey">{r.attendance_status ? titleCase(r.attendance_status) : "Pending"}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {s.riders.length > 0 && free > 0 && (
                    <p className="border-t border-charcoal/[0.06] px-5 py-2.5 font-sans text-xs text-racing-green">
                      {free} place{free === 1 ? "" : "s"} still free
                    </p>
                  )}
                </section>
              );
            })}
          </div>
        ))}
    </div>
  );
}
