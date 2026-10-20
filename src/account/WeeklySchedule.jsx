import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, CheckCircle2, Repeat } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import AccountStateGuard from "./AccountStateGuard";
import { useBookingEligibility } from "./useBookingEligibility";
import { useMembershipStatus } from "./useMembershipStatus";
import { formatDayLong, formatDayShort, todayISODate } from "./dashboardUtils";
import {
  addDaysIso, buildWeekPicker, describeConfirm, friendlyRecurringError, groupByWeek, occurrenceState, previewSchedule,
  slotKey, timeRange12, toggleSlot, toRpcSlots, WEEKDAY_NAMES,
} from "./weekly/weeklyLogic";
import { ActionButton, Card, CardSkeleton, ConfirmDialog, EmptyState, ErrorState, InlineError, PageHeader, SectionHeader, useToast } from "./ui";

/**
 * Weekly schedule: pick the weekdays and times you ride, and the club books those classes week after week until
 * your plan ends or your classes run out.
 *
 * A presentation layer only. What is booked, what is full and how many classes remain are decided by the database
 * (confirm_recurring_schedule, my_recurring_schedule, session_availability_range); a class is only taken off the
 * plan in the same transaction that books it. Saving a preference or opening this page never uses a class.
 * A booking is a place in a class: the coach assigns horses at the ground.
 */
export default function WeeklySchedule() {
  return <AccountStateGuard active="weekly">{({ user }) => <Weekly user={user} />}</AccountStateGuard>;
}

function PageShell({ children }) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <PageHeader title="Weekly schedule" description="Choose the days and times you ride. We book them for you each week, for as long as your plan lasts." />
      {children}
    </div>
  );
}

