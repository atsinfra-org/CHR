// Resend delivery events (delivered, delayed, bounced, complained, failed, suppressed).
// Records what happened AFTER Resend accepted a message, in email_outbox.delivery_status. It never
// changes whether an email was sent and never touches a payment, membership or booking.
//
// verify_jwt is OFF (Resend sends no Supabase JWT). Authenticity is the Svix signature, checked over
// the raw body BEFORE parsing, with a 5-minute replay window.
//
// Secret:  RESEND_WEBHOOK_SECRET  the signing secret ("whsec_...") of the webhook created in Resend,
//          pointing at https://<project-ref>.supabase.co/functions/v1/email-webhook
import { createClient } from "jsr:@supabase/supabase-js@2";

import { verifySvix } from "../email-send/logic.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const secret = Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (!secret) return new Response("Server not configured", { status: 500 });

  const raw = await req.text();
  const ok = await verifySvix(
    secret,
    { id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature") },
    raw,
  );
  if (!ok) return new Response("Invalid signature", { status: 400 });

  let event: { type?: string; data?: { email_id?: string } };
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!event.type || !event.data?.email_id) return new Response("Ignored", { status: 200 });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { error } = await db.rpc("record_email_provider_event", { p_message_id: event.data.email_id, p_event: event.type });
  if (error) {
    console.error("email-webhook: could not record event", error.message);
    return new Response("Processing error", { status: 500 }); // Resend retries
  }
  return new Response("OK", { status: 200 });
});
