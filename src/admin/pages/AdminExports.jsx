import { useEffect, useRef, useState } from "react";
import { Download, Eye, FileSpreadsheet, FileText } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { adminApi } from "../adminApi";
import { ActionButton, Card, InlineError, SelectField } from "../ui";
import { COMBINED_KEYS, combinedFilters, normaliseFilters, REPORTS } from "../exports/reports";
import { formatMoney, statusLabel } from "../exports/format";
import { downloadBlob } from "../exports/download";
import { exportErrorMessage, runExport } from "../exports/runExport";

const KINDS = [
  { key: "members", label: "Member registrations" },
  { key: "memberships", label: "Memberships" },
  { key: "payments", label: "Payments (follow-up)" },
  { key: "bookings", label: "Bookings" },
  { key: "combined", label: "Combined administrative report" },
];

const emptyFilters = { from: "", to: "", status: "", plan: "", gateway: "" };

/**
 * Exports: Excel and PDF files for members, memberships, payments and bookings. Administrators only (the page is hidden
 * from staff and every database function refuses them). The files are created in this browser from pages of data the
 * database returns; nothing is stored and there is no download link to share.
 */
export default function AdminExports() {
  const [kind, setKind] = useState("payments");
  const [format, setFormat] = useState("xlsx");
  const [filters, setFilters] = useState(emptyFilters);
  const [plans, setPlans] = useState([]);
  const [busy, setBusy] = useState(null); // "preview" | "xlsx" | "pdf" | null
  const [progress, setProgress] = useState("");
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [preview, setPreview] = useState(null);
  const lock = useRef(false); // a second click while one export is running does nothing

  useEffect(() => {
    let live = true;
    supabase.from("membership_plans").select("plan_code, name").order("name").then(({ data }) => live && setPlans(data ?? []));
    return () => {
      live = false;
    };
  }, []);

  const combined = kind === "combined";
  const spec = combined ? null : REPORTS[kind];
  const set = (name) => (e) => {
    setFilters((f) => ({ ...f, [name]: e.target.value }));
    setPreview(null);
    setDone(null);
  };
  const pickKind = (e) => {
    setKind(e.target.value);
    setFilters((f) => ({ ...f, status: "", gateway: "" }));
    setPreview(null);
    setDone(null);
    setError(null);
  };

  async function guarded(name, job) {
    if (lock.current) return;
    lock.current = true;
    setBusy(name);
    setError(null);
    setDone(null);
    try {
      await job();
    } catch (err) {
      setError(exportErrorMessage(err));
    } finally {
      lock.current = false;
      setBusy(null);
      setProgress("");
    }
  }

  const showPreview = () =>
    guarded("preview", async () => {
      const keys = combined ? COMBINED_KEYS : [kind];
      const out = [];
      for (const key of keys) {
        const f = combined ? normaliseFilters(key, combinedFilters(filters)) : normaliseFilters(key, filters);
        const { data, error: err } = await adminApi.reportSummary(key, f);
        if (err) throw Object.assign(new Error(err), { code: "DATABASE" });
        out.push({ key, summary: data });
      }
      setPreview(out);
    });

  const doExport = (fmt) =>
    guarded(fmt, async () => {
      const result = await runExport({
        kind,
        format: fmt,
        filters,
        onProgress: (p) => setProgress(p.stage === "building" ? "Building the file…" : `Loading ${REPORTS[p.key].sheet.toLowerCase()}: ${p.loaded.toLocaleString("en-IN")} of ${Number(p.total).toLocaleString("en-IN")}`),
      });
      downloadBlob(result.blob, result.filename);
      setDone(`${result.filename} downloaded (${result.rows.toLocaleString("en-IN")} record${result.rows === 1 ? "" : "s"}). It was created in this browser and has not been stored anywhere.`);
    });

  return (
    <div>
      <div className="mb-7">
        <h1 className="font-serif text-[1.85rem] leading-tight text-charcoal">Exports</h1>
        <p className="mt-1.5 max-w-2xl font-sans text-sm leading-relaxed text-warm-grey">
          Download member, membership, payment and booking records as Excel or PDF. The files contain personal information: keep them private and delete
          them when you no longer need them. Each export is recorded in the audit log (who, what, when, how many rows; never the contents).
        </p>
      </div>

      <Card>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <SelectField label="Report" value={kind} onChange={pickKind}>
            {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </SelectField>
          <label className="block">
            <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">{combined ? "From (each report's own date)" : `${spec.dateLabel} from`}</span>
            <input type="date" value={filters.from} onChange={set("from")} className="mt-1.5 block w-full rounded-[12px] border border-antique-gold/25 bg-white px-3 py-2.5 font-sans text-sm text-charcoal outline-none" />
          </label>
          <label className="block">
            <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">{combined ? "To" : `${spec.dateLabel} to`}</span>
            <input type="date" value={filters.to} onChange={set("to")} className="mt-1.5 block w-full rounded-[12px] border border-antique-gold/25 bg-white px-3 py-2.5 font-sans text-sm text-charcoal outline-none" />
          </label>

          {!combined && spec.filters.includes("status") && (
            <SelectField label={kind === "payments" ? "Payment status" : kind === "bookings" ? "Booking status" : "Membership status"} value={filters.status} onChange={set("status")}>
              <option value="">All</option>
              {spec.statuses.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </SelectField>
          )}
          {(combined || spec?.filters.includes("plan")) && (
            <SelectField label="Membership type" value={filters.plan} onChange={set("plan")}>
              <option value="">All</option>
              {plans.map((p) => <option key={p.plan_code} value={p.plan_code}>{p.name}</option>)}
            </SelectField>
          )}
          {!combined && kind === "payments" && (
            <SelectField label="Gateway" value={filters.gateway} onChange={set("gateway")}>
              <option value="">All</option>
              <option value="razorpay">Razorpay</option>
            </SelectField>
          )}
        </div>
        {combined && <p className="mt-3 font-sans text-xs text-warm-grey">The combined report has four sheets (Excel) or sections (PDF): Members, Memberships, Payments, Bookings. The date range and membership type apply to each; status filters do not.</p>}

        <div className="mt-6 flex flex-wrap items-end gap-4 border-t border-antique-gold/20 pt-5">
          <fieldset className="flex gap-2" aria-label="File format">
            {[["xlsx", "Excel (.xlsx)", FileSpreadsheet], ["pdf", "PDF (.pdf)", FileText]].map(([key, label, Icon]) => (
              <button key={key} type="button" aria-pressed={format === key} onClick={() => setFormat(key)}
                className={`inline-flex items-center gap-2 rounded-[10px] border px-3.5 py-2.5 font-sans text-xs tracking-[0.1em] uppercase ${format === key ? "border-racing-green bg-racing-green text-warm-ivory" : "border-antique-gold/35 bg-white text-charcoal"}`}>
                <Icon size={14} strokeWidth={1.75} />{label}
              </button>
            ))}
          </fieldset>
          <ActionButton icon={Eye} disabled={busy !== null} onClick={showPreview}>{busy === "preview" ? "Loading…" : "Preview summary"}</ActionButton>
          <ActionButton variant="primary" icon={Download} disabled={busy !== null} onClick={() => doExport(format)}>
            {busy === "xlsx" || busy === "pdf" ? "Creating file…" : `Export ${format === "xlsx" ? "Excel" : "PDF"}`}
          </ActionButton>
        </div>
        {busy && <p role="status" className="mt-3 font-sans text-xs text-warm-grey">{progress || "Working…"}</p>}
      </Card>

      {error && <div className="mt-5"><InlineError message={error} /></div>}
      {done && <p role="status" className="mt-5 rounded-[14px] border border-racing-green/25 bg-racing-green/[0.06] px-5 py-4 font-sans text-sm text-racing-green">{done}</p>}
      {preview && <Preview items={preview} />}
    </div>
  );
}

function Preview({ items }) {
  return (
    <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
      {items.map(({ key, summary }) => (
        <Card key={key}>
          <h2 className="font-serif text-lg text-charcoal">{REPORTS[key].title}</h2>
          <p className="mt-1 font-sans text-sm text-charcoal"><span className="font-medium">{Number(summary?.total ?? 0).toLocaleString("en-IN")}</span> record{Number(summary?.total) === 1 ? "" : "s"}</p>
          {key === "payments" && summary && (
            <div className="mt-3 space-y-1 font-sans text-xs text-warm-grey">
              <p><span className="font-medium text-charcoal">Successful revenue:</span> {formatMoney(summary.successful_revenue?.amount)} ({summary.successful_revenue?.count} payments, status Success only)</p>
              <p>Refunded (original amount, not revenue): {formatMoney(summary.refunded_original_amount?.amount)} ({summary.refunded_original_amount?.count})</p>
              <p>Partially refunded (original amount, not revenue): {formatMoney(summary.partially_refunded_original_amount?.amount)} ({summary.partially_refunded_original_amount?.count})</p>
              <p>{Object.entries(summary.by_status ?? {}).map(([s, v]) => `${statusLabel(s)} ${v.count}`).join(" · ")}</p>
            </div>
          )}
          {key === "memberships" && summary && <p className="mt-3 font-sans text-xs text-warm-grey">Classes: {summary.credits_total} total · {summary.credits_used} used · {summary.credits_remaining} remaining</p>}
          {key !== "payments" && summary?.by_status && <p className="mt-3 font-sans text-xs text-warm-grey">{Object.entries(summary.by_status).map(([s, n]) => `${statusLabel(s)} ${n}`).join(" · ")}</p>}
          {key === "members" && summary?.by_membership_status && <p className="mt-3 font-sans text-xs text-warm-grey">{Object.entries(summary.by_membership_status).map(([s, n]) => `${statusLabel(s)} ${n}`).join(" · ")}</p>}
        </Card>
      ))}
    </div>
  );
}
