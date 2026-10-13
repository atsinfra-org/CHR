import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import { ActionButton, Card, ErrorBox, InlineError, Loading, SectionHeader } from "../ui";

// Monday first, to match the booking calendar. Values are Postgres day numbers (0 = Sunday).
const DAYS = [
  [1, "Monday"],
  [2, "Tuesday"],
  [3, "Wednesday"],
  [4, "Thursday"],
  [5, "Friday"],
  [6, "Saturday"],
  [0, "Sunday"],
];

const hhmm = (t) => String(t).slice(0, 5);
const INPUT =
  "mt-1.5 block rounded-[10px] border border-antique-gold/25 bg-white px-3 py-2 font-sans text-sm text-charcoal outline-none transition-colors focus:border-antique-gold";

/**
 * The weekly timetable (admin only): the classes the club runs each week.
 * Sessions are generated from the active slots, so a change here applies to
 * classes generated from now on; classes already on the calendar keep their
 * time and are changed from the day view. A slot is switched off, not deleted.
 */
export default function TimetableEditor({ onClose }) {
  const { data, status, error, reload } = useAdminQuery(() =>
    supabase.from("schedule_templates").select("id, day_of_week, start_time, end_time, capacity, is_active").order("start_time")
  );
  const [adding, setAdding] = useState(null); // day number being added to

  const byDay = useMemo(() => {
    const map = new Map(DAYS.map(([d]) => [d, []]));
    for (const t of data ?? []) map.get(t.day_of_week)?.push(t);
    return map;
  }, [data]);

  return (
    <Card className="mb-6">
      <SectionHeader
        title="Weekly timetable"
        hint="The classes we run each week. New sessions are generated from the active slots; classes already on the calendar are not changed."
        action={
          <ActionButton variant="ghost" onClick={onClose}>
            Close
          </ActionButton>
        }
      />
      {status === "loading" && <Loading>Loading timetable…</Loading>}
      {status === "error" && <ErrorBox message={error} onRetry={reload} />}
      {status === "ready" && (
        <div className="divide-y divide-charcoal/[0.06]">
          {DAYS.map(([day, label]) => {
            const slots = byDay.get(day);
            return (
              <div key={day} className="py-3.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-serif text-lg text-charcoal">{label}</p>
                  <ActionButton variant="ghost" icon={Plus} onClick={() => setAdding(adding === day ? null : day)}>
                    Add slot
                  </ActionButton>
                </div>
                {slots.length === 0 && adding !== day && <p className="mt-1 font-sans text-xs text-warm-grey">No classes.</p>}
                <ul className="mt-2 space-y-2">
                  {slots.map((t) => (
                    <SlotRow key={`${t.id}:${t.start_time}:${t.end_time}:${t.capacity}:${t.is_active}`} template={t} onSaved={reload} />
                  ))}
                  {adding === day && (
                    <SlotRow
                      template={{ id: null, day_of_week: day, start_time: "07:00", end_time: "08:00", capacity: null, is_active: true }}
                      onSaved={() => {
                        setAdding(null);
                        reload();
                      }}
                      onCancel={() => setAdding(null)}
                    />
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function SlotRow({ template: t, onSaved, onCancel }) {
  const [form, setForm] = useState({ start: hhmm(t.start_time), end: hhmm(t.end_time), capacity: t.capacity ?? "" });
  const [state, setState] = useState({ busy: false, error: null });
  const isNew = !t.id;
  const dirty = isNew || form.start !== hhmm(t.start_time) || form.end !== hhmm(t.end_time) || String(form.capacity) !== String(t.capacity ?? "");
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async (active) => {
    setState({ busy: true, error: null });
    const capacity = String(form.capacity).trim() === "" ? null : Number(form.capacity);
    const { error } = await adminApi.saveTemplate(t.id, t.day_of_week, form.start, form.end, capacity, active);
    if (error) {
      setState({ busy: false, error });
      return;
    }
    setState({ busy: false, error: null });
    onSaved();
  };

  return (
    <li className={`rounded-[12px] border border-charcoal/[0.08] px-3 py-2.5 ${t.is_active ? "bg-white" : "bg-soft-cream/50"}`}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">Starts</span>
          <input type="time" value={form.start} onChange={set("start")} className={INPUT} />
        </label>
        <label className="block">
          <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">Ends</span>
          <input type="time" value={form.end} onChange={set("end")} className={INPUT} />
        </label>
        <label className="block">
          <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">Riders</span>
          <input type="number" min="1" max="12" step="1" value={form.capacity} placeholder="Default" onChange={set("capacity")} className={`${INPUT} w-24`} />
        </label>
        <ActionButton variant={dirty ? "primary" : "secondary"} disabled={!dirty || state.busy} onClick={() => save(t.is_active)}>
          {state.busy ? "Saving…" : isNew ? "Add" : "Save"}
        </ActionButton>
        {isNew ? (
          <ActionButton variant="ghost" onClick={onCancel}>
            Cancel
          </ActionButton>
        ) : (
          <ActionButton variant="ghost" disabled={state.busy || dirty} onClick={() => save(!t.is_active)}>
            {t.is_active ? "Switch off" : "Switch on"}
          </ActionButton>
        )}
        {!isNew && !t.is_active && <span className="pb-2.5 font-sans text-xs text-warm-grey">Off: no new classes are generated</span>}
      </div>
      {state.error && (
        <div className="mt-2 max-w-md">
          <InlineError message={state.error} />
        </div>
      )}
    </li>
  );
}
