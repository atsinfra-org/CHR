import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bookSingle, planWeeklySlots, removeWeeklySlot, saveWeekly, slotOfSession, slotsWithout } from "./submit";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(here, rel), "utf8");

// 2026-10-20 is a Tuesday, 2026-10-21 a Wednesday.
const tue = { id: "s-tue", session_date: "2026-10-20", start_time: "17:00:00", end_time: "18:00:00" };
const wed = { id: "s-wed", session_date: "2026-10-21", start_time: "18:00:00", end_time: "19:00:00" };
const sun = { id: "s-sun", session_date: "2026-10-25", start_time: "07:00:00", end_time: "08:00:00" };
const slot = (dow, s, e) => ({ day_of_week: dow, start_time: s, end_time: e });

/** A fake of the database's weekly functions that REALLY stores the slots it is given, like confirm_recurring_schedule. */
function fakeDb({ stored = [], confirmError = null, dropOnSave = false, fetchError = null } = {}) {
  const db = { slots: stored.map((s) => ({ ...s })), calls: [] };
  db.api = {
    confirm: async (slots) => {
      db.calls.push(["confirm_recurring_schedule", slots]);
      if (confirmError) return { data: null, error: confirmError };
      if (!dropOnSave) db.slots = slots.map((s) => ({ ...s }));
      return { data: { booked: 6, skipped_full: 0, skipped_no_credits: 0 }, error: null };
    },
    fetchSchedule: async () => {
      db.calls.push(["my_recurring_schedule"]);
      return fetchError ? { data: null, error: fetchError } : { data: db.slots.length ? { slots: db.slots } : null, error: null };
    },
    stop: async () => { db.calls.push(["end_recurring_schedule"]); db.slots = []; return { data: 1, error: null }; },
    book: async (id) => { db.calls.push(["book_class", id]); return { data: { id: "b1" }, error: null }; },
  };
  return db;
}

describe("weekly saving and the single booking are different calls", () => {
  it("a plan with no weekly allowance (One-Time Ride) still books a single class through book_class, and never claims a weekly schedule", async () => {
    const db = fakeDb();
    const out = await bookSingle({ api: db.api, sessionId: tue.id });
    expect(db.calls).toEqual([["book_class", "s-tue"]]);
    expect(out).toEqual({ ok: true, message: "Class booked" });
    expect(db.slots).toEqual([]); // no weekly schedule exists afterwards
  });
  it("Repeat every week saves the weekly pattern through confirm_recurring_schedule and does not call book_class", async () => {
    const db = fakeDb();
    const out = await saveWeekly({ api: db.api, existingSlots: [], session: tue, slotsPerWeek: 2 });
    expect(db.calls.map((c) => c[0])).toEqual(["confirm_recurring_schedule", "my_recurring_schedule"]);
    expect(db.calls[0][1]).toEqual([slot(2, "17:00:00", "18:00:00")]);
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/^Weekly schedule saved\. 6 classes booked\.$/);
    expect(db.slots).toHaveLength(1);
  });
  it("a second weekly time is added to the first (the server replaces the pattern, so both are sent)", async () => {
    const db = fakeDb({ stored: [slot(2, "17:00:00", "18:00:00")] });
    const out = await saveWeekly({ api: db.api, existingSlots: db.slots, session: wed, slotsPerWeek: 2 });
    expect(out.ok).toBe(true);
    expect(db.calls[0][1]).toEqual([slot(2, "17:00:00", "18:00:00"), slot(3, "18:00:00", "19:00:00")]);
    expect(db.slots).toHaveLength(2);
  });
});

