import { useMemo, useState } from "react";
import { RefreshCw, Plus, PawPrint } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import {
  ActionButton,
  Card,
  Empty,
  ErrorBox,
  InlineError,
  Loading,
  PageHeader,
  SearchField,
  SelectField,
  StatusPill,
  Toolbar,
} from "../ui";
import { fmtDate, titleCase } from "../adminUtils";

const HORSE_STATUSES = ["available", "maintenance", "rest", "medical", "retired"];

/**
 * Horse roster (§35) — a visual roster rather than a spreadsheet.
 *
 * The horses table is (id, name, description, status, is_active, created_at,
 * updated_at): there is NO image column, so each horse gets a monogram
 * placeholder rather than invented photography (§35 permits exactly this;
 * §58 forbids decorative stock imagery).
 *
 * `status` and `is_active` are separate axes — a horse can be 'available'
 * yet inactive — and session capacity derives from BOTH (is_active AND
 * status='available'), so they stay visually distinct rather than collapsed
 * into one pill.
 *
 * This query has no .limit(), so the counts shown are true totals.
 *
 * Creating a horse is admin-only (admin_create_horse / RLS "Admin manages
 * horses"); changing status or the active flag is available to staff and
 * admin (admin_set_horse_status / RLS "Staff updates horse status").
 */
export default function AdminHorses({ isAdmin }) {
  const { data, status, error, reload } = useAdminQuery(() =>
    supabase.from("horses").select("*").order("name", { ascending: true })
  );
  const [rowError, setRowError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [adding, setAdding] = useState(false);

  const all = useMemo(() => data ?? [], [data]);

  const counts = useMemo(() => {
    const byStatus = Object.fromEntries(HORSE_STATUSES.map((s) => [s, 0]));
    let inactive = 0;
    for (const h of all) {
      if (h.status in byStatus) byStatus[h.status] += 1;
      if (!h.is_active) inactive += 1;
    }
    return { byStatus, inactive };
  }, [all]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((h) => {
      if (statusFilter !== "all" && h.status !== statusFilter) return false;
      if (!needle) return true;
      return [h.name, h.description].some((f) => f?.toLowerCase().includes(needle));
    });
  }, [all, q, statusFilter]);

  const change = async (horse, next) => {
    setBusyId(horse.id);
    setRowError(null);
    const { error: e } = await adminApi.setHorseStatus(horse.id, next.status, next.isActive);
    setBusyId(null);
    if (e) setRowError(e);
    else reload();
  };

  return (
    <div>
      <PageHeader
        route="horses"
        actions={
          <>
            <ActionButton icon={RefreshCw} onClick={reload}>
              Refresh
            </ActionButton>
            {isAdmin && (
              <ActionButton variant="primary" icon={Plus} onClick={() => setAdding((v) => !v)}>
                Add Horse
              </ActionButton>
            )}
          </>
        }
      />

      {/* A compact status strip rather than six StatCards: for a roster this
          small, six cards would restate what the roster itself already shows
          (§60). Counts are genuine totals — this query has no limit. */}
      {status === "ready" && all.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[18px] border border-antique-gold/20 bg-white px-5 py-4">
          <span className="font-serif text-2xl text-charcoal numerals-editorial">{all.length}</span>
          <span className="-ml-4 font-sans text-[10.5px] tracking-[0.16em] text-warm-grey uppercase">
            {all.length === 1 ? "Horse" : "Horses"}
          </span>
          <span className="h-5 w-px bg-antique-gold/25" aria-hidden="true" />
          {HORSE_STATUSES.map((s) => (
            <span key={s} className="flex items-center gap-2">
              <StatusPill value={s} />
              <span className="font-sans text-sm text-charcoal">{counts.byStatus[s]}</span>
            </span>
          ))}
          {counts.inactive > 0 && (
            <span className="font-sans text-xs text-warm-grey">{counts.inactive} inactive</span>
          )}
        </div>
      )}

      {isAdmin && adding && <AddHorse onAdded={reload} onClose={() => setAdding(false)} />}

      {rowError && (
        <div className="mb-4">
          <InlineError message={rowError} />
        </div>
      )}

      <Toolbar>
        <div className="flex flex-wrap items-end gap-3">
          <SearchField
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or description…"
            className="w-full sm:w-64"
          />
          <SelectField
            label="Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="w-full sm:w-44"
          >
            <option value="all">All statuses</option>
            {HORSE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {titleCase(s)}
              </option>
            ))}
          </SelectField>
        </div>
        <p className="font-sans text-xs text-warm-grey">
          {status === "ready" ? `${rows.length} of ${all.length} shown` : ""}
        </p>
      </Toolbar>

      {status === "error" && <ErrorBox message={error} onRetry={reload} />}
      {status === "loading" && <Loading rows={3}>Loading horses…</Loading>}
      {status === "ready" &&
        (rows.length === 0 ? (
          <Empty
            icon={PawPrint}
            detail={
              all.length === 0
                ? isAdmin
                  ? "Add the first horse to start building the roster."
                  : "Horses appear here once an admin adds them."
                : "Try a different name or status."
            }
          >
            {all.length === 0 ? "No horses yet" : "No horses match those filters"}
          </Empty>
        ) : (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
            {rows.map((h) => (
              <HorseCard
                key={h.id}
                horse={h}
                busy={busyId === h.id}
                onChange={(next) => change(h, next)}
              />
            ))}
          </div>
        ))}
    </div>
  );
}

