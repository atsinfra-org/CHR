// Resend published-template adapter, for the membership_activated email ONLY. Pure functions: no Deno APIs,
// no network, no secrets, so it runs under Node in supabase/tests.
//
// OFF BY DEFAULT. email-send only uses it when the function secret EMAIL_MEMBERSHIP_TEMPLATE_ENABLED is exactly
// "true" AND EMAIL_MEMBERSHIP_TEMPLATE_VARIABLES lists the variables the published template really registered.
// Every other email type, and every failure here, stays on the existing HTML/text rendering in templates.ts.
//
// How Resend is called (https://resend.com/docs/api-reference/emails/send-email):
//   POST /emails  { from, to, reply_to, subject, template: { id, variables: { KEY: "value" } } }
//   * `template.id` is the template's UUID or its alias. Only a PUBLISHED template can be sent.
//   * `html`, `text` and `react` must NOT be sent together with `template` (validation error).
//   * `subject`, `from` and `reply_to` in the payload override the template's own defaults.
//   * variable keys: ASCII letters, digits and underscore, at most 50 characters; FIRST_NAME, LAST_NAME, EMAIL,
//     UNSUBSCRIBE_URL (and contact, this) are reserved. String values are at most 2000 characters.
//   * if the template uses a variable that is not supplied (and has no fallback) the send fails with a validation error.
//
// Variables inside the template are written {{{KEY}}} (triple braces) and are registered as variables in the
// Resend editor. A placeholder typed as plain text, for example {{name}}, is NOT a registered variable: the dashboard
// shows "No variables" and the placeholder would reach the member as literal text. analyseTemplate() detects that.
import { dayLabel, esc } from "./templates.ts";

type Json = Record<string, any>;

/** The published "Membership Confirmation" template. Its alias is membership-confirmation. */
export const DEFAULT_MEMBERSHIP_TEMPLATE_ID = "f394ace4-e556-4438-a4ec-102bb7851989";

export const RESERVED_VARIABLE_KEYS = ["FIRST_NAME", "LAST_NAME", "EMAIL", "UNSUBSCRIBE_URL", "contact", "this"];
export const MAX_VARIABLE_VALUE_LENGTH = 2000;
export const MAX_VARIABLE_KEY_LENGTH = 50;

/** HTTP statuses that mean Resend definitively REJECTED the template request (nothing was sent). */
export const TEMPLATE_REJECTED_STATUSES = [400, 404, 422];

const CLUB_FALLBACK_NAME = "Colonel Horse Riding Club";

type Spec = {
  key: string;
  /** Required: when the database has no value, the template is not used at all (the standard email is sent). */
  required: boolean;
  value: (ctx: Json, linkBase: string | null) => string;
};

const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());

/**
 * Every variable this adapter can supply, mapped to real fields of email_job_context('membership_activated'):
 *   ctx.member_name                      profiles.full_name (or the email's local part)
 *   ctx.membership.{name,credits,start_date,end_date,reschedules_allowed}   memberships + membership_plans
 *   ctx.business.{name,address,contact_email,contact_phone}                 privacy + receipt settings
 *   linkBase                             EMAIL_LINK_BASE_URL (https only)
 * Values are HTML-escaped here because a {{{triple brace}}} placeholder is, by the usual convention, inserted
 * unescaped and a member's name is typed by the member. (Whether Resend escapes again is not documented; the first
 * live test checks a name containing an apostrophe and an ampersand.)
 */
export const MEMBERSHIP_VARIABLES: Spec[] = [
  { key: "MEMBER_NAME", required: false, value: (c) => esc(text(c.member_name) || "there") },
  { key: "PLAN_NAME", required: true, value: (c) => esc(text(c.membership?.name)) },
  { key: "CLASS_CREDITS", required: true, value: (c) => esc(text(c.membership?.credits)) },
  { key: "START_DATE", required: true, value: (c) => esc(dayLabel(c.membership?.start_date)) },
  { key: "END_DATE", required: true, value: (c) => esc(dayLabel(c.membership?.end_date)) },
  { key: "RESCHEDULES_ALLOWED", required: false, value: (c) => esc(text(c.membership?.reschedules_allowed)) },
  { key: "DASHBOARD_URL", required: false, value: (_c, base) => (base ? esc(base + "/account") : "") },
  { key: "CLUB_NAME", required: false, value: (c) => esc(text(c.business?.name) || CLUB_FALLBACK_NAME) },
  { key: "CLUB_ADDRESS", required: false, value: (c) => esc(text(c.business?.address)) },
  { key: "CLUB_CONTACT_EMAIL", required: false, value: (c) => esc(text(c.business?.contact_email)) },
  { key: "CLUB_CONTACT_PHONE", required: false, value: (c) => esc(text(c.business?.contact_phone)) },
];

export const SUPPORTED_VARIABLE_KEYS = MEMBERSHIP_VARIABLES.map((s) => s.key);

export type TemplateRequest =
  | { ok: true; template: { id: string; variables: Record<string, string> } }
  | { ok: false; reason: "wrong_template" | "missing_membership" | "missing_required" | "unsupported_variable" | "not_configured"; missing?: string[] };

/**
 * Parses EMAIL_MEMBERSHIP_TEMPLATE_VARIABLES, a comma-separated list such as "MEMBER_NAME,PLAN_NAME,START_DATE".
 * Returns null when it is unset or blank: the adapter then refuses to run, because sending variables the template
 * did not register (or leaving out ones it did) is exactly what makes Resend reject the send.
 */
export function parseDeclaredVariables(raw: string | null | undefined): string[] | null {
  const list = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? [...new Set(list)] : null;
}

