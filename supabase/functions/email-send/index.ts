// Sends the transactional emails queued in email_outbox (payment received, membership active, class
// booked / rescheduled, order confirmation, payment still being verified).
//
// Called by the database (pg_net, after the business transaction commits, plus a 5-minute sweep) with
// ONLY a job id or {sweep:true}. verify_jwt is OFF for this function (deploy with --no-verify-jwt);
// authenticity is the shared secret in the x-email-secret header. Nothing in an email comes from the
// caller: the content is read from the database records by email_job_context().
//
// A failure here never touches a payment, membership, credit or booking: it only changes the email
// job's own status (queued -> processing -> sent | retry_scheduled | failed | skipped).
//
// Secrets (Supabase -> Edge Functions -> Secrets). None of these ever reach the mobile app.
//   RESEND_API_KEY        from resend.com. Without it, jobs stay queued (nothing is claimed or lost).
//   EMAIL_FROM            REQUIRED, on a domain verified in Resend, e.g. "Colonel Horse Riding <receipts@yourdomain.com>".
//                         There is deliberately no default: Resend's test sender cannot reach members.
//   EMAIL_FUNCTION_SECRET shared with the database (Vault secret email_send_secret).
//   EMAIL_REPLY_TO        optional, e.g. the club's contact address.
//   EMAIL_LINK_BASE_URL   optional https URL of the member site; without it the emails have no buttons.
//
// Optional, OFF by default: the published Resend "Membership Confirmation" template, for membership_activated ONLY
// (see resend-template.ts and docs/TRANSACTIONAL_EMAIL.md). Every other email type always uses templates.ts.
//   EMAIL_MEMBERSHIP_TEMPLATE_ENABLED    must be exactly "true" to use the template. Anything else: standard email.
//   EMAIL_MEMBERSHIP_TEMPLATE_VARIABLES  comma-separated variables the published template REGISTERED, as printed by
//                                        supabase/tools/inspect-resend-template.cjs. Unset: the template is not used.
//   EMAIL_MEMBERSHIP_TEMPLATE_ID         optional; the template UUID or alias. Default: the published template's id.
// Optional, OFF by default: the published Resend "CHR Welcome Email" template, for the welcome email ONLY.
//   EMAIL_WELCOME_TEMPLATE_ENABLED       must be exactly "true". Anything else: the standard welcome email.
//   RESEND_WELCOME_TEMPLATE_ID           the template UUID or alias. Unset or malformed: the template is not used.
//   Variables sent: exactly { name, dashboard_url }.
// If Resend definitively rejects a template request (400, 404 or 422) the standard email is sent instead, so a
// template mistake never costs a member their confirmation.
import { createClient } from "jsr:@supabase/supabase-js@2";

