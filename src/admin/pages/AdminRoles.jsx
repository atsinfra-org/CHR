import { useMemo, useState } from "react";
import { RefreshCw, ShieldCheck, Users } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import {
  ActionButton,
  StatusPill,
  Empty,
  ErrorBox,
  InlineError,
  Loading,
  PageHeader,
  SearchField,
  TableShell,
  Toolbar,
} from "../ui";
import { fmtDateTime } from "../adminUtils";

const ROLES = ["member", "staff", "admin"];

/**
 * Role management (admin-only). Every change goes through admin_set_role()
 * — it re-checks is_admin() server-side, refuses to demote the last admin
 * (LAST_ADMIN), and writes an audit_logs row. The profiles
 * prevent_privilege_escalation() trigger still fires on the underlying
 * UPDATE and is never disabled.
 *
 * No KPI row: the access note below already states the admin count, and
 * repeating it as StatCards would be saying the same fact twice (§60).
 * Unlike most pages this query has no .limit(), so its counts genuinely
 * describe every profile rather than a loaded page.
 */
export default function AdminRoles() {
  const { data, status, error, reload } = useAdminQuery(() =>
    supabase
      .from("profiles")
      .select("id, full_name, email, role, status, created_at")
      .order("role", { ascending: true })
      .order("created_at", { ascending: true })
  );
  const [q, setQ] = useState("");
  const [rowError, setRowError] = useState(null);

  const all = useMemo(() => data ?? [], [data]);
  const adminCount = useMemo(() => all.filter((p) => p.role === "admin").length, [all]);
  const staffCount = useMemo(() => all.filter((p) => p.role === "staff").length, [all]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((p) => [p.full_name, p.email].some((f) => f?.toLowerCase().includes(needle)));
  }, [all, q]);

  return (
    <div>
      <PageHeader
        route="roles"
        actions={
          <ActionButton icon={RefreshCw} onClick={reload}>
            Refresh
          </ActionButton>
        }
      />

      <div className="mb-7 flex items-start gap-3 rounded-[18px] border border-antique-gold/25 bg-soft-cream/50 px-5 py-4">
        <ShieldCheck size={17} strokeWidth={1.75} className="mt-0.5 shrink-0 text-antique-gold" />
        <div>
          <p className="font-sans text-sm leading-relaxed text-charcoal">
            Staff run day-to-day operations — sessions, bookings, attendance, horses and credits. Admin adds
            role management, horse creation, enquiries and the audit log.
          </p>
          {status === "ready" && (
            <p className="mt-1.5 font-sans text-xs text-warm-grey">
              {adminCount === 1 ? "1 admin" : `${adminCount} admins`} · {staffCount === 1 ? "1 staff member" : `${staffCount} staff`}.
              The system always keeps at least one admin.
            </p>
          )}
        </div>
      </div>

      <Toolbar>
        <SearchField
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or email…"
          className="w-full sm:w-72"
        />
        <p className="font-sans text-xs text-warm-grey">
          {status === "ready" ? `${rows.length} of ${all.length} ${all.length === 1 ? "account" : "accounts"}` : ""}
        </p>
      </Toolbar>

      {rowError && (
        <div className="mb-4">
          <InlineError message={rowError} />
        </div>
      )}
      {status === "error" && <ErrorBox message={error} onRetry={reload} />}
      {status === "loading" && <Loading>Loading accounts…</Loading>}
      {status === "ready" &&
        (rows.length === 0 ? (
          <Empty
            icon={Users}
            detail={q.trim() ? "Try a different name or email." : "Accounts appear here once members sign up."}
          >
            {q.trim() ? "No accounts match that search" : "No accounts yet"}
          </Empty>
        ) : (
          <TableShell head={["Name", "Email", "Role", "Status", "Joined", "Change Role"]} minWidth="820px">
            {rows.map((p) => (
              <RoleRow key={p.id} profile={p} onChanged={reload} onError={setRowError} />
            ))}
          </TableShell>
        ))}
    </div>
  );
}

/**
 * Rendered as a component rather than inline <tr> markup — TableShell's
 * mobile reflow is scoped CSS precisely so that it still applies here, so
 * the <tr>/<td> structure must stay flat (no wrapper elements around cells).
 */
function RoleRow({ profile, onChanged, onError }) {
  const [open, setOpen] = useState(false);
  const [nextRole, setNextRole] = useState(profile.role);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (nextRole === profile.role) {
      setOpen(false);
      return;
    }
    if (!reason.trim()) {
      onError("A reason is required for a role change.");
      return;
    }
    setBusy(true);
    onError(null);
    const { error } = await adminApi.setRole(profile.id, nextRole, reason.trim());
    setBusy(false);
    if (error) {
      onError(error);
      return;
    }
    setOpen(false);
    setReason("");
    onChanged();
  };

  return (
    <tr className="border-b border-charcoal/[0.06] align-top last:border-0 hover:bg-soft-cream/40">
      <td className="px-4 py-3.5 font-sans text-sm font-medium text-charcoal">{profile.full_name || "—"}</td>
      <td className="px-4 py-3.5 font-sans text-sm text-warm-grey">{profile.email || "—"}</td>
      <td className="px-4 py-3.5">
        <StatusPill value={profile.role} />
      </td>
      <td className="px-4 py-3.5">
        <StatusPill value={profile.status} />
      </td>
      <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">
        {fmtDateTime(profile.created_at)}
      </td>
      <td className="px-4 py-3.5">
        {!open ? (
          <ActionButton
            variant="ghost"
            className="px-0 py-0 underline underline-offset-4"
            onClick={() => {
              setNextRole(profile.role);
              setOpen(true);
            }}
          >
            Change
          </ActionButton>
        ) : (
          <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
            <select
              value={nextRole}
              onChange={(e) => setNextRole(e.target.value)}
              aria-label={`New role for ${profile.full_name || profile.email}`}
              className="rounded-[10px] border border-antique-gold/25 bg-white px-2.5 py-2 font-sans text-xs text-charcoal outline-none focus:border-antique-gold"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (audited)"
              aria-label="Reason for role change"
              className="w-40 rounded-[10px] border border-antique-gold/25 bg-white px-2.5 py-2 font-sans text-xs text-charcoal outline-none focus:border-antique-gold"
            />
            <ActionButton type="submit" variant="primary" disabled={busy} className="px-3 py-2">
              {busy ? "Saving…" : "Save"}
            </ActionButton>
            <ActionButton variant="ghost" className="px-2 py-2" onClick={() => setOpen(false)}>
              Cancel
            </ActionButton>
          </form>
        )}
      </td>
    </tr>
  );
}
