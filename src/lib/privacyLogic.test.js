import { describe, expect, it } from "vitest";
import {
  NOT_PROVIDED,
  canCancel,
  dueText,
  exportFileName,
  friendlyPrivacyError,
  isOpen,
  noticeState,
  parseNotice,
  purposeView,
  registrationNotice,
  rememberPendingAcknowledgement,
  splitMarks,
  takePendingAcknowledgement,
  validateRequest,
} from "./privacyLogic.js";

const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
};

describe("parseNotice", () => {
  it("turns headings, lists and paragraphs into blocks", () => {
    const blocks = parseNotice("## Who we are\nWe run a club.\n- one\n- two\n\nAnother paragraph.\n## Next");
    expect(blocks).toEqual([
      { type: "h2", text: "Who we are" },
      { type: "p", text: "We run a club." },
      { type: "ul", items: ["one", "two"] },
      { type: "p", text: "Another paragraph." },
      { type: "h2", text: "Next" },
    ]);
  });
  it("produces data, never markup: HTML in the text stays as text", () => {
    const [p] = parseNotice('<img src=x onerror="alert(1)"> hi');
    expect(p).toEqual({ type: "p", text: '<img src=x onerror="alert(1)"> hi' });
  });
  it("handles empty and missing input", () => {
    expect(parseNotice("")).toEqual([]);
    expect(parseNotice(null)).toEqual([]);
  });
});

describe("splitMarks", () => {
  it("separates the not-yet-provided marker so it can be highlighted", () => {
    expect(splitMarks(`Address: ${NOT_PROVIDED}.`)).toEqual([
      { text: "Address: ", mark: false },
      { text: NOT_PROVIDED, mark: true },
      { text: ".", mark: false },
    ]);
    expect(splitMarks("nothing missing")).toEqual([{ text: "nothing missing", mark: false }]);
  });
});

describe("noticeState and registration", () => {
  it("only a published notice is in effect", () => {
    expect(noticeState({ published: true, body: "x", version: "1.0" })).toBe("published");
    expect(noticeState({ published: false, body: "draft text" })).toBe("draft");
    expect(noticeState({ published: false })).toBe("none");
    expect(noticeState(null)).toBe("none");
  });
  it("registration must acknowledge only a published notice, and names its version", () => {
    expect(registrationNotice({ published: true, version: "1.0", body: "x" })).toEqual({ state: "published", mustAcknowledge: true, version: "1.0" });
  });
  it("a draft never blocks registration and is never acknowledged", () => {
    expect(registrationNotice({ published: false, version: "1.0", body: "x" })).toEqual({ state: "draft", mustAcknowledge: false, version: null });
    expect(registrationNotice(null).mustAcknowledge).toBe(false);
  });
});

describe("pending acknowledgement", () => {
  it("is remembered, returned once for the current version, then forgotten", () => {
    const s = memoryStorage();
    rememberPendingAcknowledgement(s, "1.0");
    expect(takePendingAcknowledgement(s, "1.0")).toBe("1.0");
    expect(takePendingAcknowledgement(s, "1.0")).toBeNull();
  });
  it("is dropped, not acted on, when the notice has since changed", () => {
    const s = memoryStorage();
    rememberPendingAcknowledgement(s, "1.0");
    expect(takePendingAcknowledgement(s, "2.0")).toBeNull();
    expect(s._m.size).toBe(0);
  });
  it("never remembers an empty version, and survives broken storage", () => {
    const s = memoryStorage();
    rememberPendingAcknowledgement(s, null);
    expect(s._m.size).toBe(0);
    const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() {} };
    expect(() => rememberPendingAcknowledgement(broken, "1.0")).not.toThrow();
    expect(takePendingAcknowledgement(broken, "1.0")).toBeNull();
    expect(takePendingAcknowledgement(null, "1.0")).toBeNull();
  });
  it("a corrupted value is ignored", () => {
    const s = memoryStorage();
    s.setItem("chr.privacy.pending", "{not json");
    expect(takePendingAcknowledgement(s, "1.0")).toBeNull();
  });
});

