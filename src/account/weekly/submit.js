import { describeConfirm, friendlyRecurringError, hhmm, slotKey, weekdayOf, weeklySummary } from "./weeklyLogic";
import { todayISODate } from "../dashboardUtils";
import { friendlyBookingError } from "../bookingErrors";

/**
 * What happens when a member presses a booking button on the Book a class calendar. Two DIFFERENT things:
 *
 *   single  -> book_class(session)                    one dated class, nothing else is saved
 *   weekly  -> confirm_recurring_schedule(slots)      saves the weekly pattern; the database then books the dated classes
 *
 * A weekly request is only reported as saved after the schedule has been read back from the database and really contains
 * the chosen time. A success message is never shown for a one-off booking that was meant to repeat.
 */

/** The weekly slot a class belongs to: its weekday and its start/end time. */
export function slotOfSession(session) {
  const dayOfWeek = weekdayOf(session.session_date);
  return { dayOfWeek, startTime: session.start_time, endTime: session.end_time, key: slotKey(dayOfWeek, session.start_time) };
}

/**
 * The slot list to send: the member's current weekly times plus this one (the server replaces the pattern with what it
 * is given, so the existing times must be sent too). Refuses when the plan's weekly allowance would be exceeded.
 */
export function planWeeklySlots({ existingSlots = [], session, slotsPerWeek }) {
  if (!session) return { ok: false, code: "NO_SESSION" };
  const add = slotOfSession(session);
  const current = existingSlots.map((s) => ({ day_of_week: Number(s.day_of_week), start_time: s.start_time, end_time: s.end_time }));
  if (current.some((s) => slotKey(s.day_of_week, s.start_time) === add.key)) return { ok: true, alreadyThere: true, slots: current };
  if (current.length + 1 > slotsPerWeek) return { ok: false, code: "LIMIT", have: current.length, limit: slotsPerWeek };
  return { ok: true, alreadyThere: false, slots: [...current, { day_of_week: add.dayOfWeek, start_time: add.startTime, end_time: add.endTime }] };
}

/** The slots that remain after removing one, or null when none would remain (then the schedule should be stopped). */
export function slotsWithout(existingSlots, key) {
  const left = existingSlots.filter((s) => slotKey(s.day_of_week, s.start_time) !== key).map((s) => ({ day_of_week: Number(s.day_of_week), start_time: s.start_time, end_time: s.end_time }));
  return left.length ? left : null;
}

export function limitMessage(plan) {
  return `Your plan allows ${plan.limit} weekly time${plan.limit === 1 ? "" : "s"} and you already have ${plan.have}. Remove one from your weekly schedule first.`;
}

/**
 * Saves a weekly time. `api.confirm(slots)` calls confirm_recurring_schedule; `api.fetchSchedule()` reads
 * my_recurring_schedule. Both return { data, error }.
 */
export async function saveWeekly({ api, existingSlots, session, slotsPerWeek }) {
  const plan = planWeeklySlots({ existingSlots, session, slotsPerWeek });
  if (!plan.ok) return { ok: false, error: plan.code === "LIMIT" ? limitMessage(plan) : "Choose a class first." };

  const { data, error } = await api.confirm(plan.slots);
  if (error) return { ok: false, error: friendlyRecurringError(error) };

  // A returned success is not proof: read the schedule back and check the chosen time is really stored.
  const after = await api.fetchSchedule();
  if (after.error) return { ok: false, error: "We couldn't check that your weekly schedule was saved. Please look at your weekly schedule before booking again." };
  const wanted = slotOfSession(session).key;
  const saved = (after.data?.slots ?? []).some((s) => slotKey(s.day_of_week, s.start_time) === wanted);
  if (!saved) return { ok: false, error: "Your weekly schedule was not saved. Nothing was changed. Please try again." };

  return { ok: true, schedule: after.data, result: data, message: `Weekly schedule saved. ${describeConfirm(data)}`, summary: weeklySummary(after.data, todayISODate()) };
}

/** Books one class, and says so plainly: this does NOT save a weekly schedule. */
export async function bookSingle({ api, sessionId }) {
  const { error } = await api.book(sessionId);
  if (error) return { ok: false, error: friendlyBookingError(error), raw: error };
  return { ok: true, message: "Class booked" };
}

/** Removes one weekly time (or stops the schedule if it was the last one). Bookings already made stay. */
export async function removeWeeklySlot({ api, existingSlots, key }) {
  const left = slotsWithout(existingSlots, key);
  if (left === null) {
    const { error } = await api.stop();
    return error ? { ok: false, error: friendlyRecurringError(error) } : { ok: true, message: "Your weekly schedule has stopped. Classes already booked stay as they are." };
  }
  const { error } = await api.confirm(left);
  if (error) return { ok: false, error: friendlyRecurringError(error) };
  const after = await api.fetchSchedule();
  const stillThere = (after.data?.slots ?? []).some((s) => slotKey(s.day_of_week, s.start_time) === key);
  if (after.error || stillThere) return { ok: false, error: "That weekly time could not be removed. Please try again." };
  return { ok: true, message: "Weekly time removed. Classes already booked stay as they are." };
}

export { hhmm };
