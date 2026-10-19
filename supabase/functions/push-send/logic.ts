// Pure helpers for push-send: no I/O, so they can be tested on their own.

export const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
export const CHANNEL_ID = "club-updates"; // must match the app's channel (app.json defaultChannel)
export const MAX_ATTEMPTS = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,}\]$/;
// Only these identifiers travel in the alert; the app re-reads each record for the signed-in member.
const ID_KEYS = ["booking_id", "order_id", "membership_id", "session_id"] as const;

export interface NotificationRow {
  id: string;
  user_id: string | null;
  audience: string;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
}

export interface ExpoMessage {
  to: string;
  title: string;
  body?: string;
  sound: "default";
  priority: "high";
  channelId: string;
  data: Record<string, string>;
}

export function isExpoToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

export function buildMessage(n: NotificationRow, token: string): ExpoMessage {
  const data: Record<string, string> = { source: "chr", notification_id: n.id, type: n.type };
  for (const key of ID_KEYS) {
    const v = n.data?.[key];
    if (typeof v === "string" && UUID_RE.test(v)) data[key] = v;
  }
  const msg: ExpoMessage = {
    to: token,
    title: n.title.slice(0, 120),
    sound: "default",
    priority: "high",
    channelId: CHANNEL_ID,
    data,
  };
  if (n.body) msg.body = n.body.slice(0, 400);
  return msg;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type TicketOutcome =
  | { status: "sent"; ticketId: string }
  | { status: "failed"; error: string; disableDevice: boolean };

/** One Expo push ticket → what to record. Anything unexpected is a failure, never "sent". */
export function ticketOutcome(ticket: unknown): TicketOutcome {
  if (!ticket || typeof ticket !== "object") return { status: "failed", error: "malformed ticket", disableDevice: false };
  const t = ticket as { status?: unknown; id?: unknown; message?: unknown; details?: { error?: unknown } };
  if (t.status === "ok" && typeof t.id === "string" && t.id) return { status: "sent", ticketId: t.id };
  const code = typeof t.details?.error === "string" ? t.details.error : "unknown";
  const message = typeof t.message === "string" ? t.message : "";
  return { status: "failed", error: `${code}${message ? `: ${message}` : ""}`.slice(0, 300), disableDevice: code === "DeviceNotRegistered" };
}

export type ReceiptOutcome =
  | { status: "receipt_ok" }
  | { status: "failed"; error: string; disableDevice: boolean }
  | null; // no receipt yet

export function receiptOutcome(receipt: unknown): ReceiptOutcome {
  if (!receipt || typeof receipt !== "object") return null;
  const r = receipt as { status?: unknown; message?: unknown; details?: { error?: unknown } };
  if (r.status === "ok") return { status: "receipt_ok" };
  if (r.status !== "error") return null;
  const code = typeof r.details?.error === "string" ? r.details.error : "unknown";
  const message = typeof r.message === "string" ? r.message : "";
  return { status: "failed", error: `${code}${message ? `: ${message}` : ""}`.slice(0, 300), disableDevice: code === "DeviceNotRegistered" };
}

/** HTTP statuses worth retrying (Expo or the network was briefly unavailable). */
export function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}