describe("limits are checked before anything is sent", () => {
  it("Gold (2) and Platinum (4) allowances", () => {
    const two = [slot(2, "17:00:00", "18:00:00"), slot(3, "18:00:00", "19:00:00")];
    expect(planWeeklySlots({ existingSlots: two, session: sun, slotsPerWeek: 2 })).toMatchObject({ ok: false, code: "LIMIT", have: 2, limit: 2 });
    const four = [...two, slot(4, "17:00:00", "18:00:00"), slot(5, "17:00:00", "18:00:00")];
    expect(planWeeklySlots({ existingSlots: two, session: sun, slotsPerWeek: 4 }).ok).toBe(true);
    expect(planWeeklySlots({ existingSlots: four, session: sun, slotsPerWeek: 4 })).toMatchObject({ ok: false, code: "LIMIT" });
  });
  it("a refused add sends nothing and says what to do", async () => {
    const db = fakeDb({ stored: [slot(2, "17:00:00", "18:00:00"), slot(3, "18:00:00", "19:00:00")] });
    const out = await saveWeekly({ api: db.api, existingSlots: db.slots, session: sun, slotsPerWeek: 2 });
    expect(db.calls).toEqual([]);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("Your plan allows 2 weekly times and you already have 2. Remove one from your weekly schedule first.");
  });
  it("choosing a time that is already in the schedule changes nothing about the pattern", () => {
    const plan = planWeeklySlots({ existingSlots: [slot(2, "17:00:00", "18:00:00")], session: tue, slotsPerWeek: 2 });
    expect(plan).toMatchObject({ ok: true, alreadyThere: true });
    expect(plan.slots).toHaveLength(1);
  });
  it("the slot is the class's weekday and its own start and end times", () => {
    expect(slotOfSession(tue)).toMatchObject({ dayOfWeek: 2, startTime: "17:00:00", endTime: "18:00:00", key: "2|17:00" });
    expect(slotOfSession(sun).dayOfWeek).toBe(0);
  });
});

describe("a weekly save is only a success if it really was saved (no false success)", () => {
  it("a database error is shown as an actionable message and nothing is claimed", async () => {
    for (const [code, text] of [["TOO_MANY_SLOTS", /allows up to 2 classes a week/], ["PLAN_NOT_RECURRING", /doesn't include/], ["NO_ACTIVE_MEMBERSHIP", /active plan/], ["NO_CREDITS_REMAINING", /no classes left/], ["INVALID_SLOTS", /isn't available/]]) {
      const db = fakeDb({ confirmError: { message: code, details: "Gold allows up to 2 classes a week." } });
      const out = await saveWeekly({ api: db.api, existingSlots: [], session: tue, slotsPerWeek: 2 });
      expect(out.ok, code).toBe(false);
      expect(out.error, code).toMatch(text);
      expect(db.calls.map((c) => c[0]), code).toEqual(["confirm_recurring_schedule"]);
    }
  });
  it("raw database text is never shown", async () => {
    const db = fakeDb({ confirmError: { message: 'duplicate key value violates unique constraint "uq_recurring"' } });
    const out = await saveWeekly({ api: db.api, existingSlots: [], session: tue, slotsPerWeek: 2 });
    expect(out.error).toBe("Something went wrong. Please try again.");
  });
  it("a success reply that did not actually store the time is reported as NOT saved", async () => {
    const db = fakeDb({ dropOnSave: true });
    const out = await saveWeekly({ api: db.api, existingSlots: [], session: tue, slotsPerWeek: 2 });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/was not saved/);
    expect(out.message).toBeUndefined();
  });
  it("if the schedule cannot be read back, it does not claim success", async () => {
    const db = fakeDb({ fetchError: { message: "network" } });
    const out = await saveWeekly({ api: db.api, existingSlots: [], session: tue, slotsPerWeek: 2 });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/couldn't check/);
  });
  it("the confirmation text says classes booked, skipped-full and out-of-classes honestly", async () => {
    const db = fakeDb();
    db.api.confirm = async (slots) => { db.slots = slots; return { data: { booked: 3, skipped_full: 2, skipped_no_credits: 1 }, error: null }; };
    const out = await saveWeekly({ api: db.api, existingSlots: [], session: tue, slotsPerWeek: 2 });
    expect(out.message).toMatch(/^Weekly schedule saved\. 3 classes booked\. 2 were full\. We keep trying until they start\. The rest could not be booked because your plan has no classes left\.$/);
    db.api.confirm = async (slots) => { db.slots = slots; return { data: { booked: 0 }, error: null }; };
    expect((await saveWeekly({ api: db.api, existingSlots: [], session: tue, slotsPerWeek: 2 })).message).toMatch(/No new classes were booked this time/);
  });
  it("a failed one-off booking is reported as an error, not a success", async () => {
    const api = { book: async () => ({ data: null, error: { message: "SESSION_FULL" } }) };
    const out = await bookSingle({ api, sessionId: "x" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/filled up/);
    expect(out.raw.message).toBe("SESSION_FULL");
  });
});

