import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Admin → Weekly schedules: route registration and every page state (static markup, query hook stubbed).
vi.mock("../lib/supabaseClient", () => ({ supabase: { from: () => ({}) } }));
let hookState = { data: null, status: "loading", error: null, reload: () => {} };
vi.mock("./useAdminQuery", () => ({ useAdminQuery: () => hookState }));

const { default: AdminRecurring } = await import("./pages/AdminRecurring.jsx");
const { VALID_ROUTES } = await import("./useAdminRoute.js");
const { PAGE_META } = await import("./adminNav.js");

const render = (state) => { hookState = { reload: () => {}, error: null, data: null, ...state }; return renderToStaticMarkup(<AdminRecurring />); };
const occ = (id, status, date, bookingStatus = null) => ({ id, status, session: { session_date: date, start_time: "17:00:00", end_time: "18:00:00" }, booking: bookingStatus ? { status: bookingStatus } : null });
const schedule = (o = {}) => ({
  id: "s1", status: "active", end_reason: null, created_at: "2026-10-20T00:00:00Z",
  profile: { full_name: "Asha Rao" },
  membership: { end_date: "2026-11-18", total_credits: 8, credits_remaining: 5, plan: { name: "Gold Membership" } },
  slots: [{ day_of_week: 3, start_time: "18:00:00", end_time: "19:00:00" }, { day_of_week: 2, start_time: "17:00:00", end_time: "18:00:00" }],
  occurrences: [occ("o1", "booked", "2099-01-05", "confirmed"), occ("o2", "booked", "2099-01-06", "cancelled"), occ("o3", "skipped_full", "2099-01-07"), occ("o4", "skipped_no_credits", "2099-01-08")],
  ...o,
});

describe("Admin → Weekly schedules", () => {
  it("is a registered route with a title", () => {
    expect(VALID_ROUTES).toContain("recurring");
    expect(PAGE_META.recurring?.title).toBe("Weekly schedules");
  });
  it("loading, error and empty states", () => {
    expect(render({ status: "loading" })).toContain("Loading weekly schedules");
    const err = render({ status: "error", error: "Boom" });
    expect(err).toContain("Boom");
    expect(err).toContain("Retry");
    expect(render({ status: "ready", data: [] })).toContain("No weekly schedules");
  });
  it("shows member, plan, validity, the weekly times in day order, and classes used and left", () => {
    const out = render({ status: "ready", data: [schedule()] });
    expect(out).toContain("Asha Rao");
    expect(out).toContain("Gold Membership");
    expect(out.indexOf("Tuesday")).toBeLessThan(out.indexOf("Wednesday"));
    expect(out).toContain("5:00 PM – 6:00 PM");
    expect(out).toContain("3 used · 5 left of 8");
  });
  it("counts only live bookings and says why a class was not booked", () => {
    const out = render({ status: "ready", data: [schedule()] });
    expect(out).toContain("Class was full");
    expect(out).toContain("Plan has no classes left");
    expect(out).toMatch(/<td[^>]*>1<div/); // one live booking: the cancelled one is not counted
  });
  it("never mentions horses", () => {
    expect(render({ status: "ready", data: [schedule()] }).toLowerCase()).not.toContain("horse");
  });
  it("hides ended schedules by default", () => {
    expect(render({ status: "ready", data: [schedule({ status: "ended", end_reason: "member_ended" })] })).toContain("No weekly schedules");
  });
});