function HorseCard({ horse, busy, onChange }) {
  const monogram = (horse.name || "?").trim().charAt(0).toUpperCase();

  return (
    <Card className="flex flex-col" padded={false}>
      {/* No image column exists on `horses`, so this is a deliberate
          monogram placeholder rather than invented or stock photography. */}
      <div className="flex items-center gap-3.5 border-b border-antique-gold/15 px-5 py-4">
        <span
          aria-hidden="true"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-deep-forest font-serif text-lg text-champagne-gold"
        >
          {monogram}
        </span>
        <div className="min-w-0">
          <p className="truncate font-serif text-lg leading-tight text-charcoal">{horse.name}</p>
          <div className="mt-1 flex items-center gap-2">
            <StatusPill value={horse.status} />
            {!horse.is_active && (
              <span className="font-sans text-[11px] tracking-[0.08em] text-warm-grey uppercase">· Inactive</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col px-5 py-4">
        <p className="font-sans text-sm leading-relaxed text-warm-grey">
          {horse.description || <span className="text-warm-grey/60">No description</span>}
        </p>
        <p className="mt-3 font-sans text-[11px] text-warm-grey/70">Added {fmtDate(horse.created_at?.slice(0, 10))}</p>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-antique-gold/15 pt-4">
          <select
            value={horse.status}
            disabled={busy}
            aria-label={`Status for ${horse.name}`}
            onChange={(e) => onChange({ status: e.target.value, isActive: horse.is_active })}
            className="rounded-[10px] border border-antique-gold/25 bg-white px-2.5 py-2 font-sans text-xs text-charcoal outline-none transition-colors focus:border-antique-gold disabled:opacity-50"
          >
            {HORSE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {titleCase(s)}
              </option>
            ))}
          </select>
          <ActionButton
            variant="secondary"
            disabled={busy}
            className="px-3 py-2"
            onClick={() => onChange({ status: horse.status, isActive: !horse.is_active })}
          >
            {horse.is_active ? "Deactivate" : "Activate"}
          </ActionButton>
        </div>
      </div>
    </Card>
  );
}

function AddHorse({ onAdded, onClose }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [state, setState] = useState({ busy: false, error: null });

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setState({ busy: false, error: "A name is required." });
      return;
    }
    setState({ busy: true, error: null });
    const { error } = await adminApi.createHorse(name.trim(), description.trim());
    if (error) {
      setState({ busy: false, error });
      return;
    }
    setName("");
    setDescription("");
    setState({ busy: false, error: null });
    onAdded();
    onClose();
  };

  return (
    <Card className="mb-6">
      <form onSubmit={submit}>
        <p className="font-sans text-[11px] tracking-[0.18em] text-warm-grey uppercase">New horse</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1.5 block w-48 rounded-[12px] border border-antique-gold/25 bg-white px-3 py-2.5 font-sans text-sm text-charcoal outline-none transition-colors focus:border-antique-gold"
            />
          </label>
          <label className="block min-w-[200px] flex-1">
            <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">Description</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              className="mt-1.5 block w-full rounded-[12px] border border-antique-gold/25 bg-white px-3 py-2.5 font-sans text-sm text-charcoal outline-none transition-colors focus:border-antique-gold"
            />
          </label>
          <ActionButton type="submit" variant="primary" disabled={state.busy}>
            {state.busy ? "Saving…" : "Create"}
          </ActionButton>
          <ActionButton variant="ghost" onClick={onClose}>
            Cancel
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
