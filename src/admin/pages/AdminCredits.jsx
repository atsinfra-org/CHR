import { useMemo, useState } from "react";
import { RefreshCw, Coins } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import {
  ActionButton,
  StatusPill,
  Card,
  Empty,
  ErrorBox,
  InlineError,
  Loading,
  PageHeader,
  SearchField,
  SectionHeader,
  TableShell,
  Toolbar,
} from "../ui";
import { fmtDate, fmtDateTime, istToday } from "../adminUtils";

const PAGE_SIZE = 300;

/**
 * Credit ledger + manual adjustment. The ledger read is scoped by
 * "Staff/admin read all credit ledger"; every adjustment goes through
 * admin_adjust_credits() (staff + admin), which writes an
 * 'admin_adjustment' ledger row and an audit_logs entry, and the AFTER
 * INSERT trigger re-syncs memberships.credits_remaining.
 *
 * Deliberately no KPI row. §40 suggests "Outstanding Credits" and
 * memberships.credits_remaining would support it — but only as a
 * server-side aggregate across all memberships. Summing the PAGE_SIZE
 * ledger rows loaded here would be a different and wrong number, and no
 * RPC exposes the real one today, so the card is omitted rather than
 * fabricated (§19/§62).
 */
export default function AdminCredits() {
  const { data, status, error, reload } = useAdminQuery(() =>
    supabase
      .from("credit_ledger")
      .select("*, member:profiles!credit_ledger_user_id_fkey(full_name, email)")
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE)
  );

  const rows = data ?? [];
  const capped = rows.length >= PAGE_SIZE;

  return (
    <div>
      <PageHeader
        route="credits"
        actions={
          <ActionButton icon={RefreshCw} onClick={reload}>
            Refresh
          </ActionButton>
        }
      />

      <AdjustPanel onAdjusted={reload} />

      <Toolbar className="mt-8">
        <SectionHeader
          title="Credit ledger"
          hint={capped ? `Most recent ${PAGE_SIZE} entries` : "Every credit movement, newest first"}
          className="mb-0"
        />
        <p className="font-sans text-xs text-warm-grey">
          {status === "ready" ? `${rows.length} ${rows.length === 1 ? "entry" : "entries"}` : ""}
        </p>
      </Toolbar>

      {status === "error" && <ErrorBox message={error} onRetry={reload} />}
      {status === "loading" && <Loading>Loading ledger…</Loading>}
      {status === "ready" &&
        (rows.length === 0 ? (
          <Empty icon={Coins} detail="Credit movements appear here as memberships are purchased, classes booked or adjustments made.">
            No ledger entries yet
          </Empty>
        ) : (
          <TableShell head={["When", "Member", "Type", "Amount", "Description"]} minWidth="720px">
            {rows.map((e) => (
              <tr key={e.id} className="border-b border-charcoal/[0.06] last:border-0 hover:bg-soft-cream/40">
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">
                  {fmtDateTime(e.created_at)}
                </td>
                <td className="px-4 py-3.5 font-sans text-sm text-charcoal">
                  {e.member?.full_name || e.member?.email || "—"}
                </td>
                <td className="px-4 py-3.5">
                  <StatusPill value={e.transaction_type} />
                </td>
                <td
                  className={`whitespace-nowrap px-4 py-3.5 font-sans text-sm font-medium ${
                    e.amount < 0 ? "text-destructive" : "text-racing-green"
                  }`}
                >
                  {e.amount > 0 ? `+${e.amount}` : e.amount}
                </td>
                <td className="px-4 py-3.5 font-sans text-sm text-warm-grey">{e.description || "—"}</td>
              </tr>
            ))}
          </TableShell>
        ))}
    </div>
  );
}