/** The template id/alias to use: the secret if it is a UUID or a lower-case alias, otherwise the published default. */
export function resolveTemplateId(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || /^[a-z0-9][a-z0-9_-]{0,63}$/.test(v) ? v : DEFAULT_MEMBERSHIP_TEMPLATE_ID;
}

/**
 * Builds the `template` object for a membership_activated job, or says why it must not be used.
 * `declared` is the list of variables the published template registered (null = not configured).
 * Nothing here throws: any problem simply means "use the standard email".
 */
export function buildMembershipTemplateRequest(
  ctx: Json,
  opts: { templateId?: string | null; linkBase?: string | null; declared: string[] | null },
): TemplateRequest {
  if (ctx?.template !== "membership_activated") return { ok: false, reason: "wrong_template" };
  if (!ctx.membership || typeof ctx.membership !== "object") return { ok: false, reason: "missing_membership" };
  if (!opts.declared) return { ok: false, reason: "not_configured" };

  const unsupported = opts.declared.filter((k) => !SUPPORTED_VARIABLE_KEYS.includes(k));
  if (unsupported.length) return { ok: false, reason: "unsupported_variable", missing: unsupported };

  const base = opts.linkBase ?? null;
  const variables: Record<string, string> = {};
  const missing: string[] = [];
  for (const spec of MEMBERSHIP_VARIABLES) {
    if (!opts.declared.includes(spec.key)) continue;
    const v = spec.value(ctx, base);
    if (v === "") {
      // A required value that is not in the database means the template cannot be filled in honestly.
      if (spec.required) missing.push(spec.key);
      continue; // optional and empty: left out (give the variable a fallback value in Resend)
    }
    variables[spec.key] = v.length > MAX_VARIABLE_VALUE_LENGTH ? v.slice(0, MAX_VARIABLE_VALUE_LENGTH) : v;
  }
  if (missing.length) return { ok: false, reason: "missing_required", missing };
  return { ok: true, template: { id: resolveTemplateId(opts.templateId), variables } };
}

// ─── Diagnosis of the published template (used by supabase/tools/inspect-resend-template.cjs) ──────────────────

const TRIPLE = /\{\{\{\s*([A-Za-z0-9_]+)\s*\}\}\}/g;
const DOUBLE = /(?<!\{)\{\{\s*([^{}]+?)\s*\}\}(?!\})/g;

export type TemplateAnalysis = {
  published: boolean;
  hasUnpublishedChanges: boolean;
  registered: string[];
  triplePlaceholders: string[];
  literalDoublePlaceholders: string[];
  registeredButUnused: string[];
  usedButNotRegistered: string[];
  unsupportedByAdapter: string[];
  reserved: string[];
  requiredNotRegistered: string[];
  suggestedDeclared: string;
  verdict: "ready" | "not_ready";
  problems: string[];
};

/** Reads a template as returned by GET https://api.resend.com/templates/{id} and says whether it can be used. */
export function analyseTemplate(t: Json): TemplateAnalysis {
  const html = String(t?.html ?? "") + "\n" + String(t?.text ?? "");
  const registered: string[] = (Array.isArray(t?.variables) ? t.variables : []).map((v: Json) => String(v?.key)).filter(Boolean);
  const names = (re: RegExp) => [...new Set([...html.matchAll(re)].map((m) => m[1]))];
  const triple = names(TRIPLE);
  const literalDouble = names(DOUBLE);
  const published = t?.status === "published";
  const problems: string[] = [];

  const registeredButUnused = registered.filter((k) => !triple.includes(k));
  const usedButNotRegistered = triple.filter((k) => !registered.includes(k));
  const unsupported = registered.filter((k) => !SUPPORTED_VARIABLE_KEYS.includes(k));
  const reserved = registered.filter((k) => RESERVED_VARIABLE_KEYS.includes(k));
  const requiredNotRegistered = MEMBERSHIP_VARIABLES.filter((s) => s.required && !registered.includes(s.key)).map((s) => s.key);

  if (!published) problems.push("The template is not published, so it cannot be sent.");
  if (t?.has_unpublished_versions) problems.push("There are unpublished edits: only the last published version is sent. Publish again.");
  if (!registered.length) problems.push("The template has NO registered variables (the dashboard shows 'No variables').");
  if (literalDouble.length) problems.push(`These placeholders are plain text, not variables, and would reach the member as literal text: ${literalDouble.map((n) => `{{${n}}}`).join(", ")}. Insert them as variables in the editor (they are written {{{NAME}}}).`);
  if (usedButNotRegistered.length) problems.push(`Used in the body but not registered: ${usedButNotRegistered.join(", ")}.`);
  if (unsupported.length) problems.push(`Registered but not supplied by email-send (a send would fail): ${unsupported.join(", ")}. Supported names: ${SUPPORTED_VARIABLE_KEYS.join(", ")}.`);
  if (reserved.length) problems.push(`Reserved names cannot be used as variables: ${reserved.join(", ")}.`);
  if (requiredNotRegistered.length) problems.push(`The template does not register ${requiredNotRegistered.join(", ")}, which carry the real membership details.`);

  return {
    published, hasUnpublishedChanges: !!t?.has_unpublished_versions, registered, triplePlaceholders: triple,
    literalDoublePlaceholders: literalDouble, registeredButUnused, usedButNotRegistered, unsupportedByAdapter: unsupported,
    reserved, requiredNotRegistered, suggestedDeclared: registered.join(","),
    verdict: problems.length === 0 ? "ready" : "not_ready", problems,
  };
}
