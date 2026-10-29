import { describe, expect, it } from "vitest";
import { pickActivePlans } from "./useMembershipStatus";

const gold = (o = {}) => ({ id: "gold", status: "active", credits_remaining: 3, end_date: "2026-11-08", created_at: "2026-10-09T00:00:00Z", plan: { name: "Gold Membership", recurring_slots_per_week: 2 }, ...o });
const ride = (o = {}) => ({ id: "ride", status: "active", credits_remaining: 0, end_date: "2026-11-28", created_at: "2026-10-29T08:11:00Z", plan: { name: "One-Time Ride", recurring_slots_per_week: 0 }, ...o });
const TODAY = "2026-10-29";

describe("which plan the booking page uses when a member holds two", () => {
  it("regression: a One-Time Ride bought alongside Gold no longer hides Repeat every week", () => {
    const { active, recurring } = pickActivePlans([ride(), gold()], TODAY); // newest-ending first, as the query returns them
    expect(recurring.id).toBe("gold");
    expect(active.id).toBe("gold"); // the used-up ride is not the plan classes are taken from
  });
  it("same end date: still Gold for the weekly schedule, whatever the order", () => {
    expect(pickActivePlans([ride({ end_date: "2026-11-13" }), gold({ end_date: "2026-11-13" })], TODAY).recurring.id).toBe("gold");
    expect(pickActivePlans([gold({ end_date: "2026-11-13" }), ride({ end_date: "2026-11-13" })], TODAY).recurring.id).toBe("gold");
  });
  it("single bookings use a plan with classes left first, then the one ending soonest (like the server)", () => {
    expect(pickActivePlans([gold({ credits_remaining: 0 }), ride({ credits_remaining: 1 })], TODAY).active.id).toBe("ride");
    expect(pickActivePlans([gold({ end_date: "2026-12-01" }), ride({ credits_remaining: 1, end_date: "2026-11-10" })], TODAY).active.id).toBe("ride");
  });
  it("a One-Time Ride alone has no weekly plan; expired plans are ignored", () => {
    expect(pickActivePlans([ride()], TODAY).recurring).toBeNull();
    expect(pickActivePlans([gold({ end_date: "2026-10-28" }), ride()], TODAY).recurring).toBeNull();
    expect(pickActivePlans([], TODAY)).toEqual({ active: undefined, recurring: null });
  });
});
