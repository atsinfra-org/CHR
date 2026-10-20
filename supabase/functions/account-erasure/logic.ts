// Pure helpers for account-erasure: no I/O, so they can be tested on their own.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The codes the database functions raise on purpose; anything else is reported generically. */
const KNOWN = new Set([
  "NOT_AUTHORIZED",
  "ERASURE_DISABLED",
  "ERASURE_ON_HOLD",
  "ERASURE_BLOCKED",
  "REQUEST_NOT_FOUND",
  "REQUEST_NOT_IN_PROGRESS",
  "USER_NOT_FOUND",
  "DATABASE_STEP_NOT_DONE",
  "IDENTITY_NOT_VERIFIED",
]);

/**
 * What replaces the member's email in the sign-in record. It names no one: the id is already the record's key.
 * The .invalid domain can never receive mail.
 */
export function erasedEmail(userId: string): string {
  return `erased-${userId}@erased.invalid`;
}

/** Ten years in hours: the sign-in is banned for good, not until a date someone could forget. */
export const LOGIN_BAN_DURATION = "87600h";

/** A safe error body: a known code and its plain-language detail, never raw database text. */
export function cleanError(error: { message?: string; details?: string | null }) {
  const code = (error.message ?? "").trim();
  if (KNOWN.has(code)) return { error: code, message: error.details ?? undefined };
  return { error: "ERASURE_FAILED", message: "The request could not be processed." };
}
