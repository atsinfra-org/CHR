import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, CheckCircle2, Info, RefreshCw, X } from "lucide-react";

/**
 * THE CUSTOMER AREA DESIGN SYSTEM.
 *
 * A sibling to src/admin/ui.jsx, not a fork of it — the two surfaces serve
 * different roles and are meant to feel different (this one lighter and
 * more spacious; the admin console denser and operational), so this module
 * owns its own primitives rather than importing across the admin/member
 * boundary. What it does share is the brand's actual color tokens
 * (racing-green / antique-gold / warm-ivory / soft-cream / charcoal /
 * warm-grey / destructive / warning, all defined once in index.css) — the
 * brief that requested this asked for near-identical hex values under new
 * names, and introducing a second slightly-different green/gold for just
 * this surface would make one brand look like two products.
 *
 * Status vocabulary (bookings/memberships/payments/attendance) is REAL
 * only: every value in STATUS_TONE below is an actual check-constraint
 * value in the schema. Nothing here invents a status the backend doesn't
 * have.
 */

/* ============================================================== SURFACES */

export function Card({ id, children, className = "", padded = true }) {
  return (
    <section
      id={id}
      className={`rounded-[18px] border border-antique-gold/20 bg-white shadow-[0_1px_2px_rgba(27,27,24,0.04),0_12px_32px_-18px_rgba(8,28,21,0.13)] ${padded ? "p-5 sm:p-6" : ""} ${className}`}
    >
      {children}
    </section>
  );
}

