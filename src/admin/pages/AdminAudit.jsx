import { useMemo, useState } from "react";
import { RefreshCw, ScrollText } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { useAdminQuery } from "../useAdminQuery";
import {
  ActionButton,
  Empty,
  ErrorBox,
  Loading,
  PageHeader,
  SelectField,
  TableShell,
  Toolbar,
} from "../ui";
import { fmtDateTime, titleCase } from "../adminUtils";

const PAGE_SIZE = 500;

/**
 * Read-only audit trail (admin-only, enforced by the "Admin reads audit
 * logs" RLS policy). Every Phase 4.6 admin RPC writes one row here per
 * mutation — bootstrap, role changes, credit adjustments, horse changes,
 * session generation / status, admin cancellations, attendance.
 *
 * No KPI row: this is a log, and a count of loaded rows answers no
 * operational question (§14/§19). Header, filters and the trail itself are
 * the whole of the page.
 */
export default function AdminAudit() {
  const { data, status, error, reload } = useAdminQuery(() =>
    supabase
      .from("audit_logs")
      .select("*, actor:profiles!audit_logs_performed_by_fkey(full_name, email)")
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE)
  );
  const [action, setAction] = useState("all");
  const [table, setTable] = useState("all");

  const all = useMemo(() => data ?? [], [data]);
  // Filter vocabularies are derived from the rows actually loaded, so they
  // are complete only while the log is under PAGE_SIZE entries. The footnote
  // below says so rather than implying an exhaustive list.
  const actions = useMemo(() => ["all", ...Array.from(new Set(all.map((r) => r.action))).sort()], [all]);
  const tables = useMemo(() => ["all", ...Array.from(new Set(all.map((r) => r.table_name))).sort()], [all]);

  const rows = useMemo(() => {
    let list = all;
    if (action !== "all") list = list.filter((r) => r.action === action);
    if (table !== "all") list = list.filter((r) => r.table_name === table);
    return list;
  }, [all, action, table]);

  const capped = all.length >= PAGE_SIZE;
  const filtered = action !== "all" || table !== "all";

  return (
    <div>
      <PageHeader
        route="audit"
        actions={
          <ActionButton icon={RefreshCw} onClick={reload}>
            Refresh
          </ActionButton>
        }
      />

      <Toolbar>
        <div className="flex flex-wrap items-end gap-3">
          <SelectField
            label="Action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="w-full sm:w-56"
          >
            {actions.map((a) => (
              <option key={a} value={a}>
                {a === "all" ? "All actions" : titleCase(a)}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Table"
            value={table}
            onChange={(e) => setTable(e.target.value)}
            className="w-full sm:w-48"
          >
            {tables.map((t) => (
              <option key={t} value={t}>
                {t === "all" ? "All tables" : t}
              </option>
            ))}
          </SelectField>
        </div>
        <p className="font-sans text-xs text-warm-grey">
          {status === "ready" ? `${rows.length} shown${capped ? ` · most recent ${PAGE_SIZE}` : ""}` : ""}
        </p>
      </Toolbar>

      {status === "error" && <ErrorBox message={error} onRetry={reload} />}
      {status === "loading" && <Loading>Loading audit log…</Loading>}
      {status === "ready" &&
        (rows.length === 0 ? (
          <Empty
            icon={ScrollText}
            detail={
              filtered
                ? "No entries match the selected filters."
                : "Privileged actions are recorded here automatically as they happen."
            }
          >
            {filtered ? "No matching entries" : "No audit entries yet"}
          </Empty>
        ) : (
          <TableShell head={["When", "Action", "Table", "By", "Change", "Record"]} minWidth="960px">
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-charcoal/[0.06] align-top last:border-0 hover:bg-soft-cream/40">
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">
                  {fmtDateTime(r.created_at)}
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm font-medium text-charcoal">
                  {titleCase(r.action)}
                </td>
                <td className="px-4 py-3.5 font-sans text-sm text-warm-grey">{r.table_name}</td>
                <td className="px-4 py-3.5 font-sans text-sm text-charcoal">
                  {r.actor?.full_name || r.actor?.email || (r.performed_by ? "—" : "System")}
                </td>
                <td className="px-4 py-3.5 font-mono text-[11px] leading-relaxed text-warm-grey/90">
                  {r.old_values ? `${JSON.stringify(r.old_values)} → ` : ""}
                  {r.new_values ? JSON.stringify(r.new_values) : "—"}
                </td>
                <td className="px-4 py-3.5 font-mono text-[10.5px] text-warm-grey/60">{r.record_id}</td>
              </tr>
            ))}
          </TableShell>
        ))}

      {status === "ready" && capped && (
        <p className="mt-4 font-sans text-xs text-warm-grey/80">
          Showing the {PAGE_SIZE} most recent entries. Filter options are drawn from these entries only.
        </p>
      )}
    </div>
  );
}
