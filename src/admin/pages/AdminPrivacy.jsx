import { useMemo, useState } from "react";
import { AlertTriangle, Download, FileSearch, Lock, RefreshCw, ScrollText, UserRoundX } from "lucide-react";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import {
  ActionButton,
  Card,
  DetailDrawer,
  Empty,
  ErrorBox,
  Field,
  InlineError,
  Loading,
  PageHeader,
  SectionHeader,
  SelectField,
  StatCard,
  StatGrid,
  StatusPill,
  TableShell,
  Toolbar,
} from "../ui";
import { fmtDateTime } from "../adminUtils";
import { downloadJson } from "../../lib/privacyApi";
import { DETAIL_LABELS, LONG_SETTINGS, SETTING_LABELS, STATUS_LABEL, TYPE_LABEL, exportFileName, isOpen } from "../../lib/privacyLogic";

// The ways an administrator can check that a request really comes from the account holder (0032).
const IDENTITY_METHODS = [
  ["phone_callback", "Called back on the number on file"],
  ["email_confirmation", "Confirmed from the email address on file"],
  ["in_person", "Checked in person at the club"],
  ["other", "Another way (say how in the note)"],
];
const METHOD_LABEL = Object.fromEntries(IDENTITY_METHODS);
const CONSENT_ACTION_LABEL = { granted: "Allowed", withdrawn: "Withdrawn", notice_acknowledged: "Read the notice" };
// Categories the retention executor may ever act on. Everything else is reviewed and removed by hand, never by a timer.
const AUTOMATED_CATEGORIES = new Set(["notifications", "push_devices_disabled", "push_deliveries", "enquiries", "attendance_notes"]);

const TABS = [
  ["requests", "Requests"],
  ["notice", "Notice & details"],
  ["consent", "Consent & audit"],
  ["retention", "Retention"],
];

const FIELD =
  "mt-1.5 block w-full rounded-[10px] border border-charcoal/15 bg-white px-3.5 py-2.5 font-sans text-sm text-charcoal outline-none focus:border-antique-gold";

/**
 * Privacy administration (admin only; every function enforces that in the database, and the page is hidden from
 * staff as a convenience). Nothing here fabricates consent or bypasses a deletion safeguard: consent records are
 * read-only, and account erasure is carried out by guarded server functions that refuse unless every condition holds.
 */
export default function AdminPrivacy() {
  const [tab, setTab] = useState("requests");
  const overview = useAdminQuery(() => adminApi.privacyOverview());
  const o = overview.data;

  return (
    <div>
      <PageHeader
        route="privacy"
        actions={
          <ActionButton icon={RefreshCw} onClick={overview.reload}>
            Refresh
          </ActionButton>
        }
      />

      {overview.status === "error" && <ErrorBox message={overview.error} onRetry={overview.reload} />}
      {o && (
        <>
          <StatGrid>
            <StatCard icon={FileSearch} label="Open requests" value={o.requests_open} hint={o.requests_overdue > 0 ? `${o.requests_overdue} past the club's own target` : "None past target"} tone={o.requests_overdue > 0 ? "default" : "accent"} />
            <StatCard icon={UserRoundX} label="Account closures open" value={o.erasure_open} />
            <StatCard icon={ScrollText} label="Notice in effect" value={o.notice_published_version ?? "None"} hint={o.notice_published_version ? "" : "Not published yet"} />
            <StatCard icon={Lock} label="Retention rules approved" value={`${9 - o.retention_rules_unapproved} of 9`} hint={o.retention_rules_unapproved > 0 ? "Awaiting a business decision" : ""} />
          </StatGrid>
          {o.club_details_missing.length > 0 && (
            <div role="note" className="mt-4 flex gap-3 rounded-[14px] border border-warning/35 bg-warning/[0.07] p-4">
              <AlertTriangle size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warning" />
              <p className="font-sans text-sm leading-relaxed text-charcoal">
                The privacy notice cannot be published until these club details are supplied (Notice &amp; details):{" "}
                {o.club_details_missing.map((k) => DETAIL_LABELS[k] ?? k).join(", ")}.
              </p>
            </div>
          )}
          {o.members_under_18 > 0 && (
            <div role="note" className="mt-3 flex gap-3 rounded-[14px] border border-warning/35 bg-warning/[0.07] p-4">
              <AlertTriangle size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warning" />
              <p className="font-sans text-sm leading-relaxed text-charcoal">
                {o.members_under_18} member{o.members_under_18 === 1 ? "" : "s"} appear{o.members_under_18 === 1 ? "s" : ""} to be under 18 (from the date of birth given). The Rules require a parent&apos;s verifiable
                consent for a child&apos;s data, and no mechanism for that exists yet: this needs a legal and business decision before the substantive rules start.
              </p>
            </div>
          )}
        </>
      )}

      <div role="tablist" className="mt-6 flex flex-wrap gap-1.5 border-b border-antique-gold/20">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-4 py-2.5 font-sans text-xs tracking-[0.14em] uppercase transition-colors ${tab === key ? "border-racing-green text-racing-green" : "border-transparent text-warm-grey hover:text-charcoal"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "requests" && <RequestsTab onChanged={overview.reload} />}
        {tab === "notice" && <NoticeTab onChanged={overview.reload} />}
        {tab === "consent" && <ConsentTab overview={o} />}
        {tab === "retention" && <RetentionTab onChanged={overview.reload} />}
      </div>
    </div>
  );
}

