import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Admin → Emails: API wiring and every page state, with a fake client (no network, no browser).
// There is no DOM test environment in this project, so clicks and effects are NOT exercised here:
// the page is rendered to static markup with the query hook stubbed to each state.
const rpc = vi.fn();
vi.mock("../lib/supabaseClient", () => ({ supabase: { rpc: (...a) => rpc(...a), functions: { invoke: vi.fn() } } }));

let hookState = { data: null, status: "loading", error: null, reload: () => {} };
vi.mock("./useAdminQuery", () => ({ useAdminQuery: () => hookState }));

const { adminApi } = await import("./adminApi.js");
const { default: AdminEmails } = await import("./pages/AdminEmails.jsx");
const { VALID_ROUTES } = await import("./useAdminRoute.js");
const { PAGE_META } = await import("./adminNav.js");

beforeEach(() => rpc.mockReset());

const row = (o = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", template: "payment_received", related_type: "order",
  related_id: "abcdef12-0000-4000-8000-000000000000", recipient_hint: "a***@example.org", status: "failed",
  delivery_status: null, attempts: 5, max_attempts: 5, last_attempt_at: "2026-10-19T08:30:00Z",
  last_error_category: "provider_unavailable", next_attempt_at: "2026-10-19T09:00:00Z", sent_at: null, can_retry: true,
  created_at: "2026-10-19T08:00:00Z", ...o,
});
const render = (isAdmin, state) => { hookState = { reload: () => {}, error: null, data: null, ...state }; return renderToStaticMarkup(<AdminEmails isAdmin={isAdmin} />); };

describe("email admin API", () => {
  it("lists with an optional status filter and retries by id, naming only the 0033 functions", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await adminApi.emailDeliveries();
    await adminApi.emailDeliveries("failed");
    await adminApi.retryEmail("j1");
    expect(rpc).toHaveBeenNthCalledWith(1, "admin_email_deliveries", { p_status: null, p_limit: 200 });
    expect(rpc).toHaveBeenNthCalledWith(2, "admin_email_deliveries", { p_status: "failed", p_limit: 200 });
    expect(rpc).toHaveBeenNthCalledWith(3, "admin_retry_email", { p_id: "j1" });
  });
  it("words authorization and retry errors without leaking database text", async () => {
    for (const [code, text] of [["FORBIDDEN", /permission/], ["NOT_RETRYABLE", /can't be retried/], ["EMAIL_NOT_FOUND", /no longer exists/]]) {
      rpc.mockResolvedValueOnce({ data: null, error: { message: code } });
      const res = await adminApi.retryEmail("j1");
      expect(res.data).toBeNull();
      expect(res.error).toMatch(text);
    }
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'relation "email_outbox" violates something' } });
    expect((await adminApi.retryEmail("j1")).error).toBe("Something went wrong. Please try again.");
  });
  it("is registered as a route with a title", () => {
    expect(VALID_ROUTES).toContain("emails");
    expect(PAGE_META.emails?.label ?? PAGE_META.emails?.title).toBeTruthy();
  });
});

describe("Admin → Emails page states", () => {
  it("loading", () => expect(render(true, { status: "loading" })).toContain("Loading emails"));
  it("error offers a retry and shows the message", () => {
    const out = render(true, { status: "error", error: "Boom" });
    expect(out).toContain("Boom");
    expect(out).toContain("Retry");
  });
  it("empty", () => expect(render(true, { status: "ready", data: [] })).toContain("No emails yet"));
  it("explains a payload-mismatch conflict and a sending-limit stop in plain language, not as raw codes", () => {
    const conflict = render(true, { status: "ready", data: [row({ last_error_category: "idempotency_conflict" })] });
    expect(conflict).toContain("Possibly already sent");
    expect(conflict).not.toContain("idempotency_conflict");
    const quota = render(true, { status: "ready", data: [row({ last_error_category: "quota_exceeded" })] });
    expect(quota).toContain("sending limit reached");
    expect(quota).not.toContain("quota_exceeded");
  });
  it("ready shows type, masked recipient, status, tries and the plain-language problem", () => {
    const out = render(true, { status: "ready", data: [row()] });
    expect(out).toContain("Payment received");
    expect(out).toContain("a***@example.org");
    expect(out).toContain("5/5");
    expect(out).toContain("Email provider unavailable");
    expect(out).toContain("ABCDEF12");
  });
  it("an administrator sees Retry email on a retryable row", () => expect(render(true, { status: "ready", data: [row()] })).toContain("Retry email"));
  it("staff do not get a retry button, only a note", () => {
    const out = render(false, { status: "ready", data: [row()] });
    expect(out).not.toContain("Retry email");
    expect(out).toContain("Administrator can retry");
  });
  it("no retry control when the server says it can't be retried (sent or bounced)", () => {
    const out = render(true, { status: "ready", data: [row({ status: "sent", can_retry: false, delivery_status: "bounced", last_error_category: "bounced" })] });
    expect(out).not.toContain("Retry email");
    expect(out).toContain("Address bounced");
  });
  it("explains that Sent is not Delivered", () => expect(render(true, { status: "ready", data: [] })).toContain("provider accepted it"));
  it("never renders a full address or any key", () => {
    const out = render(true, { status: "ready", data: [row()] });
    expect(out).not.toMatch(/re_[A-Za-z0-9]{10,}|whsec_|@example\.org".*asha/);
  });
});
