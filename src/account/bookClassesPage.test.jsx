import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The Book a class booking bar, rendered for each kind of plan (static markup; no clicks, no network).
vi.mock("../lib/supabaseClient", () => ({ supabase: { rpc: vi.fn(() => Promise.resolve({ data: null, error: null })), from: vi.fn() } }));
vi.mock("./booking/ClassCalendar", () => ({ default: () => <div data-testid="calendar" /> }));
vi.mock("./booking/availability", () => ({ fetchWaitlist: () => Promise.resolve({ enabled: false, ids: new Set() }) }));

const { BookingFlow } = await import("./BookClasses.jsx");
const { ToastProvider } = await import("./ui.jsx");

const elig = { credits_remaining: 8, membership_end_date: "2026-11-18", min_bookable_date: "2026-10-21", max_bookable_date: "2026-11-18" };
const render = (slotsPerWeek) => renderToStaticMarkup(<ToastProvider><BookingFlow elig={elig} onBooked={() => {}} weekly={{ slotsPerWeek }} /></ToastProvider>);

describe("Book a class: weekly plans (Gold 2, Platinum 4)", () => {
  for (const [name, slots] of [["Gold", 2], ["Platinum", 4]]) {
    it(`${name}: Repeat every week is the only booking action, and no one-time button exists`, () => {
      const html = render(slots);
      expect(html).toContain("Repeat every week");
      expect(html).not.toMatch(/Book this class only/i);
      expect(html).not.toMatch(/>Book this class</i);
      expect(html).not.toMatch(/Book class/);
      expect(html.match(/Repeat every week/g)).toHaveLength(1); // exactly one booking button
    });
    it(`${name}: nothing suggests a choice between one class and a repeating class`, () => {
      const html = render(slots).toLowerCase();
      expect(html).not.toMatch(/one class, or|only this class|just this class|one-time class|single class/);
      expect(html).toContain("repeats every week");
      expect(html).toContain(`up to ${slots} a week`);
    });
  }
  it("keeps the coach assignment message and never offers a horse choice", () => {
    const html = render(2);
    expect(html).toContain("Your coach will assign your horse at the ground");
    expect(html.toLowerCase()).not.toMatch(/choose your horse|pick a horse|select a horse/);
  });
  it("the button is full-width on phones and prominent (primary style)", () => {
    const html = render(2);
    expect(html).toContain("w-full");
    expect(html).toContain("bg-racing-green");
  });
});

describe("Book a class: a plan that cannot repeat (One-Time Ride)", () => {
  it("keeps its single booking button and shows no weekly controls", () => {
    const html = render(0);
    expect(html).toContain("Book this class");
    expect(html).not.toContain("Repeat every week");
    expect(html).not.toMatch(/weekly schedule/i);
  });
});
