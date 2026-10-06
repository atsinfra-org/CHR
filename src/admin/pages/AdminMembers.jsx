import { useMemo, useState } from "react";
import { ArrowLeft, RefreshCw, Users, BadgeCheck, Hourglass, ChevronRight } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import {
  ActionButton,
  Card,
  Empty,
  ErrorBox,
  Field,
  InlineError,
  Loading,
  PageHeader,
  SearchField,
  SectionHeader,
  StatCard,
  StatGrid,
  StatusPill,
  TableShell,
  Toolbar,
} from "../ui";
import { fmtDate, fmtDateTime, fmtMoney, fmtTime, istToday, titleCase } from "../adminUtils";

/**
 * Members directory + per-member operational record (§34). All reads are
 * scoped by the "Staff/admin read all ..." RLS policies; the only mutation
 * on this screen (credit adjustment) goes through admin_adjust_credits().
 *
 * The member record keeps its dedicated `#members/<uuid>` route rather than
 * being forced into a drawer — the existing workflow is a full page, and
 * §33 says not to override that.
 */
export default function AdminMembers({ memberId, isAdmin }) {
  if (memberId) return <MemberDetail memberId={memberId} isAdmin={isAdmin} />;
  return <MemberList />;
}

/* ------------------------------------------------------------ directory */

function MemberList() {
  const { data, status, error, reload } = useAdminQuery(() =>
    supabase
      .from("profiles")
      .select("id, full_name, email, phone, date_of_birth, role, status, created_at")
      .order("created_at", { ascending: false })
  );
  // KPIs come from the server's own definitions (§16) rather than being
  // re-derived here: "active" means status='active' AND end_date >= IST
  // today, which only admin_dashboard_metrics() evaluates authoritatively.
  // "Expiring memberships" has no existing source, so it is omitted (§19).
  const metrics = useAdminQuery(() => adminApi.dashboardMetrics());
  const [q, setQ] = useState("");

  const all = useMemo(() => data ?? [], [data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((r) => [r.full_name, r.email, r.phone].some((f) => f?.toLowerCase().includes(needle)));
  }, [all, q]);

  const m = Array.isArray(metrics.data) ? metrics.data[0] : metrics.data;
  const ready = metrics.status === "ready" && m;
  const mLoading = metrics.status === "loading";

  return (
    <div>
      <PageHeader
        route="members"
        actions={
          <ActionButton
            icon={RefreshCw}
            onClick={() => {
              reload();
              metrics.reload();
            }}
          >
            Refresh
          </ActionButton>
        }
      />

      <StatGrid className="mb-7">
        <StatCard
          icon={Users}
          label="Members"
          value={ready ? m.total_members : null}
          hint="Accounts with the member role"
          loading={mLoading}
        />
        <StatCard
          icon={BadgeCheck}
          label="Active Memberships"
          value={ready ? m.active_memberships : null}
          hint="Within their validity period"
          loading={mLoading}
          tone="accent"
        />
        <StatCard
          icon={Hourglass}
          label="Awaiting Payment"
          value={ready ? m.pending_payment_memberships : null}
          hint="Purchase started, not yet paid"
          loading={mLoading}
        />
      </StatGrid>

      <Toolbar>
        <SearchField
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, email or phone…"
          className="w-full sm:w-80"
        />
        <p className="font-sans text-xs text-warm-grey">
          {status === "ready" ? `${rows.length} of ${all.length} ${all.length === 1 ? "account" : "accounts"}` : ""}
        </p>
      </Toolbar>

      {status === "error" && <ErrorBox message={error} onRetry={reload} />}
      {status === "loading" && <Loading>Loading members…</Loading>}
      {status === "ready" &&
        (rows.length === 0 ? (
          <Empty
            icon={Users}
            detail={all.length === 0 ? "Member accounts will appear here once they are created." : "Try a different name, email or phone."}
          >
            {all.length === 0 ? "No members yet" : "No accounts match that search"}
          </Empty>
        ) : (
          <TableShell head={["Member", "Phone", "Date of Birth", "Role", "Status", ""]} minWidth="760px">
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-charcoal/[0.06] last:border-0 hover:bg-soft-cream/40">
                <td className="px-4 py-3.5">
                  <a href={`#members/${r.id}`} className="group flex items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-soft-cream font-serif text-sm text-racing-green"
                    >
                      {(r.full_name || r.email || "?").trim().charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-sans text-sm font-medium text-charcoal group-hover:text-racing-green">
                        {r.full_name || "Unnamed member"}
                      </span>
                      <span className="block truncate font-sans text-xs text-warm-grey">{r.email || "—"}</span>
                    </span>
                  </a>
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">{r.phone || "—"}</td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">
                  {fmtDate(r.date_of_birth)}
                </td>
                <td className="px-4 py-3.5">
                  <StatusPill value={r.role} />
                </td>
                <td className="px-4 py-3.5">
                  <StatusPill value={r.status} />
                </td>
                <td className="px-4 py-3.5 text-right">
                  <a
                    href={`#members/${r.id}`}
                    aria-label={`Open ${r.full_name || r.email}`}
                    className="inline-flex items-center gap-1 font-sans text-xs tracking-[0.12em] text-racing-green uppercase hover:text-antique-gold"
                  >
                    Open
                    <ChevronRight size={13} strokeWidth={1.75} />
                  </a>
                </td>
              </tr>
            ))}
          </TableShell>
        ))}
    </div>
  );
}

