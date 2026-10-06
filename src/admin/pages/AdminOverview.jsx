import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import {
  Users,
  BadgeCheck,
  PawPrint,
  CalendarCheck,
  IndianRupee,
  CreditCard,
  CalendarClock,
  Activity,
  ScrollText,
  PieChart,
  TrendingUp,
  GaugeCircle,
  Sun,
  Sunset,
  Moon,
  ShieldCheck,
  Coins,
  CalendarPlus,
  CalendarCog,
  XCircle,
  ClipboardCheck,
  ArrowRight,
} from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import { fmtMoney, fmtTime, istToday, addDays, titleCase } from "../adminUtils";
import { relativeTime } from "../../account/dashboardUtils";
import { Card, Empty, ErrorBox, IconChip, PageHeader, SectionHeader, Skeleton, StatusPill } from "../ui";
import { AreaLineChart, BarChart, Donut } from "../dashboard/charts";
import KpiCard from "../dashboard/KpiCard";
import { useAuth } from "../../context/AuthProvider";

const RANGES = [
  { key: "7", label: "7D", days: 7, grain: "day" },
  { key: "30", label: "30D", days: 30, grain: "week" },
  { key: "90", label: "90D", days: 90, grain: "month" },
];

const STATUS_COLORS = {
  active: "#12372a",
  pending_payment: "#c6a15b",
  expired: "#b3261e",
  cancelled: "#706d63",
  suspended: "#d8c08a",
};

const HORSE_STATUSES = ["available", "maintenance", "rest", "medical", "retired"];

// One admin_dashboard_metrics() KPI = one alternating icon-chip tone, purely
// for visual rhythm (the reference this was built against alternates two
// tones across its KPI row rather than assigning meaning per-metric).
const KPI_TONES = ["sage", "gold", "sage", "gold", "sage", "gold"];

// Every key here is a real public.audit_logs.action value written by an
// admin RPC (0014_admin_operations.sql) — see ActivityFeed. Nothing is
// invented: audit_logs does not record member self-service events (a
// booking made, a payment succeeding), so "new booking" / "payment
// received" style entries are deliberately not shown here (§44).
const ACTION_META = {
  BOOTSTRAP_FIRST_ADMIN: { label: "First admin bootstrapped", icon: ShieldCheck, tone: "forest" },
  SET_ROLE: { label: "Role changed", icon: ShieldCheck, tone: "gold" },
  ADJUST_CREDITS: { label: "Credits adjusted", icon: Coins, tone: "gold" },
  GENERATE_SESSIONS: { label: "Sessions generated", icon: CalendarPlus, tone: "sage" },
  SET_SESSION_STATUS: { label: "Session status changed", icon: CalendarCog, tone: "sage" },
  CREATE_HORSE: { label: "Horse added", icon: PawPrint, tone: "sage" },
  SET_HORSE_STATUS: { label: "Horse status changed", icon: PawPrint, tone: "sage" },
  ADMIN_CANCEL_BOOKING: { label: "Booking cancelled", icon: XCircle, tone: "rose" },
  MARK_ATTENDANCE: { label: "Attendance marked", icon: ClipboardCheck, tone: "gold" },
};

// A short, static editorial line for the hero's quote card — brand voice
// copy in the same family as "Better Horses. Brighter Tomorrows." and the
// sidebar's closing line, not a data point.
const HERO_QUOTE = "Well cared for horses make for brighter days.";

function shortDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}
function shortMonth(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
}
function istHour() {
  return Number(new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }));
}
function greeting() {
  const h = istHour();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}
