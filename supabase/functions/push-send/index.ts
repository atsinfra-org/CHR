// Phone alerts: pushes member notifications to their registered phones via the
// Expo Push Service (which delivers through the FCM V1 credential held by EAS —
// no Firebase key is needed here).
//
// Called only by the database (proposal 0026): the notifications trigger posts
// { notification_id } after the inserting transaction commits, and pg_cron
// posts { sweep: true } every 5 minutes. verify_jwt is OFF for this function
// (configured at deploy time); authenticity comes from the x-push-secret header,
// compared with the PUSH_SEND_SECRET function secret. Members never call it.
//
// Duplicates: a (notification, phone) pair is claimed in push_deliveries before
// sending; the unique constraint means a second call for the same pair sends
// nothing. A send whose outcome is unknown is never repeated.
//
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (provided by Supabase),
// PUSH_SEND_SECRET (required), EXPO_ACCESS_TOKEN (only if "enhanced push
// security" is switched on for the Expo project).
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import {
  buildMessage,
  chunk,
  EXPO_RECEIPTS_URL,
  EXPO_SEND_URL,
  isExpoToken,
  isTransient,
  isUuid,
  MAX_ATTEMPTS,
  receiptOutcome,
  ticketOutcome,
  timingSafeEqual,
  type NotificationRow,
} from "./logic.ts";

/** Notifications older than this are not pushed (a late alert about an old event is noise). */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;

type Db = SupabaseClient;
type Claim = { deliveryId: string; deviceId: string; token: string; notification: NotificationRow };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function expoHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  const token = Deno.env.get("EXPO_ACCESS_TOKEN");
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", headers: expoHeaders(), body: JSON.stringify(body), signal: controller.signal });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, json: parsed };
  } catch {
    return null; // network error or timeout
  } finally {
    clearTimeout(timer);
  }
}

async function setDelivery(db: Db, ids: string[], patch: Record<string, unknown>) {
  if (!ids.length) return;
  const { error } = await db.from("push_deliveries").update({ ...patch, updated_at: new Date().toISOString() }).in("id", ids);
  if (error) console.error("push_deliveries update failed", error.message);
}

async function disableDevices(db: Db, deviceIds: string[], reason: string) {
  if (!deviceIds.length) return;
  const { error } = await db
    .from("push_devices")
    .update({ disabled_at: new Date().toISOString(), disabled_reason: reason })
    .in("id", [...new Set(deviceIds)]);
  if (error) console.error("push_devices disable failed", error.message);
}

/** Sends claimed deliveries and records each ticket. */
async function send(db: Db, claims: Claim[]) {
  let sent = 0;
  for (const group of chunk(claims, 100)) {
    const res = await postJson(EXPO_SEND_URL, group.map((c) => buildMessage(c.notification, c.token)));
    const ids = group.map((c) => c.deliveryId);

    if (!res || isTransient(res.status)) {
      // Expo didn't take them: safe to send again later.
      await setDelivery(db, ids, { status: "retry", error: res ? `http ${res.status}` : "network error" });
      continue;
    }
    const tickets = (res.json as { data?: unknown })?.data;
    if (res.status >= 400 || !Array.isArray(tickets) || tickets.length !== group.length) {
      // Rejected outright, or an answer we can't read: don't resend (it may have gone out).
      const errors = (res.json as { errors?: { code?: string; message?: string }[] })?.errors;
      const detail = errors?.[0] ? `${errors[0].code ?? ""} ${errors[0].message ?? ""}`.trim() : "malformed response";
      await setDelivery(db, ids, { status: "failed", error: `http ${res.status}: ${detail}`.slice(0, 300) });
      continue;
    }

    const toDisable: string[] = [];
    for (let i = 0; i < group.length; i++) {
      const outcome = ticketOutcome(tickets[i]);
      if (outcome.status === "sent") {
        sent++;
        await setDelivery(db, [group[i].deliveryId], { status: "sent", ticket_id: outcome.ticketId, error: null });
      } else {
        await setDelivery(db, [group[i].deliveryId], { status: "failed", error: outcome.error });
        if (outcome.disableDevice) toDisable.push(group[i].deviceId);
      }
    }
    await disableDevices(db, toDisable, "DeviceNotRegistered");
  }
  return sent;
}

/** Claims and sends one notification to every active phone of its member. */
async function deliverNotification(db: Db, notificationId: string) {
  const { data: n, error } = await db
    .from("notifications")
    .select("id, user_id, audience, type, title, body, data, created_at")
    .eq("id", notificationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!n || n.audience !== "user" || !n.user_id) return 0;
  if (Date.now() - Date.parse(n.created_at) > MAX_AGE_MS) return 0;

  // Only phones the member already had when the notification was written.
  const { data: devices, error: dErr } = await db
    .from("push_devices")
    .select("id, token")
    .eq("user_id", n.user_id)
    .is("disabled_at", null)
    .lte("created_at", n.created_at);
  if (dErr) throw new Error(dErr.message);
  const usable = (devices ?? []).filter((d) => isExpoToken(d.token));
  if (!usable.length) return 0;

  // Claim: rows that already exist (sent or in progress elsewhere) are not returned, so not re-sent.
  const { data: claimed, error: cErr } = await db
    .from("push_deliveries")
    .upsert(
      usable.map((d) => ({ notification_id: n.id, device_id: d.id })),
      { onConflict: "notification_id,device_id", ignoreDuplicates: true },
    )
    .select("id, device_id");
  if (cErr) throw new Error(cErr.message);

  const tokenOf = new Map(usable.map((d) => [d.id, d.token as string]));
  const claims: Claim[] = (claimed ?? []).map((c) => ({
    deliveryId: c.id,
    deviceId: c.device_id,
    token: tokenOf.get(c.device_id)!,
    notification: n as NotificationRow,
  }));
  return send(db, claims);
}