function Weekly({ user }) {
  const eligibility = useBookingEligibility(user?.id);
  const membership = useMembershipStatus(user?.id);
  const [reloadKey, setReloadKey] = useState(0);
  const [mine, setMine] = useState({ status: "loading", data: null, error: null });
  const [week, setWeek] = useState({ status: "loading", rows: [], error: null });

  useEffect(() => {
    let live = true;
    const today = todayISODate();
    supabase.rpc("my_recurring_schedule").then(({ data, error }) => {
      if (!live) return;
      setMine(error ? { status: "error", data: null, error: friendlyRecurringError(error) } : { status: "ready", data: data ?? null, error: null });
    });
    supabase.rpc("session_availability_range", { p_from: today, p_to: addDaysIso(today, 6) }).then(({ data, error }) => {
      if (!live) return;
      setWeek(error ? { status: "error", rows: [], error: friendlyRecurringError(error) } : { status: "ready", rows: data ?? [], error: null });
    });
    return () => {
      live = false;
    };
  }, [reloadKey]);

  const refresh = useCallback(() => {
    eligibility.retry();
    membership.retry();
    setReloadKey((k) => k + 1);
  }, [eligibility, membership]);

  if (!eligibility.data && (eligibility.status === "loading" || eligibility.status === "idle")) {
    return (
      <PageShell>
        <CardSkeleton lines={3} />
      </PageShell>
    );
  }
  if (eligibility.status === "error") {
    return (
      <PageShell>
        <ErrorState title="We couldn't load your plan" detail={eligibility.error} onRetry={eligibility.retry} />
      </PageShell>
    );
  }
  const elig = eligibility.data;
  if (!elig?.has_active_membership) {
    return (
      <PageShell>
        <EmptyState icon={CalendarClock} title="You need a plan to set a weekly schedule" detail="Choose a plan in the store. Once your payment is confirmed you can set your weekly times here."
          action={<ActionButton href="/store" variant="primary">Go to store</ActionButton>} />
      </PageShell>
    );
  }
  const slotsPerWeek = Number(membership.plan?.recurring_slots_per_week ?? 0);
  if (membership.status !== "loading" && slotsPerWeek <= 0) {
    return (
      <PageShell>
        <EmptyState icon={CalendarClock} title="Your plan books one class at a time" detail="A weekly schedule is part of the Gold and Platinum memberships. You can still book any class you like."
          action={<ActionButton href="/account/book" variant="primary">Book a class</ActionButton>} />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PlanStrip elig={elig} membership={membership} slotsPerWeek={slotsPerWeek} />
      {mine.status === "error" || week.status === "error" ? (
        <ErrorState title="We couldn't load your weekly schedule" detail={mine.error || week.error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : mine.status === "loading" || week.status === "loading" ? (
        <CardSkeleton lines={4} />
      ) : (
        <Planner key={`${mine.data?.schedule_id ?? "none"}:${(mine.data?.slots ?? []).map((x) => `${x.day_of_week}${x.start_time}`).join(",")}`} elig={elig} slotsPerWeek={slotsPerWeek} schedule={mine.data} weekRows={week.rows} onChanged={refresh} />
      )}
    </PageShell>
  );
}

/** Plan, entitlement, classes left and expiry, from the same records the booking page uses. */
function PlanStrip({ elig, membership, slotsPerWeek }) {
  const total = membership.record?.total_credits ?? membership.plan?.class_credits ?? null;
  const left = Number(elig.credits_remaining ?? 0);
  return (
    <div className="mb-8 border-y border-antique-gold/25 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1">
        <p className="font-serif text-xl text-charcoal">{membership.plan?.name ?? "Your plan"}</p>
        <p className="font-sans text-sm text-warm-grey">
          <span className="font-medium text-charcoal">{left}{total ? ` of ${total}` : ""}</span> class{left === 1 ? "" : "es"} left · valid until{" "}
          {formatDayShort(elig.membership_end_date) ?? "—"}
        </p>
      </div>
      <p className="mt-1.5 font-sans text-xs text-warm-grey">Up to {slotsPerWeek} class{slotsPerWeek === 1 ? "" : "es"} a week. Classes you have not booked yet are never used.</p>
      {left <= 0 && <p className="mt-3 font-sans text-sm text-warning">You have used every class on this plan. Choose another plan in the store to keep riding.</p>}
    </div>
  );
}

function Planner({ elig, slotsPerWeek, schedule, weekRows, onChanged }) {
  const notify = useToast();
  const picker = useMemo(() => buildWeekPicker(weekRows), [weekRows]);
  const existingKeys = useMemo(() => (schedule?.slots ?? []).map((s) => slotKey(s.day_of_week, s.start_time)), [schedule]);
  const [editing, setEditing] = useState(!schedule);
  const [selected, setSelected] = useState(existingKeys);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [outcome, setOutcome] = useState(null);

  const classesLeft = Number(elig.credits_remaining ?? 0);
  const chosen = toRpcSlots(selected, picker).map((s) => ({ dayOfWeek: s.day_of_week, startTime: s.start_time, endTime: s.end_time }));
  const preview = previewSchedule({ slots: chosen, from: todayISODate(), validUntil: elig.membership_end_date, classesLeft });
  const previewWeeks = groupByWeek(preview);
  const changed = selected.slice().sort().join() !== existingKeys.slice().sort().join();
  const canSave = selected.length > 0 && (schedule ? changed || classesLeft > 0 : classesLeft > 0);

  const pick = (key) => {
    setError(null);
    const next = toggleSlot(selected, key, slotsPerWeek);
    if (next.rejected === "limit") setError(`Your plan allows up to ${slotsPerWeek} class${slotsPerWeek === 1 ? "" : "es"} a week. Remove a time to choose another.`);
    setSelected(next.selected);
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc("confirm_recurring_schedule", { p_slots: toRpcSlots(selected, picker) });
    setBusy(false);
    setConfirmOpen(false);
    if (rpcError) {
      setError(friendlyRecurringError(rpcError));
      return;
    }
    setOutcome(describeConfirm(data));
    notify("Weekly schedule saved", "success");
    onChanged();
  };

  const stop = async () => {
    setBusy(true);
    const { error: rpcError } = await supabase.rpc("end_recurring_schedule");
    setBusy(false);
    setStopOpen(false);
    if (rpcError) {
      setError(friendlyRecurringError(rpcError));
      return;
    }
    setOutcome("Your weekly schedule has stopped. Classes already booked stay as they are.");
    onChanged();
  };

  return (
    <div>
      {outcome && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-racing-green/25 bg-racing-green/[0.06] px-5 py-4">
          <p className="flex items-center gap-2.5 font-sans text-sm text-racing-green"><CheckCircle2 size={17} strokeWidth={1.75} />{outcome}</p>
          <a href="/account/classes" className="font-sans text-xs tracking-[0.12em] text-racing-green uppercase underline underline-offset-4">See my classes</a>
        </div>
      )}

      {schedule && <CurrentSchedule schedule={schedule} editing={editing} onEdit={() => setEditing(true)} onStop={() => setStopOpen(true)} onCancelEdit={() => { setSelected(existingKeys); setEditing(false); setError(null); }} />}

      {editing && (
        <div className="mt-2">
          <SectionHeader title={schedule ? "Change your weekly times" : "Choose your weekly times"}
            hint={`Pick up to ${slotsPerWeek}. Each time shows the next class on that day and the places left.`} />
          {picker.length === 0 ? (
            <EmptyState icon={CalendarClock} title="No classes are open yet" detail="The timetable for the coming days isn't published. Please check back soon." />
          ) : (
            <div className="space-y-3">
              {picker.map((day) => (
                <div key={day.dayOfWeek} className="rounded-[14px] border border-antique-gold/20 bg-white px-4 py-3.5 sm:px-5">
                  <p className="font-serif text-base text-charcoal">{day.label}</p>
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    {day.slots.map((s) => {
                      const on = selected.includes(s.key);
                      const unavailable = s.isClosed;
                      return (
                        <button key={s.key} type="button" aria-pressed={on} disabled={unavailable} onClick={() => pick(s.key)}
                          className={`min-h-[44px] rounded-[10px] border px-3.5 py-2 text-left font-sans transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-racing-green ${
                            on ? "border-racing-green bg-racing-green text-warm-ivory" : unavailable ? "cursor-not-allowed border-charcoal/10 bg-charcoal/[0.03] text-warm-grey/60" : "border-antique-gold/35 bg-white text-charcoal hover:border-antique-gold"
                          }`}>
                          <span className="block text-sm font-medium">{timeRange12(s.startTime, s.endTime)}</span>
                          <span className={`block text-[11px] ${on ? "text-warm-ivory/75" : "text-warm-grey"}`}>
                            {unavailable ? "Not running" : s.isFull ? `Full on ${formatDayShort(s.nextDate)} · we keep trying` : s.placesLeft === 1 ? "Last place" : `${s.placesLeft} places left`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && <div className="mt-5"><InlineError message={error} /></div>}

          <div className="z-10 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-[16px] border border-antique-gold/25 bg-white/95 px-5 py-4 shadow-[0_18px_40px_-24px_rgba(8,28,21,0.25)] sm:sticky sm:bottom-4">
            <p className="font-sans text-sm text-warm-grey">
              <span className="font-medium text-charcoal">{selected.length} of {slotsPerWeek}</span> times chosen
              {selected.length > 0 && <span className="ml-2 text-xs">· about {preview.length} class{preview.length === 1 ? "" : "es"} until your plan ends</span>}
            </p>
            <ActionButton variant="primary" icon={Repeat} disabled={!canSave} onClick={() => setConfirmOpen(true)}>Review and confirm</ActionButton>
          </div>
        </div>
      )}

      <ConfirmDialog open={confirmOpen} title="Confirm your weekly schedule?"
        description={<Preview weeks={previewWeeks} total={preview.length} classesLeft={classesLeft} slots={toRpcSlots(selected, picker)} validUntil={elig.membership_end_date} />}
        confirmLabel="Confirm schedule" busy={busy} onConfirm={confirm} onClose={() => !busy && setConfirmOpen(false)} />
      <ConfirmDialog open={stopOpen} title="Stop your weekly schedule?" description="No new classes will be booked. Classes you already have stay booked and keep their place."
        confirmLabel="Stop schedule" danger busy={busy} onConfirm={stop} onClose={() => !busy && setStopOpen(false)} />
    </div>
  );
}

/** What confirming does, in plain words, before anything is booked. */
function Preview({ weeks, total, classesLeft, slots, validUntil }) {
  if (!slots.length) return null;
  return (
    <div className="space-y-3 text-left">
      <p>
        We will book {slots.map((s) => `${WEEKDAY_NAMES[s.day_of_week]} ${timeRange12(s.start_time, s.end_time)}`).join(" and ")} each week until{" "}
        {formatDayShort(validUntil) ?? "your plan ends"}, or until your {classesLeft} remaining class{classesLeft === 1 ? "" : "es"} {classesLeft === 1 ? "is" : "are"} used.
      </p>
      <p className="text-xs">
        Expected: about {total} class{total === 1 ? "" : "es"}, never more than you have left. A class that is full is skipped and tried again; a class is only used when it is actually booked.
      </p>
      <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
        {weeks.flatMap((w) => w.classes).slice(0, 24).map((c) => (
          <li key={`${c.date}-${c.startTime}`}>{formatDayLong(c.date)} · {timeRange12(c.startTime, c.endTime)}</li>
        ))}
      </ul>
    </div>
  );
}

function CurrentSchedule({ schedule, editing, onEdit, onStop, onCancelEdit }) {
  const occurrences = schedule.occurrences ?? [];
  const weeks = groupByWeek(occurrences.map((o) => ({ ...o, date: o.session_date })));
  return (
    <Card className="mb-8">
      <SectionHeader title="Your weekly schedule"
        hint={`Until ${formatDayShort(schedule.valid_until) ?? "your plan ends"} · ${schedule.credits_remaining} class${Number(schedule.credits_remaining) === 1 ? "" : "es"} left`}
        action={!editing ? (
          <div className="flex gap-2"><ActionButton onClick={onEdit}>Change</ActionButton><ActionButton variant="danger" onClick={onStop}>Stop</ActionButton></div>
        ) : <ActionButton variant="ghost" onClick={onCancelEdit}>Cancel</ActionButton>} />
      <p className="mb-4 font-sans text-sm text-charcoal">
        {(schedule.slots ?? []).map((s) => `${WEEKDAY_NAMES[s.day_of_week]} ${timeRange12(s.start_time, s.end_time)}`).join(" · ")}
      </p>
      {weeks.length === 0 ? (
        <p className="font-sans text-sm text-warm-grey">No classes have been booked from this schedule yet. They are added each day as the timetable opens.</p>
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
