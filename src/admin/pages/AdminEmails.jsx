import { useState } from "react";
import { Mail, RefreshCw, RotateCcw } from "lucide-react";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import { ActionButton, Empty, ErrorBox, InlineError, Loading, PageHeader, SelectField, StatusPill, TableShell, Toolbar } from "../ui";
import { fmtDateTime, titleCase } from "../adminUtils";

const TEMPLATE_LABEL = {
  payment_received: "Payment received",
  membership_activated: "Membership active",
  booking_confirmed: "Class confirmed",
  reschedule_confirmed: "Class rescheduled",
  order_confirmation: "Order confirmation",
  payment_pending: "Payment still verifying",
  welcome: "Welcome email",
};

const ERROR_LABEL = {
  provider_unavailable: "Email provider unavailable",
  rate_limited: "Email provider rate limit",
  provider_busy: "Email provider busy",
  quota_exceeded: "Email sending limit reached (resets at midnight UTC)",
  idempotency_conflict: "Possibly already sent: check with the member before retrying",
  network: "Network problem",
  provider_auth: "Email provider settings need fixing",
  invalid_request: "Address or message rejected",
  provider_rejected: "Rejected by the provider",
  worker_timeout: "Sending stopped part-way",
  internal_error: "Internal error",
  bounced: "Address bounced",
  complained: "Marked as spam",
  rejected: "Rejected after sending",
};

/**
 * Transactional email log. Staff can see every email the system queued and how it went; only an
 * administrator can retry one. Retrying re-queues the email alone: it never repeats a payment,
 * a credit, a membership or a booking. Addresses are masked and no provider key is ever shown.
 */
export default function AdminEmails({ isAdmin }) {
  const [status, setStatus] = useState("all");
  const { data, status: loadStatus, error, reload } = useAdminQuery(() => adminApi.emailDeliveries(status === "all" ? null : status), [status]);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);

  async function retry(id) {
    setBusy(id);
    setActionError(null);
    const res = await adminApi.retryEmail(id);
    setBusy(null);
    if (res.error) setActionError(res.error);
    reload();
  }

  const rows = data ?? [];

  return (
    <div>
      <PageHeader
        route="emails"
        actions={
          <ActionButton icon={RefreshCw} onClick={reload}>
            Refresh
          </ActionButton>
        }
      />
      <Toolbar>
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-full sm:w-56">
          {["all", "queued", "processing", "retry_scheduled", "sent", "failed", "skipped"].map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All" : titleCase(s)}
            </option>
          ))}
        </SelectField>
        <p className="font-sans text-xs text-warm-grey">
          “Sent” means the email provider accepted it. “Delivered” appears once the provider confirms it reached the mailbox.
        </p>
      </Toolbar>

      {actionError && <InlineError message={actionError} />}
      {loadStatus === "error" && <ErrorBox message={error} onRetry={reload} />}
      {loadStatus === "loading" && <Loading>Loading emails…</Loading>}
      {loadStatus === "ready" &&
        (rows.length === 0 ? (
          <Empty icon={Mail} detail="Emails appear here after a payment, a membership, a booking or a reschedule.">
            No emails yet
          </Empty>
        ) : (
          <TableShell head={["Created", "Email", "Related to", "To", "Status", "Delivery", "Tries", "Last try", "Problem", ""]} minWidth="1080px">
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-charcoal/[0.06] align-top last:border-0 hover:bg-soft-cream/40">
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">{fmtDateTime(r.created_at)}</td>
                <td className="px-4 py-3.5 font-sans text-sm font-medium text-charcoal">{TEMPLATE_LABEL[r.template] ?? titleCase(r.template)}</td>
                <td className="px-4 py-3.5 font-mono text-[11px] text-warm-grey">
                  {titleCase(r.related_type)} {String(r.related_id).slice(0, 8).toUpperCase()}
                </td>
                <td className="px-4 py-3.5 font-sans text-sm text-warm-grey">{r.recipient_hint || "—"}</td>
                <td className="px-4 py-3.5">
                  <StatusPill value={r.status} />
                </td>
                <td className="px-4 py-3.5">
                  <StatusPill value={r.delivery_status} />
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">
                  {r.attempts}/{r.max_attempts}
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">{r.last_attempt_at ? fmtDateTime(r.last_attempt_at) : "—"}</td>
                <td className="px-4 py-3.5 font-sans text-sm text-charcoal">{r.last_error_category ? ERROR_LABEL[r.last_error_category] ?? titleCase(r.last_error_category) : "—"}</td>
                <td className="px-4 py-3.5">
                  {r.can_retry && isAdmin ? (
                    <ActionButton icon={RotateCcw} disabled={busy === r.id} onClick={() => retry(r.id)}>
                      Retry email
                    </ActionButton>
                  ) : r.can_retry ? (
                    <span className="font-sans text-xs text-warm-grey">Administrator can retry</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </TableShell>
        ))}
    </div>
  );
}
