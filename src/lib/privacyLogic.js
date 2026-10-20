/**
 * Privacy features: the rules the screens follow, kept free of React and the
 * network so they can be tested on their own. The server (supabase/proposals/
 * 0030–0031) decides everything that matters — what is recorded, when, and for
 * whom. Nothing here records or grants anything.
 */

/** Marker the server leaves where a required club detail has not been supplied yet. */
export const NOT_PROVIDED = "[not yet provided]";

// ─── The notice text ────────────────────────────────────────────────────────

/**
 * Turns the notice's plain text into blocks to render: "## " headings,
 * "- " list items (consecutive ones become one list) and paragraphs.
 * Output is data, never HTML, so nothing in the text can inject markup.
 */
export function parseNotice(body) {
  const blocks = [];
  let list = null;
  const flush = () => {
    if (list) blocks.push({ type: "ul", items: list });
    list = null;
  };
  for (const raw of String(body ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
    } else if (line.startsWith("## ")) {
      flush();
      blocks.push({ type: "h2", text: line.slice(3).trim() });
    } else if (line.startsWith("- ")) {
      (list ??= []).push(line.slice(2).trim());
    } else {
      flush();
      blocks.push({ type: "p", text: line });
    }
  }
  flush();
  return blocks;
}

/** Splits a line into plain parts and "not yet provided" marks, so the marks can be highlighted. */
export function splitMarks(text) {
  return String(text ?? "")
    .split(NOT_PROVIDED)
    .flatMap((part, i, all) => (i < all.length - 1 ? [{ text: part, mark: false }, { text: NOT_PROVIDED, mark: true }] : [{ text: part, mark: false }]))
    .filter((p) => p.text !== "");
}

/** 'published' (in effect), 'draft' (shown, clearly marked, not in effect) or 'none'. */
export function noticeState(notice) {
  if (!notice) return "none";
  if (notice.published === true) return "published";
  return notice.body ? "draft" : "none";
}

/** Human labels for the club details still missing before a notice can be published (admin view). */
export const DETAIL_LABELS = {
  legal_entity_name: "Legal entity name",
  registered_address: "Registered address",
  privacy_contact_email: "Privacy contact email",
  grievance_officer_name: "Grievance contact name",
  grievance_officer_email: "Grievance contact email",
  retention_summary: "How long data is kept",
  children_policy_text: "Policy for under-18s",
  data_location_statement: "Where providers process data",
};

export const SETTING_LABELS = {
  ...DETAIL_LABELS,
  privacy_contact_phone: "Privacy contact phone (optional)",
  grievance_officer_phone: "Grievance contact phone (optional)",
  dpo_designation: "Role or designation of the contact (optional)",
  response_target_days: "Our own target for answering requests, in days (optional)",
  erasure_finalisation_enabled: "Allow account erasure to be carried out (true / false)",
  erasure_hold_days: "Waiting period before erasure, in days (optional)",
};

/** Long text settings are edited in a box; the rest in a single line. */
export const LONG_SETTINGS = new Set(["registered_address", "retention_summary", "children_policy_text", "data_location_statement"]);

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * What registration asks of the person. Only a notice that is actually
 * published can be acknowledged; until then the form shows a link to the
 * draft and registration carries on as before — nothing is recorded against a
 * draft, and nobody is blocked by it.
 */
export function registrationNotice(notice) {
  const state = noticeState(notice);
  return { state, mustAcknowledge: state === "published", version: state === "published" ? notice.version : null };
}

const PENDING_KEY = "chr.privacy.pending";

/**
 * Remembers WHICH notice version the person ticked at registration, so the
 * server can be asked to record it once they have a session. It is only a
 * reminder: the server stamps the time and the person, and re-checks the
 * version is the one currently published.
 */
export function rememberPendingAcknowledgement(storage, version) {
  try {
    if (version) storage?.setItem(PENDING_KEY, JSON.stringify({ version }));
  } catch {
    // Without storage the person simply sees the in-app notice banner instead.
  }
}

/** The remembered version if it is still the current one (and forgets it either way). */
export function takePendingAcknowledgement(storage, currentVersion) {
  try {
    const raw = storage?.getItem(PENDING_KEY);
    if (!raw) return null;
    storage.removeItem(PENDING_KEY);
    const { version } = JSON.parse(raw);
    return version && version === currentVersion ? version : null;
  } catch {
    return null;
  }
}

// ─── Choices ────────────────────────────────────────────────────────────────

