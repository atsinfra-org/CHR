import { useCallback, useEffect, useState } from "react";
import { Download, FileText, Trash2 } from "lucide-react";
import AccountStateGuard from "./AccountStateGuard";
import { ActionButton, Card, CardSkeleton, ConfirmDialog, EmptyState, ErrorState, InlineError, PageHeader, SectionHeader, StatusPill, useToast } from "./ui";
import { formatDate } from "./dashboardUtils";
import { cancelRequest, downloadJson, exportMyData, getMyConsents, getMyRequests, recordConsent, submitRequest } from "../lib/privacyApi";
import {
  MAX_DETAILS,
  REQUEST_TYPES,
  STATUS_LABEL,
  TYPE_LABEL,
  canCancel,
  dueText,
  exportFileName,
  isOpen,
  purposeView,
  validateRequest,
} from "../lib/privacyLogic";
import { usePrivacyNotice } from "../privacy/usePrivacyNotice";
import { ContactBox } from "../privacy/LegalLayout";

const FIELD =
  "mt-1.5 block w-full rounded-[10px] border border-charcoal/15 bg-white px-3.5 py-2.5 font-sans text-sm text-charcoal outline-none transition-colors placeholder:text-warm-grey/60 focus:border-antique-gold";

/**
 * Privacy & data: the notice, the member's choices, a copy of their data, requests and complaints, and closing
 * the account. Every control here calls a server function that checks who is asking and records what happened
 * (supabase/proposals/0030–0031); nothing is decided or stored in the browser.
 */
export default function PrivacyPage() {
  return <AccountStateGuard active="privacy">{() => <Privacy />}</AccountStateGuard>;
}

function Privacy() {
  const { notify } = useToast();
  const { config } = usePrivacyNotice();
  const [consents, setConsents] = useState({ status: "loading", data: null, error: null });
  const [requests, setRequests] = useState({ status: "loading", data: null, error: null });

  const loadConsents = useCallback(async () => {
    const { data, error } = await getMyConsents();
    setConsents(error ? { status: "error", data: null, error } : { status: "ready", data, error: null });
  }, []);
  const loadRequests = useCallback(async () => {
    const { data, error } = await getMyRequests();
    setRequests(error ? { status: "error", data: null, error } : { status: "ready", data: data ?? [], error: null });
  }, []);

  useEffect(() => {
    loadConsents();
    loadRequests();
  }, [loadConsents, loadRequests]);

  const openErasure = (requests.data ?? []).find((r) => r.request_type === "erasure" && isOpen(r.status));

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <PageHeader title="Privacy & data" description="How your data is used, the choices you have, and how to ask us about it." />
      <div className="space-y-6">
        <NoticeCard state={consents} onChanged={loadConsents} notify={notify} />
        <ChoicesCard state={consents} onChanged={loadConsents} notify={notify} />
        <DataCard notify={notify} onSubmitted={loadRequests} />
        <RequestsCard state={requests} onChanged={loadRequests} notify={notify} />
        <CloseAccountCard openRequest={openErasure} loaded={requests.status === "ready"} onChanged={loadRequests} notify={notify} />
        <Card>
          <SectionHeader title="Contact" hint="For privacy questions and complaints." />
          <ContactBox config={config} />
        </Card>
      </div>
    </div>
  );
}

// ─── Notice ─────────────────────────────────────────────────────────────────

function NoticeCard({ state, onChanged, notify }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const d = state.data;

  async function acknowledge() {
    setBusy(true);
    setError(null);
    const { error: err } = await recordConsent("membership_service", "granted", d.current_notice_version);
    setBusy(false);
    if (err) return setError(err);
    notify("Thank you. We have recorded that you read the notice.");
    onChanged();
  }

  return (
    <Card>
      <SectionHeader title="Privacy Notice" action={<ActionButton href="/privacy" variant="secondary" icon={FileText}>Read</ActionButton>} />
      {state.status === "loading" && <CardSkeleton lines={2} />}
      {state.status === "error" && <InlineError message={state.error} />}
      {state.status === "ready" && (
        <div className="font-sans text-sm leading-relaxed text-warm-grey">
          {d.current_notice_version ? (
            d.needs_acknowledgement ? (
              <>
                <p>Version {d.current_notice_version} is in effect. You have not told us you have read it.</p>
                <div className="mt-3">
                  <ActionButton variant="primary" loading={busy} onClick={acknowledge}>I have read it</ActionButton>
                </div>
                {error && <div className="mt-3"><InlineError message={error} /></div>}
              </>
            ) : (
              <p>You have read version {d.acknowledged_notice_version}, the current notice.</p>
            )
          ) : (
            <p>The club&apos;s notice is still being finalised. You can read the draft, which is not yet in effect.</p>
          )}
        </div>
      )}
    </Card>
  );
}

// ─── Choices ────────────────────────────────────────────────────────────────