function TimeOfDayIcon({ className }) {
  const h = istHour();
  const Icon = h < 12 ? Sun : h < 17 ? Sunset : Moon;
  return <Icon className={className} strokeWidth={1.75} aria-hidden="true" />;
}
function niceToday() {
  return new Date(`${istToday()}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
function shortToday() {
  return new Date(`${istToday()}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Operational dashboard (§42). Every figure comes from a server-side
 * aggregation RPC (admin_dashboard_*) or available_sessions(); nothing is
 * fabricated, and each panel degrades to an honest empty/unavailable state.
 *
 * Built on the shared admin design system (ui.jsx) like every other page —
 * the dashboard no longer carries its own parallel set of surface, header,
 * empty-state and error primitives (§64).
 */
export default function AdminOverview({ isAdmin }) {
  const { profile, user } = useAuth();
  const [rangeKey, setRangeKey] = useState("30");
  const range = RANGES.find((r) => r.key === rangeKey);

  const today = istToday();
  const from = addDays(today, -(range.days - 1));

  const metricsQ = useAdminQuery(() => adminApi.dashboardMetrics());
  const bookingQ = useAdminQuery(() => adminApi.dashboardBookingSeries(from, today), [from, today]);
  const revenueQ = useAdminQuery(() => adminApi.dashboardRevenueSeries(from, today, range.grain), [from, today, range.grain]);
  const membershipQ = useAdminQuery(() => adminApi.dashboardMembershipBreakdown());
  const scheduleQ = useAdminQuery(() => supabase.rpc("available_sessions", { p_date: today }), [today]);
  const activityQ = useAdminQuery(
    () =>
      isAdmin
        ? supabase
            .from("audit_logs")
            .select("id, action, table_name, performed_by, new_values, created_at, actor:profiles!audit_logs_performed_by_fkey(full_name, email)")
            .order("created_at", { ascending: false })
            .limit(8)
        : Promise.resolve({ data: [], error: null }),
    [isAdmin]
  );

  const m = Array.isArray(metricsQ.data) ? metricsQ.data[0] : metricsQ.data;
  const bookingSeries = useMemo(() => (Array.isArray(bookingQ.data) ? bookingQ.data : []), [bookingQ.data]);
  const revenueSeries = useMemo(() => (Array.isArray(revenueQ.data) ? revenueQ.data : []), [revenueQ.data]);
  const breakdown = useMemo(() => (Array.isArray(membershipQ.data) ? membershipQ.data : []), [membershipQ.data]);

  const loading = metricsQ.status === "loading";

  const bookingSpark = bookingSeries.slice(-14).map((p) => p.bookings);
  const revenueSpark = revenueSeries.map((p) => Number(p.revenue));

  // §21 — a comparison appears only when the previous period has real data.
  const revenueDelta = useMemo(() => {
    if (!m) return null;
    const prev = Number(m.revenue_prev_30d);
    const cur = Number(m.revenue_30d);
    if (!prev || prev <= 0) return null;
    return { pct: ((cur - prev) / prev) * 100, label: "vs prev 30d" };
  }, [m]);

  const bookingDelta = useMemo(() => {
    if (bookingSeries.length < 4) return null;
    const half = Math.floor(bookingSeries.length / 2);
    const first = bookingSeries.slice(0, half).reduce((s, p) => s + p.bookings, 0);
    const second = bookingSeries.slice(half).reduce((s, p) => s + p.bookings, 0);
    if (first <= 0) return null;
    return { pct: ((second - first) / first) * 100, label: "vs prior half" };
  }, [bookingSeries]);

  const capacityBars = useMemo(
    () =>
      bookingSeries
        .filter((p) => p.capacity > 0)
        .map((p) => ({
          label: shortDay(p.day),
          // Clamped defensively: a session cancelled *after* its bookings were
          // marked completed/no_show (admin_set_session_status only blocks
          // cancelling while held/confirmed bookings exist) would drop out of
          // the capacity denominator while its bookings still count.
          value: Math.min(100, Math.round((p.bookings / p.capacity) * 100)),
          sub: `${p.bookings}/${p.capacity} seats`,
        })),
    [bookingSeries]
  );

  const statusSegments = breakdown
    .filter((r) => r.dimension === "status" && r.count > 0)
    .map((r) => ({ label: titleCase(r.key), value: r.count, color: STATUS_COLORS[r.key] || "#706d63" }));
  const membershipTotal = statusSegments.reduce((s, x) => s + x.value, 0);

  const reduce = useReducedMotion();
  const fade = reduce ? {} : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.25 } };

  if (metricsQ.status === "error") {
    return (
      <div className="mx-auto max-w-2xl">
        <ErrorBox message={metricsQ.error} onRetry={metricsQ.reload} />
      </div>
    );
  }

  const name = (profile?.full_name || user?.email || "there").split("@")[0];
  const ready = !loading && m;

  return (
    <div className="space-y-6">
      <PageHeader
        section="Overview"
        title={
          <span className="inline-flex items-center gap-2.5">
            <TimeOfDayIcon className="h-6 w-6 text-antique-gold" />
            {greeting()}, {name}
          </span>
        }
        description={`Here's what's happening at Colonel Horse Riding — ${niceToday()} (IST).`}
        actions={<RangeSwitch value={rangeKey} onChange={setRangeKey} />}
      />

      {/* Hero band + a small honest "today" card. The date is real
          (istToday()); the line beneath it is static brand copy, the same
          kind already used elsewhere ("Better Horses. Brighter Tomorrows."),
          not a data point. */}
      <div className="-mt-1 flex flex-col gap-4 lg:flex-row">
        <div className="relative flex-1 overflow-hidden rounded-[22px] border border-antique-gold/25">
          <img src="/hero.png" alt="" className="h-40 w-full object-cover object-[50%_18%] sm:h-48" />
          <div className="absolute inset-0 bg-gradient-to-r from-deep-forest/85 via-deep-forest/55 to-transparent" />
          <div className="absolute inset-0 flex flex-col justify-center px-6 sm:px-9">
            <p className="font-sans text-[10px] tracking-[0.24em] text-champagne-gold uppercase">Colonel Horse Riding</p>
            <p className="mt-1 font-serif text-2xl text-warm-ivory sm:text-3xl">Better Horses. Brighter Tomorrows.</p>
          </div>
        </div>

        <Card className="flex w-full flex-col justify-center gap-2 lg:w-60" padded>
          <p className="font-sans text-xs text-warm-grey">{shortToday()}</p>
          <p className="font-serif text-[15px] italic leading-snug text-charcoal">&ldquo;{HERO_QUOTE}&rdquo;</p>
        </Card>
      </div>

      {/* Core KPIs — every value is a real server figure (§16). Icon-chip
          tones alternate purely for visual rhythm; see KPI_TONES above. */}
      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        <KpiCard label="Total Members" value={ready ? m.total_members : null} icon={Users} tone={KPI_TONES[0]} loading={loading} />
        <KpiCard
          label="Active Memberships"
          value={ready ? m.active_memberships : null}
          icon={BadgeCheck}
          tone={KPI_TONES[1]}
          loading={loading}
        />
        <KpiCard label="Available Horses" value={ready ? m.active_horses : null} icon={PawPrint} tone={KPI_TONES[2]} loading={loading} />
        <KpiCard
          label="Bookings"
          value={ready ? m.total_bookings : null}
          icon={CalendarCheck}
          tone={KPI_TONES[3]}
          spark={bookingSpark}
          delta={bookingDelta}
          loading={loading}
        />
        <KpiCard
          label="Revenue"
          value={ready ? fmtMoney(Number(m.revenue_total), "INR") : null}
          icon={IndianRupee}
          tone={KPI_TONES[4]}
          spark={revenueSpark.length >= 2 ? revenueSpark : null}
          sparkTone="gold"
          delta={revenueDelta}
          loading={loading}
        />
        <KpiCard
          label="Pending Payments"
          value={ready ? m.pending_payments : null}
          icon={CreditCard}
          tone={KPI_TONES[5]}
          loading={loading}
        />
      </div>

      {/* Booking Activity · Revenue Overview */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <motion.div {...fade}>
          <Card>
            <SectionHeader title="Booking Activity" hint={`Seats booked by class date · last ${range.days} days`} />
            {bookingQ.status === "loading" ? (
              <Skeleton className="h-[200px] w-full" />
            ) : bookingQ.status === "error" ? (
              <ErrorBox message={bookingQ.error} onRetry={bookingQ.reload} />
            ) : bookingSeries.every((p) => p.bookings === 0) ? (
              <Empty icon={Activity} detail="Bookings will chart here as members book classes.">
                No booking data for this period
              </Empty>
            ) : (
              <AreaLineChart
                yLabel="Seats booked by class date"
                series={[
                  { key: "booked", label: "Booked", tone: "ink", points: bookingSeries.map((p) => ({ x: p.day, y: p.bookings })) },
                  { key: "capacity", label: "Capacity", tone: "gold", points: bookingSeries.map((p) => ({ x: p.day, y: p.capacity })) },
                ]}
                formatX={(x) => shortDay(x)}
                formatY={(v) => `${Math.round(v)}`}
              />
            )}
          </Card>
        </motion.div>

        <motion.div {...fade}>
          <Card>
            <SectionHeader title="Revenue Overview" hint={`Successful payments by ${range.grain} · last ${range.days} days`} />
            {revenueQ.status === "loading" ? (
              <Skeleton className="h-[200px] w-full" />
            ) : revenueQ.status === "error" ? (
              <ErrorBox message={revenueQ.error} onRetry={revenueQ.reload} />
            ) : revenueSeries.every((p) => Number(p.revenue) === 0) ? (
              <Empty icon={TrendingUp} detail="Confirmed Razorpay payments will appear here.">
                No revenue recorded for this period
              </Empty>
            ) : (
              <BarChart
                tone="gold"
                bars={revenueSeries.map((p) => ({
                  label: range.grain === "month" ? shortMonth(p.bucket) : shortDay(p.bucket),
                  value: Number(p.revenue),
                }))}
                formatY={(v) => fmtMoney(v, "INR")}
              />
            )}
          </Card>
        </motion.div>
      </div>

      {/* Capacity Utilisation · Today's Schedule */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <motion.div {...fade}>
          <Card>
            <SectionHeader title="Capacity Utilisation" hint="Confirmed bookings ÷ session capacity, per class day" />
            {bookingQ.status === "loading" ? (
              <Skeleton className="h-[200px] w-full" />
            ) : bookingQ.status === "error" ? (
              <ErrorBox message={bookingQ.error} onRetry={bookingQ.reload} />
            ) : capacityBars.length === 0 ? (
              <Empty icon={GaugeCircle} detail="Utilisation charts once sessions are scheduled in this period.">
                No sessions with capacity in this period
              </Empty>
            ) : (
              <BarChart bars={capacityBars} formatY={(v) => `${Math.round(v)}%`} />
            )}
          </Card>
        </motion.div>

        <motion.div {...fade}>
          <Card>
            <SectionHeader title="Today's Schedule" hint={niceToday()} />
            {scheduleQ.status === "loading" ? (
              <RowSkeletons />
            ) : scheduleQ.status === "error" ? (
              <ErrorBox message={scheduleQ.error} onRetry={scheduleQ.reload} />
            ) : (scheduleQ.data ?? []).length === 0 ? (
              <Empty icon={CalendarClock} detail="Generate sessions from the Sessions page.">
                No sessions scheduled today
              </Empty>
            ) : (
              <Timeline rows={scheduleQ.data} />
            )}
          </Card>
        </motion.div>
      </div>

      {/* Horse Roster · Membership Overview */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <motion.div {...fade}>
          <Card>
            <SectionHeader title="Horse Roster" hint="By status — not an allocation to sessions" />
            {loading ? (
              <RowSkeletons />
            ) : !m ? (
              <Empty icon={PawPrint}>Horse data unavailable</Empty>
            ) : (
              <ul className="divide-y divide-charcoal/[0.06]">
                {HORSE_STATUSES.map((s) => (
                  <li key={s} className="flex items-center justify-between py-2.5">
                    <StatusPill value={s} />
                    <span className="font-serif text-xl text-charcoal numerals-editorial">{m[`horses_${s}`] ?? 0}</span>
                  </li>
                ))}
                {(m.horses_inactive ?? 0) > 0 && (
                  <li className="flex items-center justify-between py-2.5">
                    <span className="font-sans text-[12.5px] text-warm-grey">Inactive</span>
                    <span className="font-serif text-xl text-warm-grey numerals-editorial">{m.horses_inactive}</span>
                  </li>
                )}
              </ul>
            )}
          </Card>
        </motion.div>

        <motion.div {...fade}>
          <Card>
            <SectionHeader title="Membership Overview" hint="By current status" />
            {membershipQ.status === "loading" ? (
              <Skeleton className="h-[200px] w-full" />
            ) : membershipQ.status === "error" ? (
              <ErrorBox message={membershipQ.error} onRetry={membershipQ.reload} />
            ) : membershipTotal === 0 ? (
              <Empty icon={PieChart} detail="The status breakdown appears once members purchase a plan.">
                No membership data available
              </Empty>
            ) : (
              <Donut segments={statusSegments} centerValue={membershipTotal} centerLabel="MEMBERSHIPS" />
            )}
          </Card>
        </motion.div>
      </div>

      {/* Recent Admin Activity — sourced from audit_logs only, so labelled as
          admin activity rather than implying complete system activity (§44). */}
      <motion.div {...fade}>
        <Card>
          <SectionHeader title="Recent Admin Activity" hint="From the audit log — privileged actions only" />
          {!isAdmin ? (
            <Empty icon={ScrollText} detail="The audit log is restricted to admin accounts.">
              Visible to admins
            </Empty>
          ) : activityQ.status === "loading" ? (
            <RowSkeletons />
          ) : activityQ.status === "error" ? (
            <ErrorBox message={activityQ.error} onRetry={activityQ.reload} />
          ) : (activityQ.data ?? []).length === 0 ? (
            <Empty icon={ScrollText} detail="Privileged actions are recorded here as they happen.">
              No recent admin activity
            </Empty>
          ) : (
            <ActivityFeed rows={activityQ.data} />
          )}
        </Card>
      </motion.div>

      {/* Closing brand banner — decorative only, reuses the sidebar's own
          photo (no new asset) and links somewhere real rather than being a
          dead click target. */}
      <motion.a
        {...fade}
        href="/"
        className="group relative flex items-center justify-between overflow-hidden rounded-[22px] bg-deep-forest bg-cover bg-no-repeat bg-center px-6 py-6 sm:px-8"
        style={{
          backgroundImage: "linear-gradient(90deg, rgba(8,28,21,0.9), rgba(8,28,21,0.55)), url(/assests/sidebar.webp)",
        }}
      >
        <p className="font-serif text-xl text-warm-ivory sm:text-2xl">Every ride builds a stronger tomorrow.</p>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-antique-gold/40 text-champagne-gold transition-colors group-hover:bg-antique-gold/15">
          <ArrowRight size={16} strokeWidth={1.75} />
        </span>
      </motion.a>
    </div>
  );
}

/* ---------------- local components ---------------- */

function RangeSwitch({ value, onChange }) {
  return (
    <div className="inline-flex rounded-full border border-antique-gold/30 bg-white p-1" role="group" aria-label="Date range">
      {RANGES.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => onChange(r.key)}
          aria-pressed={value === r.key}
          className={`rounded-full px-3.5 py-1.5 font-sans text-xs tracking-[0.1em] uppercase transition-colors duration-200 ${
            value === r.key ? "bg-racing-green text-warm-ivory" : "text-warm-grey hover:text-charcoal"
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function Timeline({ rows }) {
  const sorted = [...rows].sort((a, b) => (a.start_time < b.start_time ? -1 : 1));
  return (
    <ol className="relative space-y-1 pl-5">
      <span className="absolute left-[6px] top-1 bottom-1 w-px bg-antique-gold/25" aria-hidden="true" />
      {sorted.map((s) => {
        const full = s.available_slots <= 0;
        return (
          <li key={s.session_id} className="relative flex items-center justify-between gap-4 rounded-[12px] px-3 py-3 transition-colors hover:bg-soft-cream/50">
            <span
              aria-hidden="true"
              className={`absolute -left-[13px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full border-2 border-white ${
                full ? "bg-destructive" : s.status === "open" ? "bg-racing-green" : "bg-warm-grey"
              }`}
            />
            <div>
              <p className="font-sans text-sm text-charcoal">
                {fmtTime(s.start_time)} – {fmtTime(s.end_time)}
              </p>
              <p className="mt-0.5 font-sans text-xs text-warm-grey">
                {s.booked_count} / {s.capacity} booked
              </p>
            </div>
            {full ? (
              <span className="font-sans text-[11px] tracking-[0.1em] text-destructive uppercase">Full</span>
            ) : (
              <StatusPill value={s.status} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ActivityFeed({ rows }) {
  return (
    <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {rows.map((a) => {
        const meta = ACTION_META[a.action];
        return (
          <li key={a.id} className="flex items-center gap-3">
            <IconChip icon={meta?.icon || ScrollText} tone={meta?.tone || "neutral"} size={34} />
            <div className="min-w-0">
              <p className="font-sans text-sm text-charcoal">{meta?.label || titleCase(a.action)}</p>
              <p className="truncate font-sans text-xs text-warm-grey">
                {a.actor?.full_name || a.actor?.email || "System"} · {relativeTime(a.created_at)}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function RowSkeletons() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}