async function sweep(db: Db) {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const summary = { missed: 0, retried: 0, interrupted: 0, receipts: 0 };

  // 1. Notifications the trigger didn't get to (push-send was down, deploy gap…). Two-minute grace for the trigger.
  const { data: owners } = await db.from("push_devices").select("user_id").is("disabled_at", null);
  const userIds = [...new Set((owners ?? []).map((o) => o.user_id))];
  if (userIds.length) {
    const { data: recent } = await db
      .from("notifications")
      .select("id")
      .eq("audience", "user")
      .in("user_id", userIds.slice(0, 500))
      .gte("created_at", iso(2 * 60 * 60 * 1000))
      .lte("created_at", iso(2 * 60 * 1000))
      .limit(500);
    for (const r of recent ?? []) summary.missed += await deliverNotification(db, r.id);
  }

  // 2. Transient failures: re-claim (optimistically) and send again, up to MAX_ATTEMPTS.
  const { data: retries } = await db
    .from("push_deliveries")
    .select("id, attempts, device_id, notification_id")
    .eq("status", "retry")
    .lte("updated_at", iso(60 * 1000))
    .limit(200);
  const reclaimed: Claim[] = [];
  for (const r of retries ?? []) {
    if (r.attempts >= MAX_ATTEMPTS) {
      await setDelivery(db, [r.id], { status: "failed", error: "gave up after retries" });
      continue;
    }
    const { data: won } = await db
      .from("push_deliveries")
      .update({ status: "claimed", attempts: r.attempts + 1, updated_at: new Date().toISOString() })
      .eq("id", r.id)
      .eq("status", "retry")
      .eq("attempts", r.attempts)
      .select("id");
    if (!won?.length) continue; // another sweep took it
    const [{ data: device }, { data: n }] = await Promise.all([
      db.from("push_devices").select("token, disabled_at").eq("id", r.device_id).maybeSingle(),
      db.from("notifications").select("id, user_id, audience, type, title, body, data").eq("id", r.notification_id).maybeSingle(),
    ]);
    if (!device || device.disabled_at || !isExpoToken(device.token) || !n) {
      await setDelivery(db, [r.id], { status: "failed", error: "device or notification gone" });
      continue;
    }
    reclaimed.push({ deliveryId: r.id, deviceId: r.device_id, token: device.token, notification: n as NotificationRow });
  }
  summary.retried = await send(db, reclaimed);

  // 3. Claimed but never finished (function crashed mid-send): outcome unknown, so not resent.
  const { data: stuck } = await db.from("push_deliveries").select("id").eq("status", "claimed").lte("updated_at", iso(10 * 60 * 1000)).limit(500);
  summary.interrupted = stuck?.length ?? 0;
  await setDelivery(db, (stuck ?? []).map((s) => s.id), { status: "failed", error: "interrupted; not resent to avoid a duplicate" });

  // 4. Receipts for tickets at least 15 minutes old (Expo keeps them about a day).
  const { data: sent } = await db
    .from("push_deliveries")
    .select("id, ticket_id, device_id, created_at")
    .eq("status", "sent")
    .lte("updated_at", iso(15 * 60 * 1000))
    .limit(1000);
  const withTicket = (sent ?? []).filter((s) => typeof s.ticket_id === "string" && s.ticket_id);
  if (withTicket.length) {
    const res = await postJson(EXPO_RECEIPTS_URL, { ids: withTicket.map((s) => s.ticket_id) });
    const receipts = (res?.json as { data?: Record<string, unknown> })?.data;
    if (res && res.status < 300 && receipts && typeof receipts === "object") {
      const toDisable: string[] = [];
      for (const s of withTicket) {
        const outcome = receiptOutcome(receipts[s.ticket_id]);
        if (outcome?.status === "receipt_ok") {
          summary.receipts++;
          await setDelivery(db, [s.id], { status: "receipt_ok", error: null });
        } else if (outcome?.status === "failed") {
          await setDelivery(db, [s.id], { status: "failed", error: outcome.error });
          if (outcome.disableDevice) toDisable.push(s.device_id);
        } else if (now - Date.parse(s.created_at) > 24 * 60 * 60 * 1000) {
          await setDelivery(db, [s.id], { status: "failed", error: "no receipt from Expo" });
        }
      }
      await disableDevices(db, toDisable, "DeviceNotRegistered");
    }
  }
  return summary;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  const secret = Deno.env.get("PUSH_SEND_SECRET");
  const given = req.headers.get("x-push-secret") ?? "";
  if (!secret || !timingSafeEqual(given, secret)) return json(401, { error: "unauthorized" });

  let body: { notification_id?: unknown; sweep?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid json" });
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (body.sweep === true) return json(200, { ok: true, ...(await sweep(db)) });
    if (isUuid(body.notification_id)) return json(200, { ok: true, sent: await deliverNotification(db, body.notification_id) });
    return json(400, { error: "expected notification_id or sweep" });
  } catch (error) {
    console.error("push-send failed", error instanceof Error ? error.message : error);
    return json(500, { error: "push-send failed" });
  }
});
