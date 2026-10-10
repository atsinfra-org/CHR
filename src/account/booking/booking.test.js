import { describe, expect, it } from "vitest";
import { friendlyBookingError, isStaleSlotError } from "../bookingErrors";
import { addMonths, groupByPartOfDay, monthInRange, monthMatrix, monthOf, normaliseRows, placesText, slotState } from "./availability";
import { creditImpact, describeOutcome, rescheduleState } from "../dashboard/history";
import { daysBetween, formatClock, formatDayLong, formatDayShort, formatTimeRange, relativeDay, sessionInstant, startsIn } from "../dashboardUtils";
import { buildIcs } from "../../lib/ics";
import { notificationBody } from "../../lib/notificationText";
import { groupRoster } from "../../admin/adminUtils";

describe("booking errors", () => {
  it("a lost race reads as a retryable, stale-slot error", () => {
    const err = { message: "SLOT_NO_LONGER_AVAILABLE" };
    expect(friendlyBookingError(err)).toMatch(/just been taken/i);
    expect(friendlyBookingError({ message: "SESSION_FULL" })).toMatch(/filled up/i);
    expect(isStaleSlotError({ message: "SESSION_FULL" })).toBe(true);
    expect(isStaleSlotError(err)).toBe(true);
  });

  it("reschedule limit and no-classes errors are worded for riders", () => {
    expect(friendlyBookingError({ message: "RESCHEDULE_LIMIT_REACHED", details: "You have used all 2 reschedules on this membership." })).toMatch(/all 2/);
    expect(friendlyBookingError({ message: "NO_CREDITS_REMAINING" })).toMatch(/no classes left/i);
    expect(isStaleSlotError({ message: "NO_CREDITS_REMAINING" })).toBe(false);
  });

  it("unknown codes never leak raw database text", () => {
    expect(friendlyBookingError({ message: 'duplicate key value violates unique constraint "x"' })).toBe("Something went wrong. Please try again.");
  });
});

describe("availability as places in a class", () => {
  it("maps the RPC rows to the calendar shape", () => {
    const [s] = normaliseRows([{ session_id: "s9", session_date: "2026-10-14", start_time: "08:00:00", end_time: "09:00:00", session_status: "open", capacity: 3, places_left: 1, is_bookable: true, is_mine: false }]);
    expect(s).toMatchObject({ id: "s9", places_left: 1, status: "open", is_mine: false });
  });

  it("works out what a time slot is for the rider", () => {
    const open = { id: "a", status: "open", is_bookable: true, places_left: 2, is_mine: false };
    expect(slotState(open)).toBe("open");
    expect(slotState({ ...open, places_left: 0 })).toBe("full");
    expect(slotState({ ...open, is_mine: true })).toBe("mine");
    expect(slotState({ ...open, is_bookable: false })).toBe("closed");
    expect(slotState({ ...open, status: "cancelled" })).toBe("closed");
    expect(slotState(open, "a")).toBe("current");
  });

  it("words the places left", () => {
    expect(placesText({ places_left: 3 })).toBe("3 places left");
    expect(placesText({ places_left: 1 })).toBe("Last place");
    expect(placesText({ places_left: 0 })).toBe("Full");
  });

  it("groups times into morning and evening", () => {
    const groups = groupByPartOfDay([{ start_time: "07:00:00" }, { start_time: "08:00:00" }, { start_time: "16:00:00" }, { start_time: "18:00:00" }]);
    expect(groups.map(([label, list]) => [label, list.length])).toEqual([
      ["Morning", 2],
      ["Evening", 2],
    ]);
  });
});

