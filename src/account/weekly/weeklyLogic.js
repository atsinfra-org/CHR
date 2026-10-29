/**
 * Pure helpers for the weekly-schedule screen. They only shape and word what the database returns
 * (session_availability_range, my_recurring_schedule, confirm_recurring_schedule). The database alone decides
 * what is booked, what is full and how many classes remain; nothing here changes an entitlement or a balance.
 * A class is a place, never a horse.
 */

// Monday first, because that is how a week reads; the club's own days come from the timetable.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const parseIso = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const toIso = (date) => date.toISOString().slice(0, 10);

export const addDaysIso = (iso, days) => toIso(new Date(parseIso(iso).getTime() + days * 86400000));
export const weekdayOf = (iso) => parseIso(iso).getUTCDay();

/** "17:00:00" -> "17:00" (the key the server matches on is the full time, this is for display and comparison). */
export const hhmm = (t) => String(t ?? "").slice(0, 5);

export function clock12(t) {
  const [h, m] = hhmm(t).split(":").map(Number);
  if (Number.isNaN(h)) return "";
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

export const timeRange12 = (start, end) => `${clock12(start)} – ${clock12(end)}`;

/** The stable identity of a weekly slot, matching the database's own (day_of_week, start_time) key. */
export const slotKey = (dayOfWeek, startTime) => `${dayOfWeek}|${hhmm(startTime)}`;

/**
 * Turns one week of availability rows (session_availability_range) into the weekday -> times picker.
 * Each time shows the NEXT class on that weekday: its date and the places left. Cancelled or closed classes
 * are kept, flagged unavailable, so the member sees why a time cannot be chosen.
 */
export function buildWeekPicker(rows) {
  const byDay = new Map();
  for (const r of rows ?? []) {
    const dow = weekdayOf(r.session_date);
    const key = slotKey(dow, r.start_time);
    const open = r.session_status === "open" || r.session_status === undefined;
    const slot = {
      key,
      dayOfWeek: dow,
      startTime: r.start_time,
      endTime: r.end_time,
      nextDate: r.session_date,
      placesLeft: Number(r.places_left ?? 0),
      capacity: Number(r.capacity ?? 0),
      isFull: open && Number(r.places_left ?? 0) <= 0,
      isClosed: !open,
    };
    if (!byDay.has(dow)) byDay.set(dow, new Map());
    const existing = byDay.get(dow).get(key);
    if (!existing || slot.nextDate < existing.nextDate) byDay.get(dow).set(key, slot);
  }
  return WEEK_ORDER.filter((d) => byDay.has(d)).map((d) => ({
    dayOfWeek: d,
    label: WEEKDAY_NAMES[d],
    slots: [...byDay.get(d).values()].sort((a, b) => hhmm(a.startTime).localeCompare(hhmm(b.startTime))),
  }));
}

/**
 * Toggles a slot in the selection. A member may choose at most `limit` weekly slots (the plan's allowance).
 * Returns { selected, rejected } where rejected is "limit" when adding would exceed it.
 */
export function toggleSlot(selected, key, limit) {
  if (selected.includes(key)) return { selected: selected.filter((k) => k !== key), rejected: null };
  if (selected.length >= limit) return { selected, rejected: "limit" };
  return { selected: [...selected, key], rejected: null };
}

/** The payload confirm_recurring_schedule expects, from the chosen keys. */
export function toRpcSlots(selectedKeys, picker) {
  const all = new Map(picker.flatMap((d) => d.slots).map((s) => [s.key, s]));
  return selectedKeys
    .map((k) => all.get(k))
    .filter(Boolean)
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || hhmm(a.startTime).localeCompare(hhmm(b.startTime)))
    .map((s) => ({ day_of_week: s.dayOfWeek, start_time: s.startTime, end_time: s.endTime }));
}

/**
 * A PREVIEW of what a weekly pattern is expected to produce: the selected weekdays from `from` onward, in date
 * order, stopping at the last valid day or when the remaining classes run out. It is an estimate for the member
 * to read before confirming. The server books the real classes, skips full ones (retrying until they start) and
 * never goes past the plan; a class that is full or not yet created is simply not booked.
 */
export function previewSchedule({ slots, from, validUntil, classesLeft, maxDays = 120 }) {
  const out = [];
  if (!slots?.length || !from || !validUntil || classesLeft <= 0) return out;
  const wanted = new Map();
  for (const s of slots) {
    const list = wanted.get(s.dayOfWeek) ?? [];
    list.push(s);
    wanted.set(s.dayOfWeek, list);
  }
  for (let i = 0; i <= maxDays && out.length < classesLeft; i += 1) {
    const date = addDaysIso(from, i);
    if (date > validUntil) break;
    const todays = (wanted.get(weekdayOf(date)) ?? []).slice().sort((a, b) => hhmm(a.startTime).localeCompare(hhmm(b.startTime)));
    for (const s of todays) {
      if (out.length >= classesLeft) break;
      out.push({ date, startTime: s.startTime, endTime: s.endTime });
    }
  }
  return out;
}