/** How a purpose is shown: essential ones are information, optional ones are a switch. */
export function purposeView(p) {
  if (p.is_mandatory) return { kind: "required", on: true, label: "Needed to run your account" };
  const withdrawn = p.status === "withdrawn";
  return { kind: "switch", on: !withdrawn, label: withdrawn ? "Off" : "On" };
}

// ─── Requests ───────────────────────────────────────────────────────────────

export const REQUEST_TYPES = [
  { value: "access", label: "Ask what else you hold about me", needsDetails: false, hint: "The download above covers your member records. Ask here about anything else, such as staff notes." },
  { value: "correction", label: "Correct or update my data", needsDetails: true, hint: "Tell us what is wrong and what it should say. You can also edit your name and phone in Account." },
  { value: "grievance", label: "Raise a concern or complaint", needsDetails: true, hint: "Tell us what happened. We will answer you in writing." },
  { value: "nomination", label: "Nominate someone to act for me", needsDetails: true, hint: "Give the person's name and how we can reach them." },
  { value: "other", label: "Something else about my data", needsDetails: true, hint: "Any other question about how we handle your data." },
];

export const STATUS_LABEL = {
  submitted: "Received",
  in_progress: "Being handled",
  awaiting_requester: "We need something from you",
  completed: "Done",
  rejected: "Declined",
  cancelled: "Cancelled",
};

export const TYPE_LABEL = {
  access: "Copy of my data",
  correction: "Correction",
  erasure: "Close my account",
  consent_withdrawal: "Withdraw consent",
  grievance: "Complaint",
  nomination: "Nomination",
  other: "Other",
};

const OPEN = new Set(["submitted", "in_progress", "awaiting_requester"]);
export const isOpen = (status) => OPEN.has(status);
/** A member may withdraw a request only before anyone has started on it. */
export const canCancel = (status) => status === "submitted" || status === "awaiting_requester";

export const MAX_SUBJECT = 120;
export const MAX_DETAILS = 2000;

export function validateRequest({ type, subject = "", details = "" }) {
  const errors = {};
  const meta = REQUEST_TYPES.find((t) => t.value === type);
  if (!meta) errors.type = "Choose what you need.";
  if (subject.trim().length > MAX_SUBJECT) errors.subject = `Keep the title under ${MAX_SUBJECT} characters.`;
  if (details.trim().length > MAX_DETAILS) errors.details = `Keep this under ${MAX_DETAILS} characters.`;
  if (meta?.needsDetails && !details.trim()) errors.details = "Please tell us a little about this.";
  return errors;
}

/** "Due by 3 Nov": only when the club has set its own target; never an invented deadline. */
export function dueText(request, fmt = (d) => d) {
  return request?.due_at && isOpen(request.status) ? `We aim to answer by ${fmt(request.due_at)}.` : null;
}

// ─── The copy of a member's data ────────────────────────────────────────────

export function exportFileName(now = new Date()) {
  return `chr-my-data-${now.toISOString().slice(0, 10)}.json`;
}

// ─── Plain-language errors ──────────────────────────────────────────────────

const MESSAGES = {
  NOT_AUTHENTICATED: "Please sign in again.",
  NOTICE_NOT_PUBLISHED: "The privacy notice has not been published yet, so this cannot be recorded.",
  NOTICE_VERSION_MISMATCH: "The notice has changed since you opened it. Please read the current one and try again.",
  MANDATORY_PURPOSE: "This is needed to run your account. To stop it, ask to close your account instead.",
  ALREADY_REQUESTED: "You already have an open request of this kind. You can follow it under \"Your requests\".",
  PRIVILEGED_ACCOUNT: "Staff and admin accounts are closed by the club administrator.",
  TOO_MANY_OPEN_REQUESTS: "You have several open requests. Please wait until some are finished.",
  DETAILS_REQUIRED: "Please tell us a little about this.",
  TEXT_TOO_LONG: "That is too long. Please shorten it.",
  NOT_CANCELLABLE: "This request is already being handled, so it can no longer be withdrawn.",
  REQUEST_NOT_FOUND: "We could not find that request.",
  PUSH_WITHDRAWN: "Phone alerts are switched off for your account.",
};

export function friendlyPrivacyError(error) {
  const code = String(error?.message ?? "").trim();
  if (MESSAGES[code]) return error?.details && code !== "MANDATORY_PURPOSE" ? error.details : MESSAGES[code];
  if (/network|fetch|failed to fetch|timeout/i.test(code)) return "We could not reach the club's servers. Please check your connection and try again.";
  return "Something went wrong. Please try again.";
}