function ChoicesCard({ state, onChanged, notify }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const d = state.data;

  async function toggle(p) {
    const view = purposeView(p);
    setBusy(p.purpose);
    setError(null);
    const { error: err } = view.on
      ? await recordConsent(p.purpose, "withdrawn")
      : await recordConsent(p.purpose, "granted", d.current_notice_version);
    setBusy(null);
    if (err) return setError(err);
    notify(view.on ? `${p.title} turned off.` : `${p.title} turned on.`);
    onChanged();
  }

  return (
    <Card>
      <SectionHeader title="Your choices" hint="Changing an optional choice never affects your membership or bookings." />
      {state.status === "loading" && <CardSkeleton lines={3} />}
      {state.status === "error" && <InlineError message={state.error} />}
      {state.status === "ready" && (
        <ul className="divide-y divide-antique-gold/15">
          {d.purposes.map((p) => {
            const view = purposeView(p);
            return (
              <li key={p.purpose} className="flex items-start justify-between gap-4 py-3.5 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="font-sans text-sm font-medium text-charcoal">{p.title}</p>
                  <p className="mt-0.5 font-sans text-[13px] leading-relaxed text-warm-grey">{p.description}</p>
                  {view.kind === "switch" && p.purpose === "push_notifications" && !view.on && (
                    <p className="mt-1 font-sans text-xs text-warm-grey">Your phone&apos;s alert code has been removed from our systems.</p>
                  )}
                </div>
                {view.kind === "required" ? (
                  <span className="shrink-0 font-sans text-xs text-warm-grey">{view.label}</span>
                ) : (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={view.on}
                    aria-label={`${p.title}: ${view.label}`}
                    disabled={busy === p.purpose}
                    onClick={() => toggle(p)}
                    className={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-60 ${view.on ? "bg-racing-green" : "bg-charcoal/25"}`}
                  >
                    <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${view.on ? "left-6" : "left-1"}`} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && <div className="mt-3"><InlineError message={error} /></div>}
    </Card>
  );
}

// ─── Your data ──────────────────────────────────────────────────────────────

function DataCard({ notify, onSubmitted }) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(null);
  const [form, setForm] = useState({ type: "correction", subject: "", details: "" });
  const [errors, setErrors] = useState({});
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const meta = REQUEST_TYPES.find((t) => t.value === form.type);

  async function download() {
    setDownloading(true);
    setDownloadError(null);
    const { data, error } = await exportMyData();
    setDownloading(false);
    if (error) return setDownloadError(error);
    downloadJson(exportFileName(), data);
    notify("Your data has been downloaded.");
  }

  async function send(e) {
    e.preventDefault();
    if (sending) return;
    const found = validateRequest(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSending(true);
    setSendError(null);
    const { error } = await submitRequest(form);
    setSending(false);
    if (error) return setSendError(error);
    notify("We received your request.");
    setForm({ type: form.type, subject: "", details: "" });
    onSubmitted();
  }

  return (
    <Card>
      <SectionHeader title="Your data" hint="Get a copy, ask for a correction, or tell us a concern." />

      <div className="rounded-[12px] border border-antique-gold/20 bg-soft-cream/40 p-4">
        <p className="font-sans text-sm font-medium text-charcoal">Download a copy of your data</p>
        <p className="mt-1 font-sans text-[13px] leading-relaxed text-warm-grey">
          Your profile, memberships, bookings, payments, orders and choices, as a file. It leaves out staff notes, security records and anything held by our
          service providers.
        </p>
        <div className="mt-3">
          <ActionButton variant="secondary" icon={Download} loading={downloading} onClick={download}>Download</ActionButton>
        </div>
        {downloadError && <div className="mt-3"><InlineError message={downloadError} /></div>}
      </div>

      <form onSubmit={send} className="mt-5 space-y-4" noValidate>
        <p className="font-sans text-sm font-medium text-charcoal">Make a request</p>
        <div>
          <label htmlFor="pr-type" className="font-sans text-xs tracking-[0.12em] text-warm-grey uppercase">What do you need?</label>
          <select id="pr-type" className={FIELD} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {REQUEST_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          {meta && <p className="mt-1.5 font-sans text-xs text-warm-grey">{meta.hint}</p>}
          {errors.type && <p className="mt-1 font-sans text-xs text-destructive" role="alert">{errors.type}</p>}
        </div>
        <div>
          <label htmlFor="pr-subject" className="font-sans text-xs tracking-[0.12em] text-warm-grey uppercase">Title (optional)</label>
          <input id="pr-subject" className={FIELD} maxLength={120} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          {errors.subject && <p className="mt-1 font-sans text-xs text-destructive" role="alert">{errors.subject}</p>}
        </div>
        <div>
          <label htmlFor="pr-details" className="font-sans text-xs tracking-[0.12em] text-warm-grey uppercase">Details{meta?.needsDetails ? "" : " (optional)"}</label>
          <textarea id="pr-details" rows={4} className={FIELD} maxLength={MAX_DETAILS} value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} aria-invalid={Boolean(errors.details)} />
          <p className="mt-1 text-right font-sans text-[11px] text-warm-grey">{form.details.length}/{MAX_DETAILS}</p>
          {errors.details && <p className="font-sans text-xs text-destructive" role="alert">{errors.details}</p>}
        </div>
        {sendError && <InlineError message={sendError} />}
        <ActionButton type="submit" variant="primary" loading={sending}>Send request</ActionButton>
      </form>
    </Card>
  );
}

// ─── Requests ───────────────────────────────────────────────────────────────

function RequestsCard({ state, onChanged, notify }) {
  const [cancelling, setCancelling] = useState(null);
  const [error, setError] = useState(null);

  async function cancel(id) {
    setCancelling(id);
    setError(null);
    const { error: err } = await cancelRequest(id);
    setCancelling(null);
    if (err) return setError(err);
    notify("Request withdrawn.");
    onChanged();
  }

  return (
    <Card>
      <SectionHeader title="Your requests" />
      {state.status === "loading" && <CardSkeleton lines={3} />}
      {state.status === "error" && <ErrorState title="We could not load your requests" detail={state.error} onRetry={onChanged} />}
      {state.status === "ready" && state.data.length === 0 && <EmptyState icon={FileText} title="No requests yet" detail="Requests you make will appear here with their progress." />}
      {state.status === "ready" && state.data.length > 0 && (
        <ul className="divide-y divide-antique-gold/15">
          {state.data.map((r) => (
            <li key={r.id} className="py-3.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-sans text-sm font-medium text-charcoal">{r.subject || TYPE_LABEL[r.request_type] || "Request"}</p>
                <StatusPill value={r.status} label={STATUS_LABEL[r.status]} />
              </div>
              <p className="mt-0.5 font-sans text-xs text-warm-grey">
                {TYPE_LABEL[r.request_type]} · sent {formatDate(r.submitted_at)}
                {r.resolved_at ? ` · closed ${formatDate(r.resolved_at)}` : ""}
              </p>
              {dueText(r, formatDate) && <p className="mt-0.5 font-sans text-xs text-warm-grey">{dueText(r, formatDate)}</p>}
              {r.resolution_note && <p className="mt-1.5 rounded-[8px] bg-soft-cream/60 px-3 py-2 font-sans text-[13px] text-charcoal">{r.resolution_note}</p>}
              {canCancel(r.status) && (
                <div className="mt-2">
                  <ActionButton variant="ghost" loading={cancelling === r.id} onClick={() => cancel(r.id)}>Withdraw this request</ActionButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <div className="mt-3"><InlineError message={error} /></div>}
    </Card>
  );
}

// ─── Close account ──────────────────────────────────────────────────────────

function CloseAccountCard({ openRequest, loaded, onChanged, notify }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function request() {
    setBusy(true);
    setError(null);
    const { error: err } = await submitRequest({ type: "erasure" });
    setBusy(false);
    if (err) {
      setConfirming(false);
      return setError(err);
    }
    setConfirming(false);
    notify("We received your request to close your account.");
    onChanged();
  }

  return (
    <Card>
      <SectionHeader title="Close my account" />
      <p className="font-sans text-sm leading-relaxed text-warm-grey">
        This asks the club to remove your name, contact details and date of birth, delete your alert codes, notifications and schedules, and stop your
        sign-in. Records the club must keep, such as payments, orders, memberships and attendance history, stay without your identifying details where
        possible. It cannot be undone. If you have an active membership, upcoming bookings or an unpaid order, we will tell you what needs to happen
        first. Read more on the <a className="text-racing-green underline underline-offset-4" href="/account-deletion">account closure page</a>.
      </p>
      {openRequest ? (
        <p className="mt-4 rounded-[10px] border border-antique-gold/25 bg-soft-cream/50 px-4 py-3 font-sans text-sm text-charcoal">
          Your request is open: <strong>{STATUS_LABEL[openRequest.status]}</strong>. You can follow it under Your requests.
        </p>
      ) : (
        <div className="mt-4">
          <ActionButton variant="danger" icon={Trash2} disabled={!loaded} onClick={() => setConfirming(true)}>Close my account</ActionButton>
        </div>
      )}
      {error && <div className="mt-3"><InlineError message={error} /></div>}
      <ConfirmDialog
        open={confirming}
        title="Close your account?"
        description="You will not be able to sign in once this is finished, and it cannot be undone. We will check first whether anything needs settling, such as an active membership or upcoming classes, and let you know."
        confirmLabel="Yes, close my account"
        cancelLabel="Keep my account"
        danger
        busy={busy}
        onConfirm={request}
        onClose={() => !busy && setConfirming(false)}
      />
    </Card>
  );
}