/** Groups a preview into calendar weeks (Monday start) for display: [{ weekStart, classes }]. */
export function groupByWeek(items) {
  const weeks = new Map();
  for (const it of items) {
    const dow = weekdayOf(it.date);
    const monday = addDaysIso(it.date, dow === 0 ? -6 : 1 - dow);
    if (!weeks.has(monday)) weeks.set(monday, []);
    weeks.get(monday).push(it);
  }
  return [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([weekStart, classes]) => ({ weekStart, classes }));
}

/**
 * What one generated class means to the member. `occurrence` comes from my_recurring_schedule().
 * Tone: "ok" (a class is booked), "wait" (not booked yet, may still be), "stop" (final), "past" (history).
 */
export function occurrenceState(o) {
  const booking = o?.booking_status ?? null;
  if (o?.status === "skipped_full") return { tone: "wait", label: "Class was full", note: "We keep trying until it starts." };
  if (o?.status === "skipped_no_credits") return { tone: "stop", label: "Not booked", note: "Your plan has no classes left for this one." };
  if (o?.status === "skipped_other") return { tone: "stop", label: "Not booked", note: "The weekly limit was already reached that week." };
  if (o?.status === "replaced") return { tone: "past", label: "Replaced", note: "You used the class we gave back." };
  if (booking === "cancelled" || booking === "rescheduled") return { tone: "stop", label: booking === "cancelled" ? "Cancelled" : "Moved", note: "" };
  if (booking === "completed") return { tone: "past", label: "Ridden", note: "" };
  if (booking === "no_show" || booking === "absent") {
    return o?.can_replace
      ? { tone: "wait", label: "Excused", note: "Your class was given back. You can book a replacement." }
      : { tone: "past", label: booking === "no_show" ? "Missed" : "Absent", note: "" };
  }
  return { tone: "ok", label: "Booked", note: "" };
}

/** Words the result of confirm_recurring_schedule for the member (classes, never credits). */
export function describeConfirm(result) {
  const booked = Number(result?.booked ?? 0);
  const full = Number(result?.skipped_full ?? 0);
  const none = Number(result?.skipped_no_credits ?? 0);
  const parts = [booked === 0 ? "Your weekly schedule is saved. No new classes were booked this time." : `${booked} class${booked === 1 ? "" : "es"} booked.`];
  if (full > 0) parts.push(`${full} ${full === 1 ? "was" : "were"} full. We keep trying until ${full === 1 ? "it starts" : "they start"}.`);
  if (none > 0) parts.push("The rest could not be booked because your plan has no classes left.");
  return parts.join(" ");
}

/**
 * After a weekly save: which dated classes the schedule now holds, and why it stops where it does, so a short plan
 * doesn't look like "only one date was booked". `schedule` is my_recurring_schedule(); `today` an ISO date.
 * Returns { dates: [{date, startTime, endTime}], stop: "plan_end" | "no_classes" | null, validUntil, classesLeft }.
 */
export function weeklySummary(schedule, today) {
  const live = (schedule?.occurrences ?? [])
    .filter((o) => o.status === "booked" && ["confirmed", "held"].includes(o.booking_status ?? "confirmed") && o.session_date >= today)
    .sort((a, b) => `${a.session_date}${a.start_time}`.localeCompare(`${b.session_date}${b.start_time}`))
    .map((o) => ({ date: o.session_date, startTime: o.start_time, endTime: o.end_time }));
  const classesLeft = Number(schedule?.credits_remaining ?? 0);
  const validUntil = schedule?.valid_until ?? null;
  return { dates: live, stop: classesLeft <= 0 ? "no_classes" : validUntil ? "plan_end" : null, validUntil, classesLeft };
}

const RECURRING_ERRORS = {
  NOT_AUTHENTICATED: "Your session has expired. Please sign in again.",
  NO_ACTIVE_MEMBERSHIP: "You don't have an active plan.",
  PLAN_NOT_RECURRING: "Your plan doesn't include a weekly schedule.",
  NO_CREDITS_REMAINING: "You have no classes left on your plan.",
  INVALID_SLOTS: "One of those times isn't available. Please choose again.",
  TOO_MANY_SLOTS: null, // uses the server's own wording (it names the plan and the limit)
};

/** Rider-facing wording for the weekly-schedule errors; unknown database text is never shown. */
export function friendlyRecurringError(error) {
  const code = error?.message?.trim();
  if (code && Object.prototype.hasOwnProperty.call(RECURRING_ERRORS, code)) return RECURRING_ERRORS[code] ?? error?.details ?? "You've chosen more times than your plan allows.";
  return "Something went wrong. Please try again.";
}
