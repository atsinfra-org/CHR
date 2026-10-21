import { formatDayLong, formatDayShort } from "../dashboardUtils";
import { groupByWeek, occurrenceState, slotKey, timeRange12, WEEKDAY_NAMES } from "./weeklyLogic";
import { ActionButton, Card, SectionHeader } from "../ui";

/**
 * The member's saved weekly schedule, shown on the Book a class page: the weekly times (each removable), then the dated
 * classes the club has booked from them, with the reason for any class that could not be booked.
 */
export default function CurrentSchedule({ schedule, busy, onRemoveSlot, onStop }) {
  const occurrences = schedule.occurrences ?? [];
  const weeks = groupByWeek(occurrences.map((o) => ({ ...o, date: o.session_date })));
  const left = Number(schedule.credits_remaining ?? 0);
  return (
    <Card className="mb-8">
      <SectionHeader
        title="Your weekly schedule"
        hint={`Booked automatically until ${formatDayShort(schedule.valid_until) ?? "your plan ends"} · ${left} class${left === 1 ? "" : "es"} left`}
        action={<ActionButton variant="danger" disabled={busy} onClick={onStop}>Stop</ActionButton>}
      />
      <ul className="mb-4 flex flex-wrap gap-2">
        {(schedule.slots ?? []).map((s) => {
          const key = slotKey(s.day_of_week, s.start_time);
          return (
            <li key={key} className="flex items-center gap-2 rounded-[10px] border border-antique-gold/35 bg-white py-1.5 pl-3 pr-1.5 font-sans text-sm text-charcoal">
              Every {WEEKDAY_NAMES[s.day_of_week]} · {timeRange12(s.start_time, s.end_time)}
              <button type="button" disabled={busy} onClick={() => onRemoveSlot(key)} aria-label={`Remove ${WEEKDAY_NAMES[s.day_of_week]} ${timeRange12(s.start_time, s.end_time)} from your weekly schedule`}
                className="min-h-[32px] rounded-[8px] px-2 font-sans text-xs text-warm-grey hover:text-destructive disabled:opacity-50">Remove</button>
            </li>
          );
        })}
      </ul>
      {weeks.length === 0 ? (
        <p className="font-sans text-sm text-warm-grey">No dated classes have been booked from this schedule yet. They are added as the timetable opens, until your plan ends.</p>
      ) : (
        <div className="space-y-4">
          {weeks.map((w) => (
            <div key={w.weekStart}>
              <p className="mb-1.5 font-sans text-[10.5px] tracking-[0.18em] text-antique-gold uppercase">Week of {formatDayShort(w.weekStart)}</p>
              <ul className="divide-y divide-antique-gold/15 border-y border-antique-gold/15">
                {w.classes.map((o) => {
                  const st = occurrenceState(o);
                  const tone = { ok: "text-racing-green", wait: "text-warning", stop: "text-destructive", past: "text-warm-grey" }[st.tone];
                  return (
                    <li key={o.occurrence_id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
                      <span className="font-sans text-sm text-charcoal">{formatDayLong(o.session_date)} · {timeRange12(o.start_time, o.end_time)}</span>
                      <span className={`font-sans text-xs ${tone}`}>{st.label}{st.note ? ` · ${st.note}` : ""}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
