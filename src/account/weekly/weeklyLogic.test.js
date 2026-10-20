import { describe, expect, it } from "vitest";
import {
  addDaysIso, buildWeekPicker, clock12, describeConfirm, friendlyRecurringError, groupByWeek, occurrenceState,
  previewSchedule, slotKey, timeRange12, toggleSlot, toRpcSlots, weekdayOf,
} from "./weeklyLogic";

// 2026-10-20 is a Tuesday.
const row = (date, start, end, over = {}) => ({ session_id: `s-${date}-${start}`, session_date: date, start_time: start, end_time: end, session_status: "open", capacity: 3, places_left: 3, ...over });
const WEEK = [
  row("2026-10-20", "17:00:00", "18:00:00"),
  row("2026-10-20", "06:30:00", "07:30:00"),
  row("2026-10-21", "18:00:00", "19:00:00", { places_left: 0 }),
  row("2026-10-25", "07:00:00", "08:00:00"),
  row("2026-10-26", "17:00:00", "18:00:00", { session_status: "cancelled" }),
];

describe("dates and times", () => {
  it("finds weekdays without timezone drift", () => {
    expect(weekdayOf("2026-10-20")).toBe(2);
    expect(weekdayOf("2026-10-25")).toBe(0);
    expect(addDaysIso("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("words times the way riders read them", () => {
    expect(clock12("17:00:00")).toBe("5:00 PM");
    expect(clock12("06:30")).toBe("6:30 AM");
    expect(clock12("12:00:00")).toBe("12:00 PM");
    expect(clock12("00:15:00")).toBe("12:15 AM");
    expect(timeRange12("17:00:00", "18:00:00")).toBe("5:00 PM – 6:00 PM");
  });
});

describe("weekly picker", () => {
  const picker = buildWeekPicker(WEEK);
  it("groups by weekday, Monday first and Sunday last, times in order", () => {
    expect(picker.map((d) => d.label)).toEqual(["Monday", "Tuesday", "Wednesday", "Sunday"]);
    expect(picker[1].slots.map((s) => s.startTime)).toEqual(["06:30:00", "17:00:00"]);
  });
  it("shows the next class's date and the places left, and flags full and closed times", () => {
    const tue5 = picker[1].slots[1];
    expect(tue5).toMatchObject({ key: slotKey(2, "17:00:00"), nextDate: "2026-10-20", placesLeft: 3, isFull: false, isClosed: false });
    expect(picker[2].slots[0]).toMatchObject({ placesLeft: 0, isFull: true });
  });
  it("keeps a cancelled class visible but unavailable", () => {
    const monday = buildWeekPicker([row("2026-10-26", "17:00:00", "18:00:00", { session_status: "cancelled" })]);
    expect(monday[0].slots[0]).toMatchObject({ isClosed: true, isFull: false });
  });
  it("uses the earliest date when a time appears twice", () => {
    const p = buildWeekPicker([row("2026-10-27", "17:00:00", "18:00:00"), row("2026-10-20", "17:00:00", "18:00:00")]);
    expect(p[0].slots[0].nextDate).toBe("2026-10-20");
  });
  it("copes with no rows", () => {
    expect(buildWeekPicker([])).toEqual([]);
    expect(buildWeekPicker(undefined)).toEqual([]);
  });
});

describe("choosing weekly slots", () => {
  it("adds, removes and stops at the plan's allowance", () => {
    let s = [];
    s = toggleSlot(s, "2|17:00", 2).selected;
    s = toggleSlot(s, "3|18:00", 2).selected;
    expect(s).toEqual(["2|17:00", "3|18:00"]);
    const third = toggleSlot(s, "0|07:00", 2);
    expect(third).toEqual({ selected: s, rejected: "limit" });
    expect(toggleSlot(s, "2|17:00", 2).selected).toEqual(["3|18:00"]);
  });
  it("Gold allows 2 and Platinum 4", () => {
    const keys = ["a", "b", "c", "d", "e"];
    const fill = (limit) => keys.reduce((sel, k) => toggleSlot(sel, k, limit).selected, []);
    expect(fill(2)).toHaveLength(2);
    expect(fill(4)).toHaveLength(4);
  });
  it("builds the server payload in day order from the chosen keys, ignoring unknown ones", () => {
    const picker = buildWeekPicker(WEEK);
    const slots = toRpcSlots([slotKey(0, "07:00:00"), slotKey(2, "17:00:00"), "9|99:99"], picker);
    expect(slots).toEqual([
      { day_of_week: 0, start_time: "07:00:00", end_time: "08:00:00" },
      { day_of_week: 2, start_time: "17:00:00", end_time: "18:00:00" },
    ]);
  });
});

describe("schedule preview (never more than the classes left, never past expiry)", () => {
  const tueWed = [
    { dayOfWeek: 2, startTime: "17:00:00", endTime: "18:00:00" },
    { dayOfWeek: 3, startTime: "18:00:00", endTime: "19:00:00" },
  ];
  it("Gold: 8 classes at 2 a week stops at exactly 8, over four weeks", () => {
    const out = previewSchedule({ slots: tueWed, from: "2026-10-20", validUntil: "2026-11-18", classesLeft: 8 });
    expect(out).toHaveLength(8);
    expect(out[0]).toMatchObject({ date: "2026-10-20", startTime: "17:00:00" });
    expect(out[7].date).toBe("2026-11-11");
    expect(groupByWeek(out).map((w) => w.classes.length)).toEqual([2, 2, 2, 2]);
  });
  it("only the classes that remain are previewed (7 left -> 7, never 8)", () => {
    expect(previewSchedule({ slots: tueWed, from: "2026-10-20", validUntil: "2026-11-18", classesLeft: 7 })).toHaveLength(7);
  });
  it("Platinum: 15 classes at 4 a week is 4, 4, 4, 3 and never a 16th", () => {
    const four = [
      { dayOfWeek: 2, startTime: "17:00:00", endTime: "18:00:00" },
      { dayOfWeek: 3, startTime: "17:00:00", endTime: "18:00:00" },
      { dayOfWeek: 5, startTime: "17:00:00", endTime: "18:00:00" },
      { dayOfWeek: 6, startTime: "17:00:00", endTime: "18:00:00" },
    ];
    const out = previewSchedule({ slots: four, from: "2026-10-20", validUntil: "2026-11-18", classesLeft: 15 });
    expect(out).toHaveLength(15);
    expect(groupByWeek(out).map((w) => w.classes.length)).toEqual([4, 4, 4, 3]);
    expect(previewSchedule({ slots: four, from: "2026-10-20", validUntil: "2026-11-18", classesLeft: 3 })).toHaveLength(3);
  });
  it("stops at the last valid day even when classes remain", () => {
    const out = previewSchedule({ slots: tueWed, from: "2026-10-20", validUntil: "2026-10-28", classesLeft: 8 });
    expect(out.map((c) => c.date)).toEqual(["2026-10-20", "2026-10-21", "2026-10-27", "2026-10-28"]);
    expect(out.every((c) => c.date <= "2026-10-28")).toBe(true);
  });
  it("nothing to preview without classes, slots or dates", () => {
    expect(previewSchedule({ slots: tueWed, from: "2026-10-20", validUntil: "2026-11-18", classesLeft: 0 })).toEqual([]);
    expect(previewSchedule({ slots: [], from: "2026-10-20", validUntil: "2026-11-18", classesLeft: 5 })).toEqual([]);
    expect(previewSchedule({ slots: tueWed, from: "2026-10-20", validUntil: null, classesLeft: 5 })).toEqual([]);
    expect(previewSchedule({ slots: tueWed, from: "2026-11-20", validUntil: "2026-11-18", classesLeft: 5 })).toEqual([]);
  });
});

describe("what each generated class means", () => {
  it("separates booked, full, out-of-classes and history", () => {
    expect(occurrenceState({ status: "booked", booking_status: "confirmed" }).tone).toBe("ok");
    expect(occurrenceState({ status: "skipped_full" })).toMatchObject({ tone: "wait", label: "Class was full" });
    expect(occurrenceState({ status: "skipped_no_credits" })).toMatchObject({ tone: "stop", label: "Not booked" });
    expect(occurrenceState({ status: "skipped_other" }).note).toMatch(/weekly limit/i);
    expect(occurrenceState({ status: "booked", booking_status: "completed" }).label).toBe("Ridden");
    expect(occurrenceState({ status: "booked", booking_status: "cancelled" }).label).toBe("Cancelled");
    expect(occurrenceState({ status: "replaced" }).label).toBe("Replaced");
  });
  it("an excused class offers a replacement only when the server says so", () => {
    expect(occurrenceState({ status: "booked", booking_status: "absent", can_replace: true }).label).toBe("Excused");
    expect(occurrenceState({ status: "booked", booking_status: "absent", can_replace: false }).label).toBe("Absent");
  });
});

describe("wording", () => {
  it("describes the confirmation in classes, never credits", () => {
    expect(describeConfirm({ booked: 8, skipped_full: 0, skipped_no_credits: 0 })).toBe("8 classes booked.");
    expect(describeConfirm({ booked: 1 })).toBe("1 class booked.");
    expect(describeConfirm({ booked: 3, skipped_full: 2, skipped_no_credits: 1 })).toMatch(/2 were full.*no classes left/);
    expect(describeConfirm({ booked: 0 })).toMatch(/saved/i);
    expect(describeConfirm({ booked: 3, skipped_no_credits: 1 })).not.toMatch(/credit/i);
  });
  it("words known errors, uses the server's limit message, hides raw database text", () => {
    expect(friendlyRecurringError({ message: "PLAN_NOT_RECURRING" })).toMatch(/doesn't include/);
    expect(friendlyRecurringError({ message: "TOO_MANY_SLOTS", details: "Gold allows up to 2 classes a week." })).toBe("Gold allows up to 2 classes a week.");
    expect(friendlyRecurringError({ message: 'duplicate key value violates unique constraint "x"' })).toBe("Something went wrong. Please try again.");
    expect(friendlyRecurringError(null)).toBe("Something went wrong. Please try again.");
  });
});
