// Pure helpers for email-send (no Deno APIs, so they run under Node in supabase/tests).

export type Outcome = "sent" | "transient" | "permanent";

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Decides what a provider response means for the job. Never includes the response body or any
 * address in the category: only a short fixed label is stored.
 *   2xx                      accepted (NOT yet delivered)
 *   408, 409, 425, 429, 5xx  try again later
 *   401, 403                 our credentials/sender are wrong: stop (staff retry once fixed)
 *   other 4xx                this message can never be sent as it is (bad address, invalid payload)
 */
export function classifyProviderStatus(status: number, errorName?: string | null): { outcome: Outcome; category: string | null } {
  if (status >= 200 && status < 300) return { outcome: "sent", category: null };
  if (status === 429) {
    // Quota errors say WHY (staff see it in Admin -> Emails); they still back off, since the daily quota
    // resets at midnight UTC and a staff retry is available once it has.
    if (errorName === "daily_quota_exceeded" || errorName === "monthly_quota_exceeded") return { outcome: "transient", category: "quota_exceeded" };
    return { outcome: "transient", category: "rate_limited" };
  }
  if (status === 409) {
    // Resend uses 409 for two opposite things (https://resend.com/docs/api-reference/errors):
    //   invalid_idempotent_request      the key was already used with a DIFFERENT body within 24 hours.
    //                                   Retrying the same request can never succeed ("useless without changing the
    //                                   key or payload"), so it must stop, not loop. It may mean the first attempt
    //                                   WAS accepted (we timed out before reading the reply), so it is reported as
    //                                   a conflict for staff to check, not as a plain failure and not as sent.
    //   concurrent_idempotent_requests  the first request with this key is still running: try again later.
    // An unrecognised or unreadable 409 stays retryable; max_attempts bounds it.
    if (errorName === "invalid_idempotent_request") return { outcome: "permanent", category: "idempotency_conflict" };
    return { outcome: "transient", category: "provider_busy" };
  }
  if (status === 408 || status === 425) return { outcome: "transient", category: "provider_busy" };
  if (status >= 500) return { outcome: "transient", category: "provider_unavailable" };
  if (status === 401 || status === 403) return { outcome: "permanent", category: "provider_auth" };
  if (status === 422 || status === 400) return { outcome: "permanent", category: "invalid_request" };
  return { outcome: "permanent", category: "provider_rejected" };
}

/**
 * Pulls ONLY the provider's short error `name` (for example "invalid_idempotent_request") out of an error
 * response. The message is never read, stored or logged: it can quote the recipient. Anything that is not a
 * short lower-case token is ignored.
 */
export async function readProviderErrorName(res: { json?: () => Promise<unknown> }): Promise<string | null> {
  try {
    const body = (await res.json?.()) as { name?: unknown } | null;
    const name = body && typeof body.name === "string" ? body.name : null;
    return name && /^[a-z][a-z0-9_]{0,59}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** A network failure or timeout: the provider may or may not have the message; Resend's idempotency key makes the retry safe. */
export const NETWORK_FAILURE = { outcome: "transient" as Outcome, category: "network" };

// ─── Svix signature (Resend webhooks) ───────────────────────────────────────
const enc = new TextEncoder();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Verifies a Svix-signed webhook (the scheme Resend uses): HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`
 * with the base64 key after `whsec_`, compared in constant time against every `v1,<sig>` in the header.
 * Rejects timestamps more than `toleranceSeconds` from now (replay protection).
 */
export async function verifySvix(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > toleranceSeconds) return false;
  let key: CryptoKey;
  try {
    const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    key = await crypto.subtle.importKey("raw", b64ToBytes(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    return false;
  }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${timestamp}.${rawBody}`)));
  const expected = bytesToB64(mac);
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    return version === "v1" && !!sig && timingSafeEqual(sig, expected);
  });
}
