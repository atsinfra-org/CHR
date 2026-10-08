import { useEffect, useId } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, ChevronLeft, ChevronRight, RefreshCw, Search as SearchIcon, X } from "lucide-react";
import { addDays, fmtDate, titleCase } from "./adminUtils";
import { PAGE_META } from "./adminNav";

/**
 * THE UNIVERSAL ADMIN DESIGN SYSTEM.
 *
 * Every admin page imports its shared surface from this one module, which is
 * what keeps eleven pages looking like one product. The visual language is
 * universal; the information architecture is not — pages compose these
 * primitives into whatever layout suits their purpose.
 *
 * Language: warm-ivory/soft-cream ground, warm-white surfaces, deep-forest
 * identity, antique-gold accents, hairline borders, soft restrained shadows,
 * generous spacing. Editorial serif for titles and headline numbers only;
 * Manrope for everything else.
 *
 * Radius scale (§7): buttons 10 · inputs 12 · small cards 14 · cards 18 ·
 * panels/tables 20 · drawer 24.
 *
 * The exported names and signatures here are deliberately unchanged from the
 * previous version, so all ten existing pages inherit the new language
 * without a single page edit.
 */

/* ============================================================== SURFACES */

export function Card({ children, className = "", padded = true }) {
  return (
    <section
      className={`rounded-[18px] border border-antique-gold/20 bg-white shadow-[0_1px_2px_rgba(27,27,24,0.04),0_12px_32px_-18px_rgba(8,28,21,0.13)] ${
        padded ? "p-5 sm:p-6" : ""
      } ${className}`}
    >
      {children}
    </section>
  );
}

/* ========================================================== PAGE HEADER */

/**
 * §12/§13 — context -> title -> purpose -> actions.
 * `route` pulls section/title/description from adminNav's PAGE_META so the
 * sidebar label and the page title can never drift apart. Any field can be
 * overridden per page.
 */
export function PageHeader({ route, section, title, description, actions }) {
  const meta = (route && PAGE_META[route]) || {};
  const sectionLabel = section ?? meta.section;
  const pageTitle = title ?? meta.title;
  const purpose = description ?? meta.description;

  return (
    <header className="mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        {sectionLabel && (
          <p className="font-sans text-[10.5px] tracking-[0.22em] text-antique-gold uppercase">{sectionLabel}</p>
        )}
        <h1 className="mt-2 font-serif text-[1.85rem] leading-tight text-charcoal sm:text-[2.1rem]">{pageTitle}</h1>
        {purpose && <p className="mt-1.5 max-w-xl font-sans text-sm leading-relaxed text-warm-grey">{purpose}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </header>
  );
}