describe("managing the weekly schedule from the Book a class page", () => {
  const two = [slot(2, "17:00:00", "18:00:00"), slot(3, "18:00:00", "19:00:00")];
  it("removing one time re-saves the rest and checks it is gone", async () => {
    const db = fakeDb({ stored: two });
    const out = await removeWeeklySlot({ api: db.api, existingSlots: two, key: "3|18:00" });
    expect(out.ok).toBe(true);
    expect(db.calls[0][1]).toEqual([slot(2, "17:00:00", "18:00:00")]);
    expect(db.slots).toHaveLength(1);
  });
  it("removing the last time stops the schedule", async () => {
    const db = fakeDb({ stored: [two[0]] });
    expect(slotsWithout([two[0]], "2|17:00")).toBeNull();
    const out = await removeWeeklySlot({ api: db.api, existingSlots: [two[0]], key: "2|17:00" });
    expect(out.ok).toBe(true);
    expect(db.calls.map((c) => c[0])).toEqual(["end_recurring_schedule"]);
    expect(out.message).toMatch(/Classes already booked stay/);
  });
  it("a removal that did not take effect is reported", async () => {
    const db = fakeDb({ stored: two, dropOnSave: true });
    const out = await removeWeeklySlot({ api: db.api, existingSlots: two, key: "3|18:00" });
    expect(out.ok).toBe(false);
  });
});

describe("the Book a class page is wired to the weekly flow (regression: it used to call book_class only)", () => {
  const page = src("../BookClasses.jsx");
  it("offers both actions and routes the weekly one through saveWeekly", () => {
    expect(page).not.toMatch(/Book this class only/i);
    expect(page).not.toMatch(/one class, or repeat/i);
    expect(page).toContain("Repeat every week");
    expect(page).toContain("saveWeekly(");
    expect(page).toContain("bookSingle("); // still used by plans that cannot repeat (One-Time Ride)
    expect(page).toContain('if (canRepeat && confirmMode !== "weekly") return;'); // a repeating plan can never book a lone class here
    expect(page).not.toMatch(/supabase\.rpc\("book_class"[^;]*\);\s*\n\s*setBusy\(false\);\s*\n\s*setConfirmOpen/); // the old one-way handler
  });
  it("shows the weekly choice only when the plan allows a schedule, from the plan's own record", () => {
    expect(page).toContain("recurring_slots_per_week");
    expect(page).toContain("canRepeat");
  });
  it("shows a weekly success banner only from a saved schedule, with a different message from a single booking", () => {
    expect(page).toMatch(/finish\(out\.message, true, out\.summary\)/);
    expect(page).toMatch(/finish\(`You're booked for \$\{when\}\.`, false\)/);
    expect(page).not.toMatch(/horse picker|choose your horse/i);
  });
  it("there is no second weekly entry point: no sidebar item and no separate page", () => {
    expect(src("../MemberLayout.jsx")).not.toContain("/account/weekly");
    expect(src("../AccountApp.jsx")).not.toContain("WeeklySchedule");
    expect(src("../AccountApp.jsx")).toContain('window.location.replace("/account/book")');
    expect(fs.existsSync(path.join(here, "../WeeklySchedule.jsx"))).toBe(false);
    expect(src("../dashboard/WeeklyCard.jsx")).toContain('href="/account/book"');
  });
  it("My Classes keeps up to 40 upcoming classes so a Platinum schedule (15) is never cut off", () => {
    expect(src("../useMemberDashboard.js")).toMatch(/\.limit\(40\)/);
  });
});
