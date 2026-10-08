import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import { ActionButton, Card, ErrorBox, InlineError, Loading, PageHeader, SectionHeader } from "../ui";

/**
 * Editable business rules and membership plans (admin only). Every change
 * goes through admin_update_setting() / admin_update_plan(), which validate
 * ranges server-side and write an audit log entry. The form limits here are
 * a convenience, not the authority.
 *
 * Plan edits apply to FUTURE purchases only; memberships already sold keep
 * the credits and reschedules they were sold with.
 */
const SETTINGS = [
  { key: "weekly_class_limit", label: "Classes per week", type: "int", min: 1, max: 14, help: "Maximum bookings per 7-day block of a membership." },
  { key: "booking_window_days", label: "Booking window (days)", type: "int", min: 1, max: 90, help: "How far ahead classes can be booked." },
  { key: "cancellation_returns_credit", label: "Cancellation returns credit", type: "bool", help: "Off: a cancelled class loses its credit; customers should reschedule instead." },
  { key: "absence_credit_restore_enabled", label: "Restore credit on absence", type: "bool", help: "When staff mark a rider absent or excused, give the credit back once." },
  { key: "max_restored_absences", label: "Max restored absences per membership", type: "nullable-int", min: 0, max: 1000, help: "Leave empty for unlimited. A cap limits book-then-absent loops." },
  { key: "pending_order_expiry_hours", label: "Unpaid order expiry (hours)", type: "int", min: 1, max: 720, help: "Pending orders with no online payment started are cancelled after this long." },
  { key: "class_reminder_hours", label: "Class reminder (hours before)", type: "int", min: 1, max: 168, help: "In-app reminder before a booked class." },
  { key: "membership_expiry_notice_days", label: "Expiry notice (days before)", type: "int", min: 1, max: 30, help: "In-app notice before a membership with classes left ends." },
];

export default function AdminSettings() {
  const settings = useAdminQuery(() => supabase.from("system_settings").select("key, value, updated_at"));
  const plans = useAdminQuery(() =>
    supabase.from("membership_plans").select("id, name, plan_code, price, class_credits, reschedules_allowed, is_active, validity_days").not("plan_code", "is", null).order("price")
  );

  const valueOf = (key) => (settings.data ?? []).find((s) => s.key === key)?.value;

  return (
    <div>
      <PageHeader
        route="settings"
        actions={
          <ActionButton icon={RefreshCw} onClick={() => { settings.reload(); plans.reload(); }}>
            Refresh
          </ActionButton>
        }
      />

      <SectionHeader title="Booking & credit rules" hint="Changes take effect immediately and are recorded in the audit log." />
      {settings.status === "error" && <ErrorBox message={settings.error} onRetry={settings.reload} />}
      {settings.status === "loading" && <Loading>Loading settings…</Loading>}
      {settings.status === "ready" && (
        <div className="mb-10 grid grid-cols-1 gap-4 md:grid-cols-2">
          {SETTINGS.map((def) => (
            <SettingCard key={`${def.key}:${JSON.stringify(valueOf(def.key))}`} def={def} value={valueOf(def.key)} onSaved={settings.reload} />
          ))}
        </div>
      )}

      <SectionHeader title="Membership plans" hint="Edits apply to future purchases only. Existing memberships are unchanged." />
      {plans.status === "error" && <ErrorBox message={plans.error} onRetry={plans.reload} />}
      {plans.status === "loading" && <Loading>Loading plans…</Loading>}
      {plans.status === "ready" && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {(plans.data ?? []).map((p) => (
            <PlanCard key={`${p.id}:${p.price}:${p.class_credits}:${p.reschedules_allowed}:${p.is_active}`} plan={p} onSaved={plans.reload} />
          ))}
        </div>
      )}
    </div>
  );
}