/** Quieter header for a section *within* a page. */
export function SectionHeader({ title, hint, action, className = "" }) {
  return (
    <div className={`mb-4 flex items-start justify-between gap-3 ${className}`}>
      <div>
        <h2 className="font-sans text-[11px] tracking-[0.18em] text-warm-grey uppercase">{title}</h2>
        {hint && <p className="mt-1 font-sans text-xs text-warm-grey/80">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/* =============================================================== STATUS */

// Preserved verbatim from the previous implementation — these map to real
// database status values only. Anything not listed renders neutral; no new
// status vocabulary is invented here (§6/§31).
const TONE = {
  active: "positive",
  available: "positive",
  open: "positive",
  confirmed: "positive",
  present: "positive",
  paid: "positive",
  collected: "positive",
  ready_for_collection: "warning",
  excused: "warning",
  success: "positive",
  admin: "warning",
  staff: "warning",
  pending_payment: "warning",
  pending: "warning",
  processing: "warning",
  created: "warning",
  maintenance: "warning",
  rest: "warning",
  cancelled: "negative",
  failed: "negative",
  no_show: "negative",
  absent: "negative",
  expired: "negative",
  medical: "negative",
};

const DOT = {
  positive: "bg-racing-green",
  warning: "bg-antique-gold",
  negative: "bg-destructive",
  neutral: "bg-warm-grey/60",
};
const TEXT = {
  positive: "text-racing-green",
  warning: "text-[#8a6d2f]",
  negative: "text-destructive",
  neutral: "text-warm-grey",
};

/** §31 — compact dot + label, never a large rectangular badge. */
export function StatusPill({ value }) {
  if (value == null || value === "") return <span className="font-sans text-sm text-warm-grey/60">—</span>;
  const tone = TONE[value] || "neutral";
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap font-sans text-[12.5px] ${TEXT[tone]}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden="true" />
      {titleCase(value)}
    </span>
  );
}

/** Kept so existing pages calling <Badge value={…} /> need no edit. */
export const Badge = StatusPill;

/* ================================================================= KPIs */

/**
 * §23 — the grid adapts to however many KPIs are actually valid. auto-fit
 * means 1, 2, 3 or 4 cards all fill the row properly; there are never empty
 * placeholder slots left behind to preserve a four-column shape.
 */
export function StatGrid({ children, className = "" }) {
  return (
    <div
      className={`grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))] ${className}`}
    >
      {children}
    </div>
  );
}

const CHIP_TONE = {
  forest: "bg-racing-green/10 text-racing-green",
  sage: "bg-sage/12 text-sage",
  gold: "bg-antique-gold/15 text-[#8a6d2f]",
  rose: "bg-destructive/10 text-destructive",
  neutral: "bg-antique-gold/12 text-antique-gold",
};

/** Small colored icon chip, shared by StatCard/KpiCard and the activity feed
 * so a KPI's icon and an activity row's icon read as the same design
 * language rather than two different treatments. */
export function IconChip({ icon: Icon, tone = "neutral", size = 38 }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-[12px] ${CHIP_TONE[tone] || CHIP_TONE.neutral}`}
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.46)} strokeWidth={1.75} />
    </span>
  );
}

/**
 * §20 — zero and unavailable are different things and must look different.
 *   value={0}    -> "0"  (the system knows the answer and it is zero)
 *   value={null} -> "—"  (the system cannot compute this)
 * Pass `hint` only when it states something true about real data.
 */
export function StatCard({ icon: Icon, label, value, hint, loading = false, tone = "default" }) {
  const unavailable = value === null || value === undefined;
  return (
    <Card className="flex flex-col justify-between">
      <div className="flex items-center gap-3">
        {Icon && <IconChip icon={Icon} tone={tone === "accent" ? "forest" : "neutral"} />}
        <span className="font-sans text-[10.5px] tracking-[0.16em] text-warm-grey uppercase">{label}</span>
      </div>

      {loading ? (
        <Skeleton className="mt-4 h-9 w-24" />
      ) : (
        <p
          className={`mt-4 font-serif text-[2.1rem] leading-none numerals-editorial ${
            unavailable ? "text-warm-grey/45" : tone === "accent" ? "text-racing-green" : "text-charcoal"
          }`}
        >
          {unavailable ? "—" : value}
        </p>
      )}

      <p className="mt-2 min-h-[18px] font-sans text-xs text-warm-grey">
        {loading ? "" : unavailable ? "Data unavailable" : hint || ""}
      </p>
    </Card>
  );
}

/* ============================================================== CONTROLS */

/** §32 — primary forest, secondary outline, danger. */
export function ActionButton({
  children,
  variant = "secondary",
  icon: Icon,
  type = "button",
  className = "",
  ...rest
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-[10px] px-4 py-2.5 font-sans text-xs tracking-[0.12em] uppercase transition-colors duration-200 disabled:opacity-50 disabled:pointer-events-none";
  const variants = {
    primary: "bg-racing-green text-warm-ivory hover:bg-deep-forest",
    secondary: "border border-antique-gold/35 bg-white text-charcoal hover:border-antique-gold hover:bg-soft-cream/50",
    ghost: "text-warm-grey hover:text-charcoal",
    danger: "border border-destructive/35 bg-white text-destructive hover:bg-destructive/5",
  };
  return (
    <button type={type} className={`${base} ${variants[variant]} ${className}`} {...rest}>
      {Icon && <Icon size={14} strokeWidth={1.75} />}
      {children}
    </button>
  );
}

export function SearchField({ value, onChange, placeholder = "Search…", className = "" }) {
  return (
    <div className={`relative ${className}`}>
      <SearchIcon
        size={15}
        strokeWidth={1.75}
        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-warm-grey"
      />
      <input
        type="text"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full rounded-[12px] border border-antique-gold/25 bg-white py-2.5 pl-9 pr-3 font-sans text-sm text-charcoal outline-none transition-colors focus:border-antique-gold"
      />
    </div>
  );
}

export function SelectField({ label, value, onChange, children, className = "" }) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">{label}</span>}
      <select
        value={value}
        onChange={onChange}
        className={`${label ? "mt-1.5" : ""} block w-full rounded-[12px] border border-antique-gold/25 bg-white px-3 py-2.5 font-sans text-sm text-charcoal outline-none transition-colors focus:border-antique-gold`}
      >
        {children}
      </select>
    </label>
  );
}

export function Toolbar({ children, className = "" }) {
  return <div className={`mb-5 flex flex-wrap items-end justify-between gap-3 ${className}`}>{children}</div>;
}

/**
 * Day stepper for the date-scoped screens (Sessions, Attendance), which
 * previously carried a hand-rolled copy each. Dates are plain "YYYY-MM-DD"
 * business dates on the Asia/Kolkata calendar — addDays() keeps the
 * arithmetic in UTC so stepping never drifts across a timezone boundary.
 */
export function DayPicker({ value, onChange, className = "" }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <button
        type="button"
        aria-label="Previous day"
        onClick={() => onChange(addDays(value, -1))}
        className="rounded-[10px] border border-antique-gold/30 bg-white p-2.5 text-charcoal transition-colors hover:border-antique-gold hover:bg-soft-cream/50"
      >
        <ChevronLeft size={16} strokeWidth={1.75} />
      </button>
      <input
        type="date"
        value={value}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        aria-label="Date"
        className="rounded-[12px] border border-antique-gold/25 bg-white px-3 py-2.5 font-sans text-sm text-charcoal outline-none transition-colors focus:border-antique-gold"
      />
      <button
        type="button"
        aria-label="Next day"
        onClick={() => onChange(addDays(value, 1))}
        className="rounded-[10px] border border-antique-gold/30 bg-white p-2.5 text-charcoal transition-colors hover:border-antique-gold hover:bg-soft-cream/50"
      >
        <ChevronRight size={16} strokeWidth={1.75} />
      </button>
      <span className="ml-1 hidden font-sans text-sm text-warm-grey sm:inline">{fmtDate(value)}</span>
    </div>
  );
}

/* ================================================================ TABLE */

/**
 * Responsive data table. At >=768px this is a normal table honouring
 * `minWidth` (scrolling horizontally when the columns need it). Below that
 * it reflows into one card per row: the header row is hidden and every cell
 * is prefixed with its own column label, so nothing depends on a 720-960px
 * viewport.
 *
 * The labels are emitted as scoped `td:nth-child(n)::before` rules rather
 * than injected onto each <td> with cloneElement, because two callers
 * (AdminAttendance, AdminRoles) render their rows as components — those
 * <td>s aren't reachable as direct children, so cloning would silently
 * no-op on exactly those two tables. CSS matches regardless of which
 * component rendered the row.
 *
 * `minWidth` is applied in the stylesheet (not as an inline style) so it can
 * be confined to >=768px; inline styles can't be media-queried, and on
 * mobile it's precisely the thing that must not apply.
 */
export function TableShell({ head, children, minWidth = "720px" }) {
  const uid = useId();
  // Strip everything that isn't valid in a CSS class name rather than just
  // colons: useId's format is a React internal (":r0:" on 18, "_R_0_" on 19)
  // and a stray special character would make the selector invalid, silently
  // dropping the mobile reflow on every table.
  const cls = `tbl-${uid.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  // Columns with an empty header (action columns) get no ::before rule —
  // `content` is required for the pseudo-element to generate at all, so they
  // simply render label-less.
  const labels = head
    .map((col, i) =>
      col ? `.${cls} td:nth-child(${i + 1})::before{content:"${String(col).replace(/["\\]/g, "\\$&")}"}` : ""
    )
    .join("");

  const css = `
@media (min-width:768px){.${cls}{min-width:${minWidth}}}
@media (max-width:767px){
.${cls},.${cls} tbody,.${cls} tr,.${cls} td{display:block;width:100%}
.${cls} thead{display:none}
.${cls} tr{border-bottom:1px solid rgba(27,27,24,.1);padding:.5rem 0}
.${cls} tr:last-child{border-bottom:0}
.${cls} td{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;padding:.45rem 1.1rem;text-align:right;white-space:normal}
.${cls} td:empty{display:none}
.${cls} td::before{flex:0 0 auto;text-align:left;white-space:nowrap;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:rgba(27,27,24,.5)}
${labels}}`;

  return (
    <div className="overflow-x-auto rounded-[20px] border border-antique-gold/20 bg-white shadow-[0_1px_2px_rgba(27,27,24,0.04),0_12px_32px_-18px_rgba(8,28,21,0.13)]">
      <style>{css}</style>
      <table className={`${cls} w-full border-collapse text-left`}>
        <thead>
          <tr className="border-b border-antique-gold/20 bg-soft-cream/50">
            {head.map((col, i) => (
              <th
                key={i}
                className="whitespace-nowrap px-4 py-3.5 font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/* ================================================================ STATES */

export function Skeleton({ className = "" }) {
  return <div className={`animate-pulse rounded-[10px] bg-charcoal/[0.07] ${className}`} />;
}

/** §25 — skeletons match the shape of the content they stand in for. */
export function TableSkeleton({ rows = 5 }) {
  return (
    <div className="overflow-hidden rounded-[20px] border border-antique-gold/20 bg-white p-4 shadow-[0_1px_2px_rgba(27,27,24,0.04)]">
      <Skeleton className="h-3 w-28" />
      <div className="mt-5 space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    </div>
  );
}

/**
 * §25 — signature unchanged (`<Loading>Loading horses…</Loading>`), but it
 * now renders a skeleton instead of a bare line of text. The caller's text
 * is kept for screen readers.
 */
export function Loading({ children = "Loading…", rows = 5 }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{children}</span>
      <TableSkeleton rows={rows} />
    </div>
  );
}

/**
 * §26 — a real zero-data state. Signature unchanged: existing pages pass the
 * headline as children; `detail` is optional and only added where the page
 * has something true to say.
 */
export function Empty({ children, detail, icon: Icon }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[18px] border border-dashed border-charcoal/12 bg-soft-cream/35 px-6 py-14 text-center">
      {Icon && <Icon size={20} strokeWidth={1.5} className="mb-3 text-antique-gold" />}
      <p className="font-sans text-sm text-charcoal">{children}</p>
      {detail && <p className="mt-1.5 max-w-sm font-sans text-xs leading-relaxed text-warm-grey">{detail}</p>}
    </div>
  );
}

/** §27 — the system cannot compute this, as distinct from "the answer is zero". */
export function Unavailable({ children = "Data unavailable", detail }) {
  return (
    <div className="rounded-[18px] border border-dashed border-charcoal/12 bg-soft-cream/25 px-6 py-10 text-center">
      <p className="font-sans text-sm text-warm-grey">{children}</p>
      {detail && <p className="mt-1.5 font-sans text-xs text-warm-grey/80">{detail}</p>}
    </div>
  );
}

/** §28 — one error pattern everywhere, wired to the page's existing reload. */
export function ErrorBox({ message, onRetry }) {
  return (
    <div className="rounded-[18px] border border-destructive/25 bg-destructive/[0.04] px-5 py-6 text-center">
      <AlertCircle size={18} strokeWidth={1.75} className="mx-auto text-destructive" />
      <p className="mt-3 font-sans text-sm text-charcoal">Unable to load this data</p>
      <p className="mt-1 font-sans text-xs leading-relaxed text-warm-grey">
        {message || "Something went wrong while retrieving the information."}
      </p>
      {onRetry && (
        <ActionButton variant="secondary" icon={RefreshCw} onClick={onRetry} className="mt-4">
          Retry
        </ActionButton>
      )}
    </div>
  );
}

export function InlineError({ message }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-[12px] border border-destructive/25 bg-destructive/[0.04] px-4 py-3">
      <AlertCircle size={15} strokeWidth={1.75} className="mt-0.5 shrink-0 text-destructive" />
      <p className="font-sans text-xs leading-relaxed text-destructive">{message}</p>
    </div>
  );
}

/* =============================================================== DRAWER */

/**
 * §33/§55 — right-side drawer on desktop, near-full-width sheet on mobile.
 * Escape closes, the body is scroll-locked while open, and the panel itself
 * scrolls. Used where a record has a natural detail workflow; pages that
 * already have a dedicated detail route keep it.
 */
export function DetailDrawer({ open, onClose, title, subtitle, children, footer }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80]" role="dialog" aria-modal="true" aria-label={title || "Details"}>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-deep-forest/45 backdrop-blur-[2px]"
            onClick={onClose}
          />
          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ duration: 0.28, ease: "easeOut" }}
            className="absolute inset-y-0 right-0 flex w-full max-w-[520px] flex-col bg-warm-ivory shadow-[0_0_60px_-10px_rgba(8,28,21,0.45)] sm:rounded-l-[24px]"
          >
            <div className="flex items-start justify-between gap-4 border-b border-antique-gold/20 px-5 py-4 sm:px-6">
              <div className="min-w-0">
                <h2 className="truncate font-serif text-xl text-charcoal">{title}</h2>
                {subtitle && <p className="mt-0.5 truncate font-sans text-xs text-warm-grey">{subtitle}</p>}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="rounded-[10px] p-1.5 text-charcoal/50 transition-colors hover:bg-soft-cream hover:text-charcoal"
              >
                <X size={18} strokeWidth={1.75} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>

            {footer && <div className="border-t border-antique-gold/20 px-5 py-4 sm:px-6">{footer}</div>}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}

/** Label/value row, used inside drawers and detail panels. */
export function Field({ label, value, className = "" }) {
  return (
    <div className={className}>
      <dt className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">{label}</dt>
      <dd className="mt-1 font-sans text-sm text-charcoal">{value ?? "—"}</dd>
    </div>
  );
}
