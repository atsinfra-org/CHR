import { describe, expect, it } from "vitest";
import { friendlyBookingError, isStaleSlotError } from "../bookingErrors";
import { buildDateRange, groupSessions } from "./SlotPicker";
import { creditImpact } from "../dashboard/ClassHistory";

describe("booking errors", () => {
  it("a lost horse race reads as a retryable, stale-slot error", () => {
    const err = { message: "SLOT_NO_LONGER_AVAILABLE" };
    expect(friendlyBookingError(err)).toMatch(/just booked/i);
    expect(isStaleSlotError(err)).toBe(true);
  });

  it("reschedule limit and no-credit errors are worded for members", () => {
    expect(friendlyBookingError({ message: "RESCHEDULE_LIMIT_REACHED", details: "You have used all 2 reschedules on this membership." })).toMatch(/all 2/);
    expect(friendlyBookingError({ message: "NO_CREDITS_REMAINING" })).toMatch(/no class credits/i);
    expect(isStaleSlotError({ message: "NO_CREDITS_REMAINING" })).toBe(false);
  });

  it("unknown codes never leak raw database text", () => {
    expect(friendlyBookingError({ message: 'duplicate key value violates unique constraint "x"' })).toBe("Something went wrong. Please try again.");
  });
});

describe("slot grid", () => {
  const rows = [
    { session_id: "s1", session_date: "2026-10-13", start_time: "07:00:00", end_time: "08:00:00", session_status: "open", capacity: 3, booked_count: 1, available_count: 2, is_bookable: true, horse_id: "h1", horse_name: "Duke", horse_state: "available" },
    { session_id: "s1", session_date: "2026-10-13", start_time: "07:00:00", end_time: "08:00:00", session_status: "open", capacity: 3, booked_count: 1, available_count: 2, is_bookable: true, horse_id: "h2", horse_name: "Midnight", horse_state: "booked" },
    { session_id: "s1", session_date: "2026-10-13", start_time: "07:00:00", end_time: "08:00:00", session_status: "open", capacity: 3, booked_count: 1, available_count: 2, is_bookable: true, horse_id: "h3", horse_name: "Storm", horse_state: "available" },
  ];

  it("folds session × horse rows into one session with three horses", () => {
    const [s] = groupSessions(rows);
    expect(groupSessions(rows)).toHaveLength(1);
    expect(s.horses.map((h) => h.horse_state)).toEqual(["available", "booked", "available"]);
    expect(s.available_count).toBe(2);
  });

  it("date range is inclusive and bounded", () => {
    expect(buildDateRange("2026-10-07", "2026-10-09")).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
    expect(buildDateRange("2026-10-07", "2027-10-07").length).toBeLessThanOrEqual(60);
    expect(buildDateRange(null, null)).toEqual([]);
  });
});

describe("class history credit impact", () => {
  it("sums a booking's own ledger rows: book (-1) then absent restore (+1) = 0", () => {
    expect(creditImpact({ credit_ledger: [{ amount: -1 }, { amount: 1 }] })).toBe(0);
  });
  it("attended class keeps the credit consumed", () => {
    expect(creditImpact({ credit_ledger: [{ amount: -1 }] })).toBe(-1);
  });
  it("a reschedule row has no credit effect", () => {
    expect(creditImpact({ credit_ledger: [{ amount: 0 }] })).toBe(0);
    expect(creditImpact({ credit_ledger: null })).toBe(0);
  });
});