/* --------------------------------------------------------------- record */

function MemberDetail({ memberId, isAdmin }) {
  const { data, status, error, reload } = useAdminQuery(
    () =>
      Promise.all([
        supabase.from("profiles").select("*").eq("id", memberId).maybeSingle(),
        supabase
          .from("memberships")
          .select("*, plan:membership_plans(name, price, currency)")
          .eq("user_id", memberId)
          .order("created_at", { ascending: false }),
        supabase.from("credit_ledger").select("*").eq("user_id", memberId).order("created_at", { ascending: false }),
        supabase
          .from("bookings")
          .select("*, session:class_sessions(session_date, start_time, end_time), attendance(status, notes)")
          .eq("user_id", memberId)
          .order("created_at", { ascending: false }),
        supabase.from("payments").select("*").eq("user_id", memberId).order("created_at", { ascending: false }),
      ]).then(([p, mm, c, b, pay]) => {
        const firstError = p.error || mm.error || c.error || b.error || pay.error;
        if (firstError) return { data: null, error: firstError };
        return {
          data: {
            profile: p.data,
            memberships: mm.data ?? [],
            ledger: c.data ?? [],
            bookings: b.data ?? [],
            payments: pay.data ?? [],
          },
          error: null,
        };
      }),
    [memberId]
  );

  const back = (
    <a
      href="#members"
      className="mb-5 inline-flex items-center gap-1.5 font-sans text-xs tracking-[0.14em] text-racing-green uppercase hover:text-antique-gold"
    >
      <ArrowLeft size={13} strokeWidth={1.75} />
      All members
    </a>
  );

  if (status === "loading")
    return (
      <div>
        {back}
        <Loading>Loading member…</Loading>
      </div>
    );
  if (status === "error")
    return (
      <div>
        {back}
        <ErrorBox message={error} onRetry={reload} />
      </div>
    );
  if (!data?.profile)
    return (
      <div>
        {back}
        <Empty icon={Users} detail="The account may have been removed.">
          That member no longer exists
        </Empty>
      </div>
    );

  const { profile, memberships, ledger, bookings, payments } = data;
  // Summed from this member's complete ledger (the query has no limit), so
  // this is the genuine balance; credit_ledger is authoritative and
  // memberships.credits_remaining is only a trigger-maintained cache.
  const balance = ledger.reduce((sum, e) => sum + e.amount, 0);
  const activeMembership = memberships.find((mm) => mm.status === "active" && mm.end_date >= istToday());

  return (
    <div>
      {back}

      <PageHeader
        section="Operations · Member"
        title={profile.full_name || "Unnamed member"}
        description={profile.email}
      />

      <Card className="mb-8">
        <div className="mb-5 flex flex-wrap items-center gap-4">
          <StatusPill value={profile.role} />
          <StatusPill value={profile.status} />
          {activeMembership ? (
            <span className="font-sans text-xs text-racing-green">
              Active membership until {fmtDate(activeMembership.end_date)}
            </span>
          ) : (
            <span className="font-sans text-xs text-warm-grey">No active membership</span>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          <Field label="Phone" value={profile.phone || "—"} />
          <Field label="Date of Birth" value={fmtDate(profile.date_of_birth)} />
          <Field label="Joined" value={fmtDate(profile.created_at?.slice(0, 10))} />
          <Field
            label="Credit Balance"
            value={<span className="font-serif text-2xl text-charcoal numerals-editorial">{balance}</span>}
          />
        </dl>
      </Card>

      <section className="mb-9">
        <SectionHeader title="Memberships" />
        {memberships.length === 0 ? (
          <Empty detail="This member hasn't purchased a membership.">No memberships</Empty>
        ) : (
          <TableShell head={["Plan", "Status", "Start", "End", "Credits", "Price"]} minWidth="640px">
            {memberships.map((mm) => (
              <tr key={mm.id} className="border-b border-charcoal/[0.06] last:border-0">
                <td className="px-4 py-3.5 font-sans text-sm font-medium text-charcoal">{mm.plan?.name || "—"}</td>
                <td className="px-4 py-3.5">
                  <StatusPill value={mm.status} />
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">{fmtDate(mm.start_date)}</td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">{fmtDate(mm.end_date)}</td>
                <td className="px-4 py-3.5 font-sans text-sm text-charcoal">{mm.credits_remaining}</td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-charcoal">
                  {mm.plan ? fmtMoney(mm.plan.price, mm.plan.currency) : "—"}
                </td>
              </tr>
            ))}
          </TableShell>
        )}
      </section>

      <section className="mb-9">
        <SectionHeader
          title="Credit ledger"
          hint="The ledger is authoritative; the membership credits column above is a cache of it."
        />
        {activeMembership && <AdjustCredits membershipId={activeMembership.id} onDone={reload} />}
        {ledger.length === 0 ? (
          <Empty detail="Credit movements appear as memberships are bought and classes booked.">No ledger entries</Empty>
        ) : (
          <TableShell head={["When", "Type", "Amount", "Description"]} minWidth="560px">
            {ledger.map((e) => (
              <tr key={e.id} className="border-b border-charcoal/[0.06] last:border-0">
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">{fmtDateTime(e.created_at)}</td>
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
        )}
      </section>

      <section className="mb-9">
        <SectionHeader title="Bookings" />
        {bookings.length === 0 ? (
          <Empty detail="Bookings appear once this member books a class.">No bookings</Empty>
        ) : (
          <TableShell head={["Session", "Status", "Attendance", "Booked"]} minWidth="640px">
            {bookings.map((b) => {
              const att = Array.isArray(b.attendance) ? b.attendance[0] : b.attendance;
              return (
                <tr key={b.id} className="border-b border-charcoal/[0.06] last:border-0">
                  <td className="px-4 py-3.5">
                    <span className="block whitespace-nowrap font-sans text-sm font-medium text-charcoal">
                      {fmtDate(b.session?.session_date)}
                    </span>
                    <span className="mt-0.5 block whitespace-nowrap font-sans text-xs text-warm-grey">
                      {b.session ? `${fmtTime(b.session.start_time)} – ${fmtTime(b.session.end_time)}` : "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3.5">
                    <StatusPill value={b.status} />
                  </td>
                  <td className="px-4 py-3.5">
                    {att?.status ? <StatusPill value={att.status} /> : <span className="font-sans text-sm text-warm-grey/60">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3.5 font-sans text-xs text-warm-grey">{fmtDateTime(b.booked_at)}</td>
                </tr>
              );
            })}
          </TableShell>
        )}
      </section>

      <section className="mb-4">
        <SectionHeader title="Payments" />
        {payments.length === 0 ? (
          <Empty detail="Payment transactions appear here once this member pays for a membership.">No payments</Empty>
        ) : (
          <TableShell head={["When", "Amount", "Status", "Gateway", "Reference"]} minWidth="640px">
            {payments.map((p) => (
              <tr key={p.id} className="border-b border-charcoal/[0.06] last:border-0">
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm text-warm-grey">{fmtDateTime(p.created_at)}</td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-sm font-medium text-charcoal">
                  {fmtMoney(p.amount, p.currency)}
                </td>
                <td className="px-4 py-3.5">
                  <StatusPill value={p.status} />
                </td>
                <td className="px-4 py-3.5 font-sans text-sm text-warm-grey">{titleCase(p.gateway)}</td>
                <td className="px-4 py-3.5 font-mono text-[11px] text-warm-grey/80">
                  {p.gateway_order_id || "—"}
                  {p.gateway_payment_id ? ` / ${p.gateway_payment_id}` : ""}
                </td>
              </tr>
            ))}
          </TableShell>
        )}
      </section>

      {!isAdmin && (
        <p className="mt-6 font-sans text-xs text-warm-grey">
          Role changes are admin-only. Credit adjustments are available to staff and admin.
        </p>
      )}
    </div>
  );
}

function AdjustCredits({ membershipId, onDone }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [state, setState] = useState({ busy: false, error: null });

  const submit = async (e) => {
    e.preventDefault();
    const n = Number(amount);
    if (!Number.isInteger(n) || n === 0) {
      setState({ busy: false, error: "Enter a non-zero whole number (e.g. 1 or -2)." });
      return;
    }
    setState({ busy: true, error: null });
    const { error } = await adminApi.adjustCredits(membershipId, n, reason.trim());
    if (error) {
      setState({ busy: false, error });
      return;
    }
    setAmount("");
    setReason("");
    setState({ busy: false, error: null });
    onDone();
  };

  return (
    <Card className="mb-4">
      <form onSubmit={submit}>
        <p className="font-sans text-[11px] tracking-[0.18em] text-warm-grey uppercase">Adjust credits · active membership</p>
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
              placeholder="Required — recorded in the audit log"
              className="mt-1.5 block w-full rounded-[12px] border border-antique-gold/25 bg-white px-3 py-2.5 font-sans text-sm text-charcoal outline-none transition-colors focus:border-antique-gold"
            />
          </label>
          <ActionButton type="submit" variant="primary" disabled={state.busy}>
            {state.busy ? "Saving…" : "Apply"}
          </ActionButton>
        </div>
        {state.error && (
          <div className="mt-4 max-w-md">
            <InlineError message={state.error} />
          </div>
        )}
      </form>
    </Card>
  );
}