// ─── Requests ───────────────────────────────────────────────────────────────

function RequestsTab({ onChanged }) {
  const [filter, setFilter] = useState("open");
  const q = useAdminQuery(() => adminApi.privacyRequests(null), []);
  const [selectedId, setSelectedId] = useState(null);

  const rows = useMemo(() => {
    const all = q.data ?? [];
    return filter === "open" ? all.filter((r) => isOpen(r.status)) : filter === "all" ? all : all.filter((r) => r.status === filter);
  }, [q.data, filter]);
  const selected = (q.data ?? []).find((r) => r.id === selectedId) ?? null;

  const changed = () => {
    q.reload();
    onChanged();
  };

  return (
    <div>
      <Toolbar>
        <SelectField label="Show" value={filter} onChange={setFilter}>
          <option value="open">Open</option>
          <option value="all">All</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </SelectField>
      </Toolbar>
      {q.status === "loading" && <Loading />}
      {q.status === "error" && <ErrorBox message={q.error} onRetry={q.reload} />}
      {q.status === "ready" && rows.length === 0 && <Empty>No requests to show.</Empty>}
      {q.status === "ready" && rows.length > 0 && (
        <TableShell head={["Member", "Type", "Status", "Received", "Target", ""]}>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-charcoal/5 last:border-0">
              <td className="px-4 py-3 font-sans text-sm text-charcoal">
                {r.member_name || "—"}
                <span className="block text-xs text-warm-grey">{r.member_email || ""}</span>
              </td>
              <td className="px-4 py-3 font-sans text-sm text-charcoal">{TYPE_LABEL[r.request_type]}</td>
              <td className="px-4 py-3"><StatusPill value={r.status} /></td>
              <td className="px-4 py-3 font-sans text-sm text-warm-grey">{fmtDateTime(r.submitted_at)}</td>
              <td className={`px-4 py-3 font-sans text-sm ${r.overdue ? "text-destructive" : "text-warm-grey"}`}>{r.due_at ? fmtDateTime(r.due_at) : "—"}</td>
              <td className="px-4 py-3 text-right"><ActionButton onClick={() => setSelectedId(r.id)}>Open</ActionButton></td>
            </tr>
          ))}
        </TableShell>
      )}
      <RequestDrawer request={selected} onClose={() => setSelectedId(null)} onChanged={changed} />
    </div>
  );
}