import { classifyProviderStatus, isUuid, NETWORK_FAILURE, readProviderErrorName, timingSafeEqual } from "./logic.ts";
import { buildMembershipTemplateRequest, buildWelcomeTemplateRequest, parseDeclaredVariables, TEMPLATE_REJECTED_STATUSES } from "./resend-template.ts";
import { renderEmail } from "./templates.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const BATCH = 10;
const SEND_TIMEOUT_MS = 15_000;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  const secret = Deno.env.get("EMAIL_FUNCTION_SECRET");
  const given = req.headers.get("x-email-secret") ?? "";
  if (!secret || !timingSafeEqual(secret, given)) return json({ error: "UNAUTHORIZED" }, 401);

  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM");
  // Not configured: claim nothing, so every job waits safely until it is.
  if (!apiKey || !from) return json({ processed: 0, reason: "not_configured" });

  let body: { job_id?: unknown; sweep?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "INVALID_REQUEST" }, 400);
  }
  const jobId = body.job_id === undefined ? null : body.job_id;
  if (jobId !== null && !isUuid(jobId)) return json({ error: "INVALID_REQUEST" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: jobs, error } = await db.rpc("claim_email_jobs", { p_limit: BATCH, p_job: jobId });
  if (error) {
    console.error("email-send: claim failed", error.message);
    return json({ error: "CLAIM_FAILED" }, 500);
  }

  const replyTo = Deno.env.get("EMAIL_REPLY_TO") || undefined;
  const linkBase = Deno.env.get("EMAIL_LINK_BASE_URL") || null;
  const templateEnabled = Deno.env.get("EMAIL_MEMBERSHIP_TEMPLATE_ENABLED") === "true";
  const templateId = Deno.env.get("EMAIL_MEMBERSHIP_TEMPLATE_ID") || null;
  const welcomeEnabled = Deno.env.get("EMAIL_WELCOME_TEMPLATE_ENABLED") === "true";
  const welcomeTemplateId = Deno.env.get("RESEND_WELCOME_TEMPLATE_ID") || null;
  const declaredVariables = parseDeclaredVariables(Deno.env.get("EMAIL_MEMBERSHIP_TEMPLATE_VARIABLES"));
  const tally = { sent: 0, retry_scheduled: 0, failed: 0, skipped: 0 };

  for (const job of (jobs ?? []) as { id: string; template: string }[]) {
    let outcome: "sent" | "transient" | "permanent" | "skipped" = "transient";
    let category: string | null = "internal_error";
    let messageId: string | null = null;
    try {
      const { data: ctx, error: ctxError } = await db.rpc("email_job_context", { p_job: job.id });
      if (ctxError) throw new Error("context_failed");
      if (!ctx?.ok) {
        outcome = "skipped";
        category = String(ctx?.skip_reason ?? "skipped");
      } else {
        // Always rendered: it supplies the subject, and the body for every email that does not use a Resend template.
        const mail = renderEmail(ctx, linkBase);
        const standard = { from, to: [ctx.to], reply_to: replyTo, subject: mail.subject, html: mail.html, text: mail.text };
        let payload: Record<string, unknown> = standard;
        let usedTemplate = false;
        if (templateEnabled && ctx.template === "membership_activated") {
          const t = buildMembershipTemplateRequest(ctx, { templateId, linkBase, declared: declaredVariables });
          if (t.ok) {
            // `html` and `text` must not accompany `template`. from, to, reply_to and the subject are unchanged.
            payload = { from, to: [ctx.to], reply_to: replyTo, subject: mail.subject, template: t.template };
            usedTemplate = true;
          } else {
            console.warn("email-send: template not used, sending the standard email", { job: job.id, reason: t.reason, missing: t.missing });
          }
        }
        if (ctx.template === "welcome") {
          const w = buildWelcomeTemplateRequest(ctx, { enabled: welcomeEnabled, templateId: welcomeTemplateId });
          if (w.ok) {
            payload = { from, to: [ctx.to], reply_to: replyTo, subject: mail.subject, template: w.template };
            usedTemplate = true;
          } else if (w.reason === "no_template_id") {
            console.warn("email-send: welcome template not used, sending the standard email", { job: job.id, reason: w.reason });
          }
        }
        try {
          const post = async (body: Record<string, unknown>, idempotencyKey: string) => {
            const res = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                // One send per job even if this worker dies between the provider accepting it and us recording it.
                "Idempotency-Key": idempotencyKey,
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });
            // On an error, read only the provider's short error name: Resend answers 409 for two opposite
            // reasons (see classifyProviderStatus), and the status alone cannot tell them apart.
            return { res, errorName: res.ok ? null : await readProviderErrorName(res) };
          };
          let { res, errorName } = await post(payload, job.id);
          if (usedTemplate && TEMPLATE_REJECTED_STATUSES.includes(res.status)) {
            // A definitive rejection of the TEMPLATE request: nothing was sent, so sending the standard email cannot
            // duplicate it. It gets its own idempotency key because its body differs (the same key with a different
            // body would be a 409). A timeout, 429 or 5xx never comes here: those retry the same request later.
            console.error("email-send: Resend rejected the template request, sending the standard email", { job: job.id, status: res.status, error: errorName });
            ({ res, errorName } = await post(standard, `${job.id}:standard`));
          }
          const verdict = classifyProviderStatus(res.status, errorName);
          outcome = verdict.outcome;
          category = verdict.category;
          if (res.ok) {
            const parsed = await res.json().catch(() => null);
            messageId = typeof parsed?.id === "string" ? parsed.id : null;
          }
        } catch {
          outcome = NETWORK_FAILURE.outcome;
          category = NETWORK_FAILURE.category;
        }
      }
    } catch (err) {
      // Never log the address, the body or the provider's text: only the fixed category.
      console.error("email-send: job failed", { job: job.id, template: job.template, reason: err instanceof Error ? err.message : "unknown" });
    }

    const { data: state, error: completeError } = await db.rpc("complete_email_job", {
      p_id: job.id, p_outcome: outcome, p_message_id: messageId, p_error_category: category,
    });
    if (completeError) {
      // The lock expires and the job is picked up again; Resend's idempotency key prevents a second message.
      console.error("email-send: could not record outcome", { job: job.id, reason: completeError.message });
      continue;
    }
    if (state in tally) tally[state as keyof typeof tally]++;
  }

  console.log("email-send: batch", { claimed: (jobs ?? []).length, ...tally });
  return json({ processed: (jobs ?? []).length, ...tally });
});