export function PageHeader({ title, description, actions, section = null, className = "" }) {
  return (
    <header className={`mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-4 ${className}`}>
      <div className="min-w-0">
        {section && <p className="font-sans text-[10.5px] tracking-[0.22em] text-antique-gold uppercase">{section}</p>}
        <h1 className="mt-2 font-serif text-[1.85rem] leading-tight text-charcoal sm:text-[2.1rem]">{title}</h1>
        {description && <p className="mt-1.5 max-w-xl font-sans text-sm leading-relaxed text-warm-grey">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </header>
  );
}

export function SectionHeader({ title, hint, action, className = "" }) {
  return (
    <div className={`mb-4 flex items-start justify-between gap-3 ${className}`}>
      <div>
        <h2 className="font-serif text-lg text-charcoal">{title}</h2>
        {hint && <p className="mt-0.5 font-sans text-xs text-warm-grey">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/* =============================================================== STATUS */

// Every key is a real check-constraint value: bookings.status,
// memberships.status, payments.status, attendance.status, credit_ledger.
// Nothing here is invented (no "Payment Failed"/"Pending Documents"/"Almost
// Full" backend status exists, so none is mapped).
const STATUS_TONE = {
  active: "success",
  paid: "success",
  ready_for_collection: "warning",
  collected: "neutral",
  rescheduled: "neutral",
  confirmed: "success",
  success: "success",
  present: "success",
  pending_payment: "warning",
  pending: "warning",
  processing: "warning",
  created: "warning",
  held: "warning",
  excused: "warning",
  cancelled: "danger",
  expired: "danger",
  suspended: "danger",
  failed: "danger",
  no_show: "danger",
  absent: "danger",
  completed: "neutral",
  refunded: "neutral",
  partially_refunded: "neutral",
};

const DOT = { success: "bg-racing-green", warning: "bg-warning", danger: "bg-destructive", neutral: "bg-warm-grey/60" };
const TEXT = { success: "text-racing-green", warning: "text-warning", danger: "text-destructive", neutral: "text-warm-grey" };

function titleCase(s) {
  if (!s) return "—";
  return String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** §31 (admin) / consistent with it here — a dot + label, never a loud
 * rectangular badge, and never color-only (the label is always present). */
export function StatusPill({ value, label }) {
  if (value == null || value === "") return <span className="font-sans text-sm text-warm-grey/60">—</span>;
  const tone = STATUS_TONE[value] || "neutral";
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap font-sans text-[13px] font-medium ${TEXT[tone]}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden="true" />
      {label || titleCase(value)}
    </span>
  );
}

/* ================================================================= KPIs */

export function StatGrid({ children, className = "" }) {
  return <div className={`grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))] ${className}`}>{children}</div>;
}

/**
 * §37 — the single most important rule in the brief. Three distinct render
 * paths, never collapsed into each other:
 *   status="ready"   value=0     -> "0"                (a real, computed zero)
 *   status="ready"   value=null  -> "—" + `emptyHint`   (no data exists yet)
 *   status="error"                -> "—" + Retry        (the request failed)
 * A caller can never accidentally produce "0" by passing null/undefined
 * through — the unavailable branch is keyed on `value == null`, not on
 * falsiness, so 0 always renders as 0.
 */
export function StatCard({ icon: Icon, label, value, hint, emptyHint, status = "ready", onRetry, loading = false }) {
  const isError = status === "error";
  const unavailable = !loading && !isError && (value === null || value === undefined);

  return (
    <Card className="flex flex-col justify-between">
      <div className="flex items-center gap-2">
        {Icon && <Icon size={16} strokeWidth={1.75} className="text-antique-gold" />}
        <span className="font-sans text-[11px] tracking-[0.14em] text-warm-grey uppercase">{label}</span>
      </div>

      {loading ? (
        <Skeleton className="mt-4 h-8 w-20" />
      ) : (
        <p className={`mt-3 font-serif text-[2rem] leading-none ${isError || unavailable ? "text-warm-grey/45" : "text-charcoal"}`}>
          {isError || unavailable ? "—" : value}
        </p>
      )}

      <div className="mt-2 min-h-[18px]">
        {loading ? null : isError ? (
          <button type="button" onClick={onRetry} className="flex items-center gap-1.5 font-sans text-xs text-destructive underline underline-offset-4">
            <RefreshCw size={11} strokeWidth={1.75} />
            Unable to load — retry
          </button>
        ) : (
          <p className="font-sans text-xs text-warm-grey">{unavailable ? emptyHint || "No data yet" : hint || ""}</p>
        )}
      </div>
    </Card>
  );
}

export function ProgressBar({ value, max, tone = "success", className = "" }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const fill = tone === "warning" ? "bg-warning" : tone === "danger" ? "bg-destructive" : "bg-racing-green";
  return (
    <div className={`h-2 w-full overflow-hidden rounded-full bg-soft-cream ${className}`}>
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${fill}`}
        style={{ width: `${pct}%` }}
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
      />
    </div>
  );
}

/* ============================================================== CONTROLS */

/** §35 — primary/secondary/ghost/danger, each with hover/active/focus/
 * disabled built in via Tailwind state variants + `disabled:`. */
export function ActionButton({ children, variant = "secondary", icon: Icon, type = "button", loading = false, href, className = "", ...rest }) {
  const base =
    "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[10px] px-4 font-sans text-xs tracking-[0.12em] uppercase transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-antique-gold disabled:opacity-50 disabled:pointer-events-none";
  const variants = {
    primary: "bg-racing-green text-warm-ivory hover:bg-deep-forest active:bg-deep-forest",
    secondary: "border border-antique-gold/35 bg-white text-charcoal hover:border-antique-gold hover:bg-soft-cream/50",
    ghost: "text-warm-grey hover:text-charcoal",
    danger: "border border-destructive/35 bg-white text-destructive hover:bg-destructive/5",
  };
  const content = (
    <>
      {loading ? <RefreshCw size={15} strokeWidth={1.75} className="animate-spin" /> : Icon && <Icon size={16} strokeWidth={1.75} />}
      {children}
    </>
  );

  if (href) {
    return (
      <a href={href} className={`${base} ${variants[variant]} ${className}`} {...rest}>
        {content}
      </a>
    );
  }

  return (
    <button type={type} className={`${base} ${variants[variant]} ${className}`} disabled={loading || rest.disabled} {...rest}>
      {content}
    </button>
  );
}

/* ================================================================ STATES */

export function Skeleton({ className = "" }) {
  return <div className={`animate-pulse rounded-[8px] bg-charcoal/[0.07] ${className}`} />;
}

/** §27 — skeletons matched to shape, not a spinner. */
export function CardSkeleton({ lines = 3 }) {
  return (
    <Card>
      <Skeleton className="h-3 w-24" />
      <div className="mt-5 space-y-3">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    </Card>
  );
}

export function KpiSkeleton() {
  return (
    <Card>
      <Skeleton className="h-3 w-20" />
      <Skeleton className="mt-4 h-8 w-16" />
      <Skeleton className="mt-3 h-3 w-24" />
    </Card>
  );
}

/** §26 — a real zero-data state, never a blank/broken-looking page. */
export function EmptyState({ icon: Icon, title, detail, action }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[18px] border border-dashed border-antique-gold/30 bg-soft-cream/40 px-6 py-12 text-center">
      {Icon && <Icon size={22} strokeWidth={1.5} className="mb-3 text-antique-gold" />}
      <p className="font-sans text-sm font-medium text-charcoal">{title}</p>
      {detail && <p className="mt-1.5 max-w-sm font-sans text-xs leading-relaxed text-warm-grey">{detail}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** §28 — human-readable, actionable, never a raw Supabase/PostgREST message. */
export function ErrorState({ title = "Something went wrong", detail, onRetry }) {
  return (
    <div className="rounded-[14px] border border-destructive/25 bg-destructive/[0.04] px-5 py-8 text-center">
      <AlertCircle size={20} strokeWidth={1.75} className="mx-auto text-destructive" />
      <p className="mt-3 font-sans text-sm font-medium text-charcoal">{title}</p>
      {detail && <p className="mt-1 font-sans text-xs text-warm-grey">{detail}</p>}
      {onRetry && (
        <ActionButton variant="secondary" icon={RefreshCw} onClick={onRetry} className="mx-auto mt-4">
          Try Again
        </ActionButton>
      )}
    </div>
  );
}

export function InlineError({ message }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-[10px] border border-destructive/25 bg-destructive/[0.04] px-4 py-3">
      <AlertCircle size={15} strokeWidth={1.75} className="mt-0.5 shrink-0 text-destructive" />
      <p className="font-sans text-xs leading-relaxed text-destructive">{message}</p>
    </div>
  );
}

/* ================================================================ TOAST */
/* No toast system exists anywhere in the app yet — this is the one real
 * piece of new UI infrastructure this page needed, built on framer-motion
 * (already a dependency) rather than a new package. Used sparingly, per
 * the brief's own "do not spam toasts" — booking confirm/cancel only. */

const ToastContext = createContext(null);
const TOAST_ICON = { success: CheckCircle2, error: AlertCircle, warning: Info };
const TOAST_TONE = { success: "border-racing-green/25 text-racing-green", error: "border-destructive/25 text-destructive", warning: "border-warning/25 text-warning" };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const notify = useCallback(
    (message, tone = "success") => {
      const id = Math.random().toString(36).slice(2);
      setToasts((t) => [...t, { id, message, tone }]);
      setTimeout(() => dismiss(id), 4000);
    },
    [dismiss]
  );

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* bottom-20 clears MemberLayout's fixed mobile bottom nav (~64px +
          safe-area); that nav is hidden from md up, where bottom-6 applies. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[100] flex flex-col items-center gap-2 px-4 md:bottom-6">
        <AnimatePresence>
          {toasts.map((t) => {
            const Icon = TOAST_ICON[t.tone] || Info;
            return (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.2 }}
                className={`pointer-events-auto flex items-center gap-2.5 rounded-[10px] border bg-white px-4 py-3 shadow-[0_8px_24px_-8px_rgba(24,32,28,0.25)] ${TOAST_TONE[t.tone] || TOAST_TONE.success}`}
              >
                <Icon size={16} strokeWidth={1.75} />
                <p className="font-sans text-sm text-charcoal">{t.message}</p>
                <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="ml-1 text-warm-grey/60 hover:text-charcoal">
                  <X size={14} strokeWidth={1.75} />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

/* =============================================================== DIALOG */

/** Minimal accessible confirm dialog — used for "Cancel this booking?"
 * rather than the inline confirm/keep row every card previously improvised
 * on its own. */
export function ConfirmDialog({ open, title, description, confirmLabel = "Confirm", danger = false, busy = false, onConfirm, onClose }) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div data-lenis-prevent className="fixed inset-0 z-[90] flex items-center justify-center px-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-charcoal/40" onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            className="relative w-full max-w-sm rounded-[14px] bg-white p-6 shadow-[0_24px_60px_-20px_rgba(24,32,28,0.35)]"
          >
            <h2 id={titleId} className="font-serif text-lg text-charcoal">{title}</h2>
            {description && <p className="mt-2 font-sans text-sm leading-relaxed text-warm-grey">{description}</p>}
            <div className="mt-6 flex justify-end gap-2.5">
              <ActionButton variant="ghost" onClick={onClose} disabled={busy}>
                Keep
              </ActionButton>
              <ActionButton variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={busy}>
                {confirmLabel}
              </ActionButton>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