function RequestDrawer({ request: r, onClose, onChanged }) {
  const events = useAdminQuery(() => (r ? adminApi.privacyRequestEvents(r.id) : Promise.resolve({ data: [], error: null })), [r?.id]);
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [preflight, setPreflight] = useState(null);
  const [sure, setSure] = useState(false);

  if (!r) return <DetailDrawer open={false} onClose={onClose} title="" />;
  const open = isOpen(r.status);

  async function run(name, fn, after) {
    setBusy(name);
    setError(null);
    const res = await fn();
    setBusy(null);
    if (res.error) return setError(res.error);
    after?.(res.data);
    events.reload();
    onChanged();
  }

  const save = () => run("save", () => adminApi.updatePrivacyRequest(r.id, status || null, null, note || null), () => { setNote(""); setStatus(""); });
  const download = () => run("export", () => adminApi.exportMemberData(r.id), (data) => downloadJson(exportFileName(), data));
  const check = () => run("preflight", () => adminApi.erasurePreflight(r.id), setPreflight);
  const erase = () => run("erase", () => adminApi.carryOutErasure(r.id), () => { setPreflight(null); setSure(false); });

  return (
    <DetailDrawer open onClose={onClose} title={`${TYPE_LABEL[r.request_type]} request`} subtitle={`${r.member_name || "Member"} · ${r.member_email || ""}`}>
      <dl className="grid grid-cols-2 gap-4">
        <Field label="Status" value={<StatusPill value={r.status} />} />
        <Field label="Received" value={fmtDateTime(r.submitted_at)} />
        <Field label="The club's own target" value={r.due_at ? fmtDateTime(r.due_at) : "Not set"} />
        <Field label="Assigned to" value={r.assigned_name || "Nobody yet"} />
      </dl>
      {(r.subject || r.details) && (
        <div className="mt-5 rounded-[12px] border border-antique-gold/20 bg-soft-cream/40 p-4">
          <p className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">What the member wrote</p>
          {r.subject && <p className="mt-1 font-sans text-sm font-medium text-charcoal">{r.subject}</p>}
          {r.details && <p className="mt-1 font-sans text-sm whitespace-pre-line text-charcoal">{r.details}</p>}
        </div>
      )}
      {r.resolution_note && <p className="mt-4 font-sans text-sm text-charcoal"><strong>Outcome:</strong> {r.resolution_note}</p>}

      {open && (
        <div className="mt-6 space-y-4 border-t border-antique-gold/20 pt-5">
          <p className="font-sans text-sm font-medium text-charcoal">Handle this request</p>
          <SelectField label="Change status" value={status} onChange={setStatus}>
            <option value="">Keep as it is</option>
            <option value="in_progress">Being handled</option>
            <option value="awaiting_requester">We need something from the member</option>
            {r.request_type !== "erasure" && <option value="completed">Done</option>}
            <option value="rejected">Declined</option>
          </SelectField>
          <div>
            <label htmlFor="pv-note" className="font-sans text-xs tracking-[0.12em] text-warm-grey uppercase">Note (kept in the record; never paste personal data)</label>
            <textarea id="pv-note" rows={3} maxLength={1000} className={FIELD} value={note} onChange={(e) => setNote(e.target.value)} />
            <p className="mt-1 font-sans text-xs text-warm-grey">Required when marking Done or Declined; the member sees it.</p>
          </div>
          <ActionButton variant="primary" disabled={!status && !note} onClick={save}>
            {busy === "save" ? "Saving…" : "Save"}
          </ActionButton>

          {(r.request_type === "access" || r.request_type === "erasure") && <IdentityCheck request={r} onDone={onChanged} />}

          {r.request_type === "access" && (
            <div className="rounded-[12px] border border-antique-gold/20 p-4">
              <p className="font-sans text-sm font-medium text-charcoal">Produce the member&apos;s copy</p>
              <p className="mt-1 font-sans text-xs leading-relaxed text-warm-grey">Downloads the same copy the member can get themselves. This is recorded in the audit log.</p>
              <div className="mt-3"><ActionButton icon={Download} onClick={download}>{busy === "export" ? "Preparing…" : "Download copy"}</ActionButton></div>
            </div>
          )}

          {r.request_type === "erasure" && (
            <div className="rounded-[12px] border border-destructive/25 p-4">
              <p className="font-sans text-sm font-medium text-charcoal">Close this account</p>
              <p className="mt-1 font-sans text-xs leading-relaxed text-warm-grey">
                First check what would happen. The database refuses unless erasure is switched on, the request is being handled, the waiting period has passed,
                and nothing is outstanding. It never cancels or refunds anything itself.
              </p>
              <div className="mt-3"><ActionButton onClick={check}>{busy === "preflight" ? "Checking…" : "Check what would happen"}</ActionButton></div>
              {preflight && <Preflight p={preflight} />}
              {preflight?.can_execute && (
                <div className="mt-4 space-y-3 border-t border-destructive/20 pt-4">
                  <label className="flex items-start gap-2.5 font-sans text-[13px] leading-snug text-charcoal">
                    <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} className="mt-0.5 h-4 w-4 accent-racing-green" />
                    I understand this removes the member&apos;s details and disables their sign-in, and cannot be undone.
                  </label>
                  <ActionButton variant="danger" disabled={!sure} onClick={erase}>{busy === "erase" ? "Working…" : "Carry out erasure"}</ActionButton>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {error && <div className="mt-4"><InlineError message={error} /></div>}

      <ConsentHistory userId={r.user_id} />

      <div className="mt-6 border-t border-antique-gold/20 pt-5">
        <p className="font-sans text-sm font-medium text-charcoal">History</p>
        {events.status === "loading" && <Loading rows={2} />}
        {events.status === "ready" && (
          <ul className="mt-3 space-y-2">
            {(events.data ?? []).map((e, i) => (
              <li key={i} className="font-sans text-[13px] text-charcoal">
                <span className="text-warm-grey">{fmtDateTime(e.created_at)}</span> · {e.actor_name || e.actor_role} · {e.event.replace(/_/g, " ")}
                {e.to_status ? ` → ${STATUS_LABEL[e.to_status] ?? e.to_status}` : ""}
                {e.note ? <span className="block pl-0 text-warm-grey">{e.note}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </DetailDrawer>
  );
}

/**
 * Before a copy of someone's data is produced, or an account is closed, an admin checks the request really
 * comes from the account holder. The database refuses both without this, and refuses a check by the requester.
 */
function IdentityCheck({ request: r, onDone }) {
  const [method, setMethod] = useState("phone_callback");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (r.identity_verified_at) {
    return (
      <div className="rounded-[12px] border border-racing-green/25 bg-racing-green/[0.05] p-4" role="status">
        <p className="font-sans text-sm font-medium text-charcoal">Requester identity: checked</p>
        <p className="mt-1 font-sans text-xs text-warm-grey">
          {METHOD_LABEL[r.identity_method] ?? "Checked"} on {fmtDateTime(r.identity_verified_at)}.
        </p>
      </div>
    );
  }

  async function record() {
    setBusy(true);
    setError(null);
    const res = await adminApi.verifyRequesterIdentity(r.id, method, note.trim() || null);
    setBusy(false);
    if (res.error) return setError(res.error);
    setNote("");
    onDone();
  }

  return (
    <div className="rounded-[12px] border border-antique-gold/30 p-4">
      <p className="font-sans text-sm font-medium text-charcoal">Requester identity: not checked yet</p>
      <p className="mt-1 font-sans text-xs leading-relaxed text-warm-grey">
        Check that this really comes from the account holder before a copy of their data is produced or their account is closed.
        Record only HOW you checked. Never write ID numbers or documents here. You cannot confirm your own request.
      </p>
      <div className="mt-3 space-y-3">
        <SelectField label="How was it checked?" value={method} onChange={setMethod}>
          {IDENTITY_METHODS.map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </SelectField>
        <div>
          <label htmlFor="pv-idnote" className="font-sans text-xs tracking-[0.12em] text-warm-grey uppercase">Note (optional)</label>
          <input id="pv-idnote" maxLength={300} className={FIELD} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <ActionButton variant="primary" disabled={busy} onClick={record}>{busy ? "Saving…" : "Record identity check"}</ActionButton>
      </div>
      {error && <div className="mt-3"><InlineError message={error} /></div>}
    </div>
  );
}

/** One member's consent history, newest first. Opening it is recorded in the audit log. */
function ConsentHistory({ userId }) {
  const [state, setState] = useState({ status: "idle", rows: [], error: null });

  async function load() {
    setState({ status: "loading", rows: [], error: null });
    const res = await adminApi.memberConsents(userId, 100, 0);
    setState(res.error ? { status: "error", rows: [], error: res.error } : { status: "ready", rows: res.data ?? [], error: null });
  }

  return (
    <div className="mt-6 border-t border-antique-gold/20 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-sans text-sm font-medium text-charcoal">Consent history</p>
        <ActionButton disabled={state.status === "loading"} onClick={load}>{state.status === "loading" ? "Loading…" : state.status === "idle" ? "Show" : "Refresh"}</ActionButton>
      </div>
      {state.status === "idle" && <p className="mt-1 font-sans text-xs text-warm-grey">Opening it is recorded in the audit log.</p>}
      {state.status === "error" && <div className="mt-3"><InlineError message={state.error} /></div>}
      {state.status === "ready" && state.rows.length === 0 && <p className="mt-2 font-sans text-sm text-warm-grey">No consent records for this member.</p>}
      {state.status === "ready" && state.rows.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {state.rows.map((c, i) => (
            <li key={i} className="font-sans text-[13px] text-charcoal">
              <span className="text-warm-grey">{fmtDateTime(c.created_at)}</span> · {c.purpose.replace(/_/g, " ")} · {CONSENT_ACTION_LABEL[c.action] ?? c.action}
              {c.notice_version ? ` (notice ${c.notice_version})` : ""} · {c.source}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Preflight({ p }) {
  return (
    <div className="mt-4 space-y-3 font-sans text-[13px] leading-relaxed text-charcoal">
      {!p.finalisation_enabled && <p className="rounded-[8px] bg-warning/10 px-3 py-2">Erasure is switched off. Turn it on in Notice &amp; details only after the club has approved the rules for it.</p>}
      {p.already_erased && <p className="rounded-[8px] bg-soft-cream px-3 py-2">The details were already removed. Run the step again to finish disabling the sign-in.</p>}
      {p.hold_until && !p.hold_elapsed && <p className="rounded-[8px] bg-warning/10 px-3 py-2">Waiting period until {fmtDateTime(p.hold_until)}.</p>}
      {p.blockers.length > 0 ? (
        <div>
          <p className="font-medium">Needs settling first</p>
          <ul className="mt-1 list-disc pl-5">{p.blockers.map((b) => <li key={b.code}>{b.detail}{b.count ? ` (${b.count})` : ""}</li>)}</ul>
        </div>
      ) : (
        <p>Nothing is outstanding.</p>
      )}
      <div>
        <p className="font-medium">Would be removed</p>
        <ul className="mt-1 list-disc pl-5">{p.will_remove.map((x) => <li key={x}>{x}</li>)}</ul>
      </div>
      <div>
        <p className="font-medium">Stays (kept without the member&apos;s name)</p>
        <p>
          {Object.entries(p.will_keep).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(" · ")}
        </p>
      </div>
      <div>
        <p className="font-medium">Not handled here</p>
        <ul className="mt-1 list-disc pl-5">{p.not_handled_here.map((x) => <li key={x}>{x}</li>)}</ul>
      </div>
    </div>
  );
}

// ─── Notice & club details ──────────────────────────────────────────────────

function NoticeTab({ onChanged }) {
  const cfg = useAdminQuery(() => adminApi.privacyConfig());
  const notices = useAdminQuery(() => adminApi.listNotices());

  return (
    <div className="space-y-6">
      <Card>
        <SectionHeader title="Club details" hint="Entered by the club. Nothing is invented: a missing required detail stops the notice from being published." />
        {cfg.status === "loading" && <Loading rows={4} />}
        {cfg.status === "error" && <ErrorBox message={cfg.error} onRetry={cfg.reload} />}
        {cfg.status === "ready" && (
          <div className="space-y-5">
            {(cfg.data ?? []).map((row) => (
              <SettingRow key={row.key} row={row} onSaved={() => { cfg.reload(); onChanged(); }} />
            ))}
          </div>
        )}
      </Card>
      <PublishCard notices={notices} onChanged={() => { notices.reload(); onChanged(); }} />
    </div>
  );
}

function SettingRow({ row, onSaved }) {
  const [value, setValue] = useState(row.value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const required = row.key in DETAIL_LABELS;
  const dirty = (value || null) !== (row.value || null);
  const risky = row.key === "erasure_finalisation_enabled";

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const { error: err } = await adminApi.setPrivacyConfig(row.key, value);
    setBusy(false);
    if (err) return setError(err);
    setSaved(true);
    onSaved();
  }

  const label = SETTING_LABELS[row.key] ?? row.key;
  return (
    <div className={risky ? "rounded-[12px] border border-destructive/25 p-4" : ""}>
      <label htmlFor={`cfg-${row.key}`} className="font-sans text-xs tracking-[0.12em] text-warm-grey uppercase">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </label>
      {LONG_SETTINGS.has(row.key) ? (
        <textarea id={`cfg-${row.key}`} rows={3} maxLength={2000} className={FIELD} value={value} onChange={(e) => setValue(e.target.value)} />
      ) : (
        <input id={`cfg-${row.key}`} className={FIELD} maxLength={2000} value={value} onChange={(e) => setValue(e.target.value)} />
      )}
      {risky && <p className="mt-1 font-sans text-xs text-destructive">Leave this off until the club has decided how active memberships, future bookings and record-keeping are handled, and counsel has confirmed the rules.</p>}
      <div className="mt-2 flex items-center gap-3">
        <ActionButton disabled={!dirty || busy} onClick={save}>{busy ? "Saving…" : "Save"}</ActionButton>
        {saved && !dirty && <span className="font-sans text-xs text-racing-green">Saved</span>}
      </div>
      {error && <div className="mt-2"><InlineError message={error} /></div>}
    </div>
  );
}

function PublishCard({ notices, onChanged }) {
  const drafts = (notices.data ?? []).filter((n) => n.status === "draft");
  const [version, setVersion] = useState("");
  const [date, setDate] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const chosen = version || drafts[0]?.version || "";

  async function publish() {
    setBusy(true);
    setError(null);
    const { error: err } = await adminApi.publishNotice(chosen, confirmed, date || null);
    setBusy(false);
    if (err) return setError(err);
    setConfirmed(false);
    onChanged();
  }

  return (
    <Card>
      <SectionHeader title="Privacy notice" action={<ActionButton href="/privacy" target="_blank" rel="noopener noreferrer">Preview</ActionButton>} hint="Publishing freezes the text exactly as members will see it." />
      {notices.status === "loading" && <Loading rows={2} />}
      {notices.status === "error" && <ErrorBox message={notices.error} onRetry={notices.reload} />}
      {notices.status === "ready" && (
        <>
          <ul className="mb-5 divide-y divide-charcoal/5">
            {(notices.data ?? []).map((n) => (
              <li key={`${n.version}-${n.language}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 font-sans text-sm text-charcoal">
                <span>Version {n.version} ({n.language})</span>
                <span className="flex items-center gap-3"><StatusPill value={n.status} />{n.effective_date && <span className="text-xs text-warm-grey">from {n.effective_date}</span>}</span>
              </li>
            ))}
          </ul>
          {drafts.length === 0 ? (
            <p className="font-sans text-sm text-warm-grey">There is no draft waiting to be published.</p>
          ) : (
            <div className="space-y-4 rounded-[12px] border border-antique-gold/20 p-4">
              <SelectField label="Draft to publish" value={chosen} onChange={setVersion}>
                {drafts.map((d) => <option key={d.version} value={d.version}>Version {d.version}</option>)}
              </SelectField>
              <div>
                <label htmlFor="pv-date" className="font-sans text-xs tracking-[0.12em] text-warm-grey uppercase">In effect from</label>
                <input id="pv-date" type="date" className={FIELD} value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <label className="flex items-start gap-2.5 font-sans text-[13px] leading-snug text-charcoal">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 h-4 w-4 accent-racing-green" />
                This notice has been reviewed (including by qualified legal counsel) and is ready to be shown to members.
              </label>
              <ActionButton variant="primary" disabled={!confirmed || !date || busy} onClick={publish}>{busy ? "Publishing…" : "Publish"}</ActionButton>
              {error && <InlineError message={error} />}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ─── Consent & audit ────────────────────────────────────────────────────────

function ConsentTab({ overview }) {
  const audit = useAdminQuery(() => adminApi.privacyAudit(150));
  const summary = Object.entries(overview?.consent_summary ?? {});

  return (
    <div className="space-y-6">
      <Card>
        <SectionHeader title="Consent records" hint="Counts of each member's latest answer. The records themselves are append-only and cannot be edited, even by an admin." />
        {summary.length === 0 ? (
          <p className="font-sans text-sm text-warm-grey">No consent or acknowledgement has been recorded yet. Existing members are not recorded as having agreed to anything.</p>
        ) : (
          <TableShell head={["Purpose", "Granted or read", "Withdrawn"]} minWidth="420px">
            {summary.map(([purpose, c]) => (
              <tr key={purpose} className="border-b border-charcoal/5 last:border-0">
                <td className="px-4 py-3 font-sans text-sm text-charcoal">{purpose.replace(/_/g, " ")}</td>
                <td className="px-4 py-3 font-sans text-sm text-charcoal">{c.granted}</td>
                <td className="px-4 py-3 font-sans text-sm text-charcoal">{c.withdrawn}</td>
              </tr>
            ))}
          </TableShell>
        )}
      </Card>

      <Card>
        <SectionHeader title="Privacy audit" hint="Consent changes, requests, exports, erasure steps, notice publication and settings changes. Names and contact details are never written here." />
        {audit.status === "loading" && <Loading rows={4} />}
        {audit.status === "error" && <ErrorBox message={audit.error} onRetry={audit.reload} />}
        {audit.status === "ready" && (audit.data ?? []).length === 0 && <Empty>No privacy events yet.</Empty>}
        {audit.status === "ready" && (audit.data ?? []).length > 0 && (
          <TableShell head={["When", "Event", "By", "Detail"]}>
            {audit.data.map((a, i) => (
              <tr key={i} className="border-b border-charcoal/5 last:border-0">
                <td className="px-4 py-3 font-sans text-sm text-warm-grey">{fmtDateTime(a.created_at)}</td>
                <td className="px-4 py-3 font-sans text-sm text-charcoal">{a.action.replace(/_/g, " ").toLowerCase()}</td>
                <td className="px-4 py-3 font-sans text-sm text-charcoal">{a.actor_name || "—"}</td>
                <td className="px-4 py-3 font-sans text-xs text-warm-grey">{a.detail ? Object.entries(a.detail).map(([k, v]) => `${k}: ${v}`).join(" · ") : ""}</td>
              </tr>
            ))}
          </TableShell>
        )}
      </Card>
    </div>
  );
}

// ─── Retention ──────────────────────────────────────────────────────────────

function RetentionTab({ onChanged }) {
  const rules = useAdminQuery(() => adminApi.retentionRules());
  const preview = useAdminQuery(() => adminApi.retentionPreview());
  const counts = Object.fromEntries((preview.data ?? []).map((p) => [p.category, p.rows_past_period]));

  return (
    <Card>
      <SectionHeader title="Retention rules" hint="Each period is the club's own decision and is OFF until approved. This page only counts what is past an approved period and deletes nothing. Automatic cleanup is off and is not run from this page." />
      {rules.status === "loading" && <Loading rows={5} />}
      {rules.status === "error" && <ErrorBox message={rules.error} onRetry={rules.reload} />}
      {rules.status === "ready" && (
        <div className="divide-y divide-charcoal/5">
          {(rules.data ?? []).map((r) => (
            <RuleRow key={r.category} rule={r} past={counts[r.category]} onSaved={() => { rules.reload(); preview.reload(); onChanged(); }} />
          ))}
        </div>
      )}
    </Card>
  );
}

function RuleRow({ rule, past, onSaved }) {
  const [days, setDays] = useState(rule.retention_days ?? "");
  const [basis, setBasis] = useState(rule.basis ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(approve) {
    setBusy(true);
    setError(null);
    const n = days === "" ? null : Number(days);
    const { error: err } = await adminApi.setRetentionRule(rule.category, Number.isFinite(n) ? n : null, basis || null, approve);
    setBusy(false);
    if (err) return setError(err);
    onSaved();
  }

  return (
    <div className="py-4 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-sans text-sm font-medium text-charcoal">{rule.category.replace(/_/g, " ")}</p>
        <StatusPill value={rule.status} />
      </div>
      <p className="font-sans text-xs text-warm-grey">{rule.description}</p>
      <div className="mt-2 grid gap-3 sm:grid-cols-[120px_1fr]">
        <input aria-label="Days" type="number" min="1" placeholder="Days" className={FIELD} value={days} onChange={(e) => setDays(e.target.value)} />
        <input aria-label="Reason for this period" placeholder="Reason for this period (legal or business basis)" className={FIELD} value={basis} onChange={(e) => setBasis(e.target.value)} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <ActionButton disabled={busy} onClick={() => save(false)}>Save as draft</ActionButton>
        <ActionButton variant="primary" disabled={busy || !days || !basis} onClick={() => save(true)}>Approve</ActionButton>
        {!AUTOMATED_CATEGORIES.has(rule.category) && <span className="font-sans text-xs text-warm-grey">Reviewed and removed by hand; never by a timer.</span>}
        {rule.status === "approved" && <span className="font-sans text-xs text-warm-grey">{past == null ? "" : `${past} record${past === 1 ? "" : "s"} past this period (not deleted)`}</span>}
      </div>
      {error && <div className="mt-2"><InlineError message={error} /></div>}
    </div>
  );
}
