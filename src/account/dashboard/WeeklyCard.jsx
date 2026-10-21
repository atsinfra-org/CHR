import { useEffect, useState } from "react";
import { Repeat } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { formatDayShort } from "../dashboardUtils";
import { occurrenceState, timeRange12, WEEKDAY_NAMES } from "../weekly/weeklyLogic";
import { Card, SectionHeader } from "../ui";

/**
 * A quiet summary of the weekly schedule on the dashboard: the pattern, and how the next classes stand.
 * Shown only for plans that allow a weekly schedule. A failed or empty load shows nothing rather than an error,
 * because the dashboard is useful without it.
 */
export default function WeeklyCard({ slotsPerWeek }) {
  const [schedule, setSchedule] = useState(undefined);

  useEffect(() => {
    let live = true;
    supabase.rpc("my_recurring_schedule").then(({ data, error }) => {
      if (live) setSchedule(error ? null : data ?? null);
    });
    return () => {
      live = false;
    };
  }, []);

  if (schedule === undefined || slotsPerWeek <= 0) return null;
  const upcoming = (schedule?.occurrences ?? []).filter((o) => o.status === "booked" && !["cancelled", "rescheduled", "completed", "no_show", "absent"].includes(o.booking_status ?? "")).slice(0, 3);
  const notBooked = (schedule?.occurrences ?? []).filter((o) => ["skipped_full", "skipped_no_credits", "skipped_other"].includes(o.status)).length;

  return (
    <Card>
      <SectionHeader
        title="Weekly schedule"
        hint={schedule ? `Until ${formatDayShort(schedule.valid_until) ?? "your plan ends"}` : "Ride the same days each week without booking one by one."}
        action={
          <a href="/account/book" className="inline-flex items-center gap-1.5 font-sans text-xs tracking-[0.12em] text-racing-green uppercase underline underline-offset-4">
            <Repeat size={14} strokeWidth={1.75} />
            {schedule ? "Manage" : "Set up"}
          </a>
        }
      />
      {schedule ? (
        <>
          <p className="font-sans text-sm text-charcoal">
            {(schedule.slots ?? []).map((s) => `${WEEKDAY_NAMES[s.day_of_week]} ${timeRange12(s.start_time, s.end_time)}`).join(" · ")}
          </p>
          {upcoming.length > 0 && (
            <ul className="mt-3 space-y-1 font-sans text-xs text-warm-grey">
              {upcoming.map((o) => (
                <li key={o.occurrence_id}>
                  {formatDayShort(o.session_date)} · {timeRange12(o.start_time, o.end_time)} · {occurrenceState(o).label}
                </li>
              ))}
            </ul>
          )}
          {notBooked > 0 && <p className="mt-3 font-sans text-xs text-warning">{notBooked} class{notBooked === 1 ? "" : "es"} could not be booked. See the details on the schedule page.</p>}
        </>
      ) : null}
    </Card>
  );
}