function AdjustPanel({ onAdjusted }) {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [state, setState] = useState({ busy: false, error: null, ok: null });

  const needle = q.trim();

  // The search is performed server-side. The previous version keyed this
  // query on `q` but never used it — it always fetched the same 25 active
  // memberships and filtered them in the browser, so any member outside
  // that arbitrary window reported "no match" despite existing.
  const search = useAdminQuery(() => {
    if (needle.length < 2) return Promise.resolve({ data: [], error: null });
    const pattern = `%${needle.replace(/[%,()]/g, "")}%`;
    return supabase
      .from("memberships")
      .select("id, status, start_date, end_date, member:profiles!memberships_user_id_fkey!inner(full_name, email)")
      .eq("status", "active")
      .gte("end_date", istToday())
      // Targets the embed by its alias ("member"). PostgREST validates this
      // name — an unknown target is rejected with PGRST108 — and combined
      // with the !inner hint the filter restricts the parent memberships to
      // those whose member matches.
      .or(`full_name.ilike.${pattern},email.ilike.${pattern}`, {
        referencedTable: "member",
      })
      .order("end_date", { ascending: false })
      .limit(25);
  }, [needle]);

  const matches = useMemo(() => search.data ?? [], [search.data]);

  const submit = async (e) => {
    e.preventDefault();
    const n = Number(amount);
    if (!selected) {
      setState({ busy: false, error: "Pick a member's active membership first.", ok: null });
      return;
    }
    if (!Number.isInteger(n) || n === 0) {
      setState({ busy: false, error: "Enter a non-zero whole number (e.g. 1 or -2).", ok: null });
      return;
    }
    setState({ busy: true, error: null, ok: null });
    const { error } = await adminApi.adjustCredits(selected.id, n, reason.trim());
    if (error) {
      setState({ busy: false, error, ok: null });
      return;
    }
    setState({ busy: false, error: null, ok: `Applied ${n > 0 ? "+" : ""}${n} credit(s).` });
    setAmount("");
    setReason("");
    onAdjusted();
  };

  return (
    <Card>
      <SectionHeader
        title="Adjust credits"
        hint="Applies to a member's currently-active membership. A reason is required and is written to the audit log."
      />

      {!selected ? (
        <div>
          <SearchField
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search member name or email…"
            className="max-w-md"
          />
          {needle.length >= 2 && (
            <ul className="mt-2 max-w-md divide-y divide-charcoal/[0.06] overflow-hidden rounded-[14px] border border-antique-gold/20 bg-white">
              {search.status === "loading" && (
                <li className="px-4 py-3 font-sans text-xs text-warm-grey">Searching…</li>
              )}
              {search.status === "error" && (
                <li className="px-4 py-3 font-sans text-xs text-destructive">{search.error}</li>
              )}
              {search.status === "ready" && matches.length === 0 && (
                <li className="px-4 py-3 font-sans text-xs text-warm-grey">No active membership matches that.</li>
              )}
              {matches.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(m);
                      setState({ busy: false, error: null, ok: null });
                    }}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-soft-cream/60"
                  >
                    <span className="font-sans text-sm text-charcoal">
                      {m.member?.full_name || m.member?.email || "—"}
                    </span>
                    <span className="whitespace-nowrap font-sans text-xs text-warm-grey">
                      ends {fmtDate(m.end_date)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <form onSubmit={submit}>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-antique-gold/20 bg-soft-cream/40 px-4 py-3">
            <div>
              <p className="font-sans text-sm text-charcoal">
                {selected.member?.full_name || selected.member?.email}
              </p>
              <p className="mt-0.5 flex items-center gap-2 font-sans text-xs text-warm-grey">
                <StatusPill value={selected.status} />
                <span>· ends {fmtDate(selected.end_date)}</span>
              </p>
            </div>
            <ActionButton variant="ghost" onClick={() => setSelected(null)}>
              Change
            </ActionButton>
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">Amount</span>
              <input
                type="number"
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="mt-1.5 block w-28 rounded-[12px] border border-antique-gold/25 bg-white px-3 py-2.5 font-sans text-sm text-charcoal outline-none transition-colors focus:border-antique-gold"
              />
            </label>
            <label className="block min-w-[200px] flex-1">
              <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">Reason</span>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Recorded in the audit log"
                className="mt-1.5 block w-full rounded-[12px] border border-antique-gold/25 bg-white px-3 py-2.5 font-sans text-sm text-charcoal outline-none transition-colors focus:border-antique-gold"
              />
            </label>
            <ActionButton type="submit" variant="primary" disabled={state.busy}>
              {state.busy ? "Saving…" : "Apply"}
            </ActionButton>
          </div>
        </form>
      )}

      {state.error && (
        <div className="mt-4 max-w-md">
          <InlineError message={state.error} />
        </div>
      )}
      {state.ok && <p className="mt-4 font-sans text-sm text-racing-green">{state.ok}</p>}
    </Card>
  );
}