describe("purposeView", () => {
  it("an essential purpose is information, not a switch", () => {
    expect(purposeView({ is_mandatory: true, status: "acknowledged" })).toMatchObject({ kind: "required", on: true });
  });
  it("an optional purpose is on until the member withdraws it", () => {
    expect(purposeView({ is_mandatory: false, status: "none" })).toMatchObject({ kind: "switch", on: true });
    expect(purposeView({ is_mandatory: false, status: "granted" })).toMatchObject({ on: true });
    expect(purposeView({ is_mandatory: false, status: "withdrawn" })).toMatchObject({ on: false, label: "Off" });
  });
});

describe("validateRequest", () => {
  it("a copy of data needs no details", () => {
    expect(validateRequest({ type: "access" })).toEqual({});
  });
  it("a complaint, correction, nomination or other question needs details", () => {
    for (const type of ["grievance", "correction", "nomination", "other"]) {
      expect(validateRequest({ type, details: "   " }).details).toBeTruthy();
      expect(validateRequest({ type, details: "something" })).toEqual({});
    }
  });
  it("limits lengths and rejects unknown types", () => {
    expect(validateRequest({ type: "other", details: "x".repeat(2001) }).details).toMatch(/2000/);
    expect(validateRequest({ type: "access", subject: "x".repeat(121) }).subject).toMatch(/120/);
    expect(validateRequest({ type: "erasure" }).type).toBeTruthy();
    expect(validateRequest({ type: "bogus" }).type).toBeTruthy();
  });
});

describe("request status", () => {
  it("knows which are open and which can be withdrawn", () => {
    expect(["submitted", "in_progress", "awaiting_requester"].every(isOpen)).toBe(true);
    expect(["completed", "rejected", "cancelled"].some(isOpen)).toBe(false);
    expect(canCancel("submitted")).toBe(true);
    expect(canCancel("awaiting_requester")).toBe(true);
    expect(canCancel("in_progress")).toBe(false);
    expect(canCancel("completed")).toBe(false);
  });
  it("shows a due date only when the club set one and the request is open", () => {
    expect(dueText({ due_at: "2027-01-10", status: "submitted" }, (d) => d)).toBe("We aim to answer by 2027-01-10.");
    expect(dueText({ due_at: null, status: "submitted" })).toBeNull();
    expect(dueText({ due_at: "2027-01-10", status: "completed" })).toBeNull();
  });
});

describe("export file name and errors", () => {
  it("names the file by day", () => {
    expect(exportFileName(new Date("2026-10-19T10:00:00Z"))).toBe("chr-my-data-2026-10-19.json");
  });
  it("shows plain language, never database text", () => {
    expect(friendlyPrivacyError({ message: "MANDATORY_PURPOSE" })).toMatch(/close your account/);
    expect(friendlyPrivacyError({ message: "ALREADY_REQUESTED" })).toMatch(/already have an open request/);
    expect(friendlyPrivacyError({ message: "Failed to fetch" })).toMatch(/connection/);
    const msg = friendlyPrivacyError({ message: 'duplicate key value violates unique constraint "x" (a@b.c)' });
    expect(msg).toBe("Something went wrong. Please try again.");
    expect(msg).not.toMatch(/a@b\.c|constraint/);
  });
});

describe("duplicate request wording (0032)", () => {
  it("is no longer specific to closing an account", () => {
    const msg = friendlyPrivacyError({ message: "ALREADY_REQUESTED" });
    expect(msg).toMatch(/open request of this kind/);
    expect(msg).not.toMatch(/close your account/i);
  });
  it("prefers the database's own plain detail when it sends one", () => {
    expect(friendlyPrivacyError({ message: "ALREADY_REQUESTED", details: "You already have an open request of this kind. We will update it." })).toMatch(/We will update it/);
  });
});