function SettingCard({ def, value, onSaved }) {
  const initial = value === null || value === undefined ? "" : value;
  const [draft, setDraft] = useState(initial);
  const [state, setState] = useState({ busy: false, error: null, saved: false });
  const dirty = String(draft) !== String(initial);

  const save = async () => {
    let payload;
    if (def.type === "bool") payload = Boolean(draft);
    else if (def.type === "nullable-int" && String(draft).trim() === "") payload = null;
    else payload = Number(draft);

    const nextLabel = payload === null ? "unlimited" : String(payload);
    if (!window.confirm(`Change "${def.label}" to ${nextLabel}? This takes effect immediately.`)) return;

    setState({ busy: true, error: null, saved: false });
    const { error } = await adminApi.updateSetting(def.key, payload);
    if (error) {
      setState({ busy: false, error, saved: false });
      return;
    }
    setState({ busy: false, error: null, saved: true });
    onSaved();
  };

  return (
    <Card>
      <p className="font-sans text-sm font-medium text-charcoal">{def.label}</p>
      <p className="mt-1 font-sans text-xs leading-relaxed text-warm-grey">{def.help}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {def.type === "bool" ? (
          <label className="flex items-center gap-2 font-sans text-sm text-charcoal">
            <input type="checkbox" checked={Boolean(draft)} onChange={(e) => setDraft(e.target.checked)} /> {draft ? "On" : "Off"}
          </label>
        ) : (
          <input
            type="number"
            min={def.min}
            max={def.max}
            step="1"
            value={draft}
            placeholder={def.type === "nullable-int" ? "Unlimited" : undefined}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={def.label}
            className="w-32 rounded-[10px] border border-antique-gold/25 bg-white px-3 py-2 font-sans text-sm text-charcoal outline-none focus:border-antique-gold"
          />
        )}
        <ActionButton variant={dirty ? "primary" : "secondary"} disabled={!dirty || state.busy} onClick={save}>
          {state.busy ? "Saving…" : "Save"}
        </ActionButton>
        {state.saved && <span className="font-sans text-xs text-racing-green">Saved</span>}
      </div>
      {state.error && (
        <div className="mt-3">
          <InlineError message={state.error} />
        </div>
      )}
    </Card>
  );
}

function PlanCard({ plan, onSaved }) {
  const [form, setForm] = useState({
    price: plan.price,
    class_credits: plan.class_credits,
    reschedules_allowed: plan.reschedules_allowed,
    is_active: plan.is_active,
  });
  const [state, setState] = useState({ busy: false, error: null, saved: false });
  const dirty =
    Number(form.price) !== Number(plan.price) ||
    Number(form.class_credits) !== plan.class_credits ||
    Number(form.reschedules_allowed) !== plan.reschedules_allowed ||
    form.is_active !== plan.is_active;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  const save = async () => {
    if (!window.confirm(`Update ${plan.name}? New purchases will use these values; existing memberships are unchanged.`)) return;
    setState({ busy: true, error: null, saved: false });
    const { error } = await adminApi.updatePlan(plan.id, Number(form.price), Number(form.class_credits), Number(form.reschedules_allowed), form.is_active);
    if (error) {
      setState({ busy: false, error, saved: false });
      return;
    }
    setState({ busy: false, error: null, saved: true });
    onSaved();
  };

  return (
    <Card>
      <p className="font-serif text-lg text-charcoal">{plan.name}</p>
      <p className="font-sans text-[11px] tracking-[0.12em] text-warm-grey uppercase">{plan.plan_code} · valid {plan.validity_days} days</p>
      <div className="mt-4 space-y-3">
        <Num label="Price (₹)" value={form.price} onChange={set("price")} min={1} />
        <Num label="Classes" value={form.class_credits} onChange={set("class_credits")} min={1} max={100} />
        <Num label="Reschedules" value={form.reschedules_allowed} onChange={set("reschedules_allowed")} min={0} max={20} />
        <label className="flex items-center gap-2 font-sans text-sm text-charcoal">
          <input type="checkbox" checked={form.is_active} onChange={set("is_active")} /> Available in the store
        </label>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <ActionButton variant={dirty ? "primary" : "secondary"} disabled={!dirty || state.busy} onClick={save}>
          {state.busy ? "Saving…" : "Save plan"}
        </ActionButton>
        {state.saved && <span className="font-sans text-xs text-racing-green">Saved</span>}
      </div>
      {state.error && (
        <div className="mt-3">
          <InlineError message={state.error} />
        </div>
      )}
    </Card>
  );
}

function Num({ label, ...props }) {
  return (
    <label className="flex items-center justify-between gap-3 font-sans text-sm text-charcoal">
      <span className="text-warm-grey">{label}</span>
      <input
        type="number"
        step="1"
        {...props}
        aria-label={label}
        className="w-28 rounded-[10px] border border-antique-gold/25 bg-white px-3 py-2 text-right font-sans text-sm outline-none focus:border-antique-gold"
      />
    </label>
  );
}