describe("month calendar", () => {
  it("lays October 2026 out Monday-first (1 Oct is a Thursday)", () => {
    const weeks = monthMatrix(2026, 9);
    expect(weeks[0]).toEqual([null, null, null, "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });

  it("steps months across a year boundary and knows which months are bookable", () => {
    expect(addMonths({ year: 2026, monthIndex: 11 }, 1)).toEqual({ year: 2027, monthIndex: 0 });
    expect(monthOf("2026-10-10")).toEqual({ year: 2026, monthIndex: 9 });
    expect(monthInRange({ year: 2026, monthIndex: 10 }, "2026-10-10", "2026-11-09")).toBe(true);
    expect(monthInRange({ year: 2026, monthIndex: 11 }, "2026-10-10", "2026-11-09")).toBe(false);
    expect(monthInRange({ year: 2026, monthIndex: 8 }, "2026-10-10", "2026-11-09")).toBe(false);
  });
});

describe("day and time wording", () => {
  it("formats days and times the way people say them", () => {
    expect(formatDayShort("2026-10-09")).toBe("Fri 9 Oct");
    expect(formatDayLong("2026-10-15")).toBe("Thursday 15 October");
    expect(formatTimeRange("07:00:00", "08:00:00")).toBe("7 – 8 am");
    expect(formatTimeRange("11:00:00", "12:00:00")).toBe("11 am – 12 pm");
    expect(formatTimeRange("16:30:00", "17:30:00")).toBe("4:30 – 5:30 pm");
    expect(formatClock("18:00:00")).toBe("6 pm");
  });

  it("says today / tomorrow / the weekday, then falls back to the date", () => {
    expect(relativeDay("2026-10-10", "2026-10-10")).toBe("Today");
    expect(relativeDay("2026-10-11", "2026-10-10")).toBe("Tomorrow");
    expect(relativeDay("2026-10-14", "2026-10-10")).toBe("Wednesday");
    expect(relativeDay("2026-10-20", "2026-10-10")).toBe("Tue 20 Oct");
    expect(daysBetween("2026-10-10", "2026-11-02")).toBe(23);
  });

  it("counts down to a class in IST", () => {
    // 7:00 am IST on 11 Oct is 01:30 UTC
    expect(new Date(sessionInstant("2026-10-11", "07:00:00")).toISOString()).toBe("2026-10-11T01:30:00.000Z");
    const now = Date.UTC(2026, 9, 10, 11, 30); // 5:00 pm IST the day before
    expect(startsIn("2026-10-11", "07:00:00", now)).toBe("in 14 hours");
    expect(startsIn("2026-10-10", "17:30:00", now)).toBe("in 30 minutes");
    expect(startsIn("2026-10-14", "07:00:00", now)).toBe("in 4 days");
    expect(startsIn("2026-10-10", "16:00:00", now)).toBeNull();
  });
});

describe("class history wording", () => {
  it("attending is not a penalty", () => {
    expect(describeOutcome({ status: "completed", credit_ledger: [{ amount: -1, transaction_type: "booking" }] })).toMatchObject({ label: "Attended", note: "Used 1 class" });
  });

  it("an absence says whether the class came back", () => {
    const returned = { status: "absent", credit_ledger: [{ amount: -1, transaction_type: "booking" }, { amount: 1, transaction_type: "absence_restore" }] };
    expect(describeOutcome(returned).note).toBe("Class returned to your plan");
    expect(creditImpact(returned)).toBe(0);
    expect(describeOutcome({ status: "absent", credit_ledger: [{ amount: -1, transaction_type: "booking" }] }).note).toBe("Class not returned");
  });

  it("moved and cancelled classes are described plainly", () => {
    expect(describeOutcome({ status: "rescheduled", credit_ledger: [] }).label).toBe("Moved");
    expect(describeOutcome({ status: "cancelled", credit_ledger: [{ amount: -1, transaction_type: "booking" }] }).note).toBe("Class not returned");
    expect(describeOutcome({ status: "cancelled", credit_ledger: [{ amount: -1, transaction_type: "booking" }, { amount: 1, transaction_type: "cancellation" }] }).note).toBe("Class returned to your plan");
    expect(creditImpact({ credit_ledger: null })).toBe(0);
  });

  it("explains why a class can't be moved", () => {
    const plan = { reschedules_allowed: 2, reschedules_used: 1 };
    expect(rescheduleState({ reschedule_count: 0 }, plan)).toMatchObject({ canMove: true, remaining: 1 });
    expect(rescheduleState({ reschedule_count: 1 }, plan)).toEqual({ canMove: false, reason: "Already moved once" });
    expect(rescheduleState({ reschedule_count: 0 }, { reschedules_allowed: 2, reschedules_used: 2 })).toEqual({ canMove: false, reason: "No reschedules left" });
  });
});

describe("add to calendar", () => {
  it("writes the class in UTC so any calendar shows the right local time", () => {
    const ics = buildIcs({ uid: "b1", date: "2026-10-11", start: "07:00:00", end: "08:00:00", title: "Riding class — Colonel Horse Riding", location: "Guwahati, Assam", stamp: new Date(Date.UTC(2026, 9, 10, 12, 0, 0)) });
    expect(ics).toContain("DTSTART:20261011T013000Z");
    expect(ics).toContain("DTEND:20261011T023000Z");
    expect(ics).toContain("LOCATION:Guwahati\\, Assam");
    expect(ics.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(ics.split("\r\n").at(-1)).toBe("END:VCALENDAR");
    expect(ics).not.toMatch(/Midnight|Storm|Duke/);
  });
});

describe("notification text", () => {
  it("cuts a trailing name off booking notifications written before 0022", () => {
    expect(notificationBody({ type: "booking_confirmed", body: "Sun 11 Oct 07:00–08:00 · Storm" })).toBe("Sun 11 Oct 07:00–08:00");
    expect(notificationBody({ type: "class_reminder", body: "Sun 11 Oct 07:00–08:00 · Storm" })).toBe("Sun 11 Oct 07:00–08:00");
    expect(notificationBody({ type: "booking_created", body: "Rahul Kumar · Sun 11 Oct 07:00–08:00 · Storm" })).toBe("Rahul Kumar · Sun 11 Oct 07:00–08:00");
  });

  it("leaves current and unrelated notifications exactly as written", () => {
    expect(notificationBody({ type: "booking_confirmed", body: "Sun 11 Oct 07:00–08:00" })).toBe("Sun 11 Oct 07:00–08:00");
    expect(notificationBody({ type: "booking_created", body: "Rahul Kumar · Sun 11 Oct 07:00–08:00" })).toBe("Rahul Kumar · Sun 11 Oct 07:00–08:00");
    expect(notificationBody({ type: "booking_cancelled", body: "Sun 11 Oct 07:00–08:00 · credit not returned" })).toBe("Sun 11 Oct 07:00–08:00 · credit not returned");
    expect(notificationBody({ type: "order_paid", body: null })).toBeNull();
  });
});

describe("admin roster grouping", () => {
  const base = { start_time: "07:00:00", end_time: "08:00:00", session_status: "open" };

  it("groups riders under their class and keeps an empty class", () => {
    const sessions = groupRoster([
      { ...base, session_id: "s1", capacity: 3, booking_id: "b1", customer_name: "Rahul" },
      { ...base, session_id: "s1", capacity: 3, booking_id: "b2", customer_name: "Priya" },
      { ...base, session_id: "s2", capacity: 2, booking_id: null, start_time: "08:00:00", end_time: "09:00:00" },
    ]);
    expect(sessions.map((s) => [s.id, s.capacity, s.riders.length])).toEqual([["s1", 3, 2], ["s2", 2, 0]]);
    expect(sessions[0].riders.map((r) => r.customer_name)).toEqual(["Rahul", "Priya"]);
  });

  it("counts rows as places when the older roster shape carries no capacity", () => {
    const [s] = groupRoster([
      { ...base, session_id: "s1", booking_id: "b1" },
      { ...base, session_id: "s1", booking_id: null },
      { ...base, session_id: "s1", booking_id: null },
    ]);
    expect(s.capacity).toBe(3);
    expect(s.riders).toHaveLength(1);
  });

  it("returns nothing for no data", () => {
    expect(groupRoster(null)).toEqual([]);
  });
});
