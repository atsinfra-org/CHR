import { beforeEach, describe, expect, it, vi } from "vitest";

// The admin API only names RPCs and words their error codes; the database makes every decision. These
// tests pin the names, the parameters and the wording, with a fake client (no network).
const rpc = vi.fn();
const invoke = vi.fn();
vi.mock("../lib/supabaseClient", () => ({ supabase: { rpc: (...a) => rpc(...a), functions: { invoke: (...a) => invoke(...a) } } }));

const { adminApi } = await import("./adminApi.js");

beforeEach(() => {
  rpc.mockReset();
  invoke.mockReset();
});

describe("privacy admin calls", () => {
  it("records an identity check with the method and an optional note", async () => {
    rpc.mockResolvedValue({ data: { id: "r1" }, error: null });
    const res = await adminApi.verifyRequesterIdentity("r1", "phone_callback", null);
    expect(rpc).toHaveBeenCalledWith("admin_verify_requester_identity", { p_request_id: "r1", p_method: "phone_callback", p_note: null });
    expect(res).toEqual({ data: { id: "r1" }, error: null });
  });

  it("pages the request list and the audit trail", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await adminApi.privacyRequests(null, 200);
    await adminApi.privacyAudit(50, 100);
    expect(rpc).toHaveBeenNthCalledWith(1, "admin_list_privacy_requests", { p_status: null, p_limit: 200, p_offset: 200 });
    expect(rpc).toHaveBeenNthCalledWith(2, "admin_privacy_audit", { p_limit: 50, p_offset: 100 });
  });

  it("asks for one member's consent history", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await adminApi.memberConsents("u1");
    expect(rpc).toHaveBeenCalledWith("admin_member_consents", { p_user: "u1", p_limit: 100, p_offset: 0 });
  });
});

describe("error wording", () => {
  const codes = {
    IDENTITY_NOT_VERIFIED: /Confirm that the request really comes from the account holder/,
    CANNOT_VERIFY_OWN_REQUEST: /Another admin/,
    INVALID_METHOD: /how the identity was checked/,
    NOT_AUTOMATED: /never removed by a timer/,
    RULE_NOT_APPROVED: /Approve a retention period/,
    LEGAL_HOLD: /legal hold/,
    RETENTION_CLEANUP_DISABLED: /switched off/,
    ERASURE_BLOCKED: /needs settling/,
  };
  for (const [code, re] of Object.entries(codes)) {
    it(`words ${code} in plain language and never shows the raw code`, async () => {
      rpc.mockResolvedValue({ data: null, error: { message: code } });
      const { error } = await adminApi.verifyRequesterIdentity("r1", "phone_callback", null);
      expect(error).toMatch(re);
      expect(error).not.toContain(code);
    });
  }

  it("does not leak unknown database text", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'duplicate key value violates unique constraint "x" for a@b.c' } });
    const { error } = await adminApi.verifyRequesterIdentity("r1", "phone_callback", null);
    expect(error).not.toContain("a@b.c");
  });
});

describe("carryOutErasure", () => {
  it("is complete only when the function says so", async () => {
    invoke.mockResolvedValue({ data: { completed: true }, error: null });
    expect(await adminApi.carryOutErasure("r1")).toEqual({ data: { completed: true }, error: null });
    invoke.mockResolvedValue({ data: { completed: false }, error: null });
    expect((await adminApi.carryOutErasure("r1")).error).toMatch(/did not finish/);
  });

  it("shows the plain message for an identity refusal from the function", async () => {
    invoke.mockResolvedValue({ data: null, error: { context: { json: async () => ({ error: "IDENTITY_NOT_VERIFIED" }) } } });
    const { error } = await adminApi.carryOutErasure("r1");
    expect(error).toMatch(/Confirm that the request really comes from the account holder/);
  });

  it("never claims success when the function call fails", async () => {
    invoke.mockResolvedValue({ data: null, error: { context: { json: async () => { throw new Error("no body"); } } } });
    const res = await adminApi.carryOutErasure("r1");
    expect(res.data).toBeNull();
    expect(res.error).toMatch(/Nothing has been marked finished/);
  });
});
