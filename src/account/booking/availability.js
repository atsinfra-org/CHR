import { supabase } from "../../lib/supabaseClient";

/**
 * Session availability for the booking calendar.
 *
 * A booking is a place in a class: riders choose a day and a time, and this
 * module only ever speaks of "places left". Reads go through the
 * session_availability() RPC.
 */

/** One row per session from session_availability(). */
export function normaliseRows(rows) {
  return (rows ?? []).map((r) => ({
    id: r.session_id,
    session_date: r.session_date,
    start_time: r.start_time,
    end_time: r.end_time,
    status: r.session_status,
    capacity: r.capacity,
    places_left: r.places_left,
    is_bookable: r.is_bookable,
    is_mine: r.is_mine,
  }));
}

export async function fetchDaySessions(date) {
  const { data, error } = await supabase.rpc("session_availability", { p_date: date });
  if (error) return { sessions: [], error };
  return { sessions: normaliseRows(data), error: null };
}

/** Dates in [min, max] that have at least one open session (class_sessions is publicly readable). */
export async function fetchRidingDays(min, max) {
  const { data, error } = await supabase.from("class_sessions").select("session_date").eq("status", "open").gte("session_date", min).lte("session_date", max);
  if (error) return null; // unknown: the calendar then treats every day in range as selectable
  return new Set((data ?? []).map((r) => r.session_date));
}

/** Dates in [min, max] on which the signed-in rider already has a class (own rows via RLS). */
export async function fetchMyBookedDays(min, max) {
  const { data, error } = await supabase
    .from("bookings")
    .select("class_sessions!inner(session_date)")
    .in("status", ["held", "confirmed"])
    .gte("class_sessions.session_date", min)
    .lte("class_sessions.session_date", max);
  if (error) return new Set();
  return new Set((data ?? []).map((r) => r.class_sessions?.session_date).filter(Boolean));
}

/** What a time slot is, from the rider's point of view. */
export function slotState(session, currentSessionId = null) {
  if (currentSessionId && session.id === currentSessionId) return "current";
  if (session.is_mine) return "mine";
  if (session.status !== "open" || !session.is_bookable) return "closed";
  if (session.places_left <= 0) return "full";
  return "open";
}

export function placesText(session) {
  if (session.places_left <= 0) return "Full";
  if (session.places_left === 1) return "Last place";
  return `${session.places_left} places left`;
}

export function partOfDay(startTime) {
  const hour = Number(String(startTime).split(":")[0]);
  if (hour < 12) return "Morning";
  if (hour < 16) return "Afternoon";
  return "Evening";
}

/** Groups sessions as [["Morning", [...]], ["Evening", [...]]] in time order. */
export function groupByPartOfDay(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const key = partOfDay(s.start_time);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return [...groups.entries()];
}

const pad = (n) => String(n).padStart(2, "0");
export const isoOf = (year, monthIndex, day) => `${year}-${pad(monthIndex + 1)}-${pad(day)}`;

/** Weeks of a month, Monday first; cells are "YYYY-MM-DD" or null for padding. */
export function monthMatrix(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
  const cells = [...Array(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => isoOf(year, monthIndex, i + 1))];
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** { year, monthIndex } of an ISO date. */
export function monthOf(iso) {
  const [y, m] = iso.split("-").map(Number);
  return { year: y, monthIndex: m - 1 };
}

export function addMonths({ year, monthIndex }, delta) {
  const d = new Date(Date.UTC(year, monthIndex + delta, 1));
  return { year: d.getUTCFullYear(), monthIndex: d.getUTCMonth() };
}

/** Is any day of this month inside [min, max]? */
export function monthInRange({ year, monthIndex }, min, max) {
  const start = isoOf(year, monthIndex, 1);
  const end = isoOf(year, monthIndex, new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate());
  return end >= min && start <= max;
}
