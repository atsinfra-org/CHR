// Emails the club when someone sends the website enquiry form.
//
// Called by the form right after it saves the enquiry, with ONLY the enquiry's
// id. Nothing in the email comes from the caller: the details are read from the
// saved row with the service-role key, so this endpoint can't be used to send
// arbitrary text. verify_jwt is OFF (visitors are not signed in).
//
// Safe to call twice: the row is claimed (emailed_at) before sending, so one
// enquiry is emailed once. Only enquiries from the last 10 minutes are sent.
// If the send fails the claim is released and the enquiry is still in the
// admin inbox (and rang the admin bell when it was saved).
//
// Secrets (Supabase → Edge Functions → Secrets):
//   RESEND_API_KEY   from resend.com. Without it this function does nothing.
//   ENQUIRY_TO       where to send. Default: colonelhorseriding@gmail.com
//   ENQUIRY_FROM     e.g. "Colonel Horse Riding <enquiries@yourdomain.com>".
//                    Default: Resend's test sender, which can only deliver to the
//                    email address the Resend account was created with.
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FRESH_MS = 10 * 60 * 1000;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) return json({ sent: false, reason: "not_configured" });

    let id: unknown;
    try {
      ({ id } = await req.json());
    } catch {
      return json({ error: "INVALID_REQUEST" }, 400);
    }
    if (typeof id !== "string" || !UUID.test(id)) return json({ error: "INVALID_REQUEST" }, 400);

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });

    const since = new Date(Date.now() - FRESH_MS).toISOString();
    const { data: row, error } = await db
      .from("enquiries")
      .update({ emailed_at: new Date().toISOString() })
      .eq("id", id)
      .is("emailed_at", null)
      .gte("created_at", since)
      .select("id, name, age, email, phone, topic, created_at")
      .maybeSingle();

    if (error) {
      console.error("enquiry-email: claim failed", error.message);
      return json({ sent: false, reason: "lookup_failed" }, 500);
    }
    if (!row) return json({ sent: false, reason: "nothing_to_send" });

    const to = Deno.env.get("ENQUIRY_TO") || "colonelhorseriding@gmail.com";
    const from = Deno.env.get("ENQUIRY_FROM") || "Colonel Horse Riding <onboarding@resend.dev>";
    const subject = `New enquiry: ${row.topic || "General"} (${row.name})`;
    const html =
      `<p>A new enquiry came in from the website.</p>` +
      `<table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">` +
      `<tr><td><b>Name</b></td><td>${esc(row.name)}</td></tr>` +
      `<tr><td><b>Age</b></td><td>${esc(row.age)}</td></tr>` +
      `<tr><td><b>Phone</b></td><td>${esc(row.phone)}</td></tr>` +
      `<tr><td><b>Email</b></td><td>${esc(row.email)}</td></tr>` +
      `<tr><td><b>Subject</b></td><td>${esc(row.topic || "General")}</td></tr>` +
      `</table>` +
      `<p>Mark it answered in the admin console, under Enquiries.</p>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to: [to], reply_to: row.email, subject, html }),
    });

    if (!res.ok) {
      console.error("enquiry-email: Resend refused the message", res.status, await res.text());
      await db.from("enquiries").update({ emailed_at: null }).eq("id", row.id);
      return json({ sent: false, reason: "send_failed" }, 502);
    }
    return json({ sent: true });
  } catch (err) {
    console.error("enquiry-email: unhandled error", err instanceof Error ? err.message : err);
    return json({ error: "INTERNAL_ERROR" }, 500);
  }
});
