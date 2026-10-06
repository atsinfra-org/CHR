import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Card, IconChip, Skeleton } from "../ui";
import { Sparkline } from "./charts";

/**
 * Dashboard KPI card — the shared StatCard's visual language plus the two
 * things only the dashboard needs: a sparkline and a period comparison.
 *
 * `delta` renders ONLY when the caller passes one, and the caller passes one
 * only when a real comparable previous period has data (§21). `value` of
 * null renders "—" (unavailable), distinct from a real 0 (§20).
 */
export default function KpiCard({
  label,
  value,
  icon: Icon,
  tone = "neutral",
  delta = null,
  spark = null,
  sparkTone = "ink",
  loading = false,
}) {
  const up = delta && delta.pct >= 0;
  const unavailable = value === null || value === undefined;

  return (
    <Card className="flex flex-col justify-between">
      <div className="flex items-center gap-3">
        {Icon && <IconChip icon={Icon} tone={tone} />}
        <span className="font-sans text-[10.5px] tracking-[0.16em] text-warm-grey uppercase">{label}</span>
      </div>

      {loading ? (
        <Skeleton className="mt-4 h-9 w-24" />
      ) : (
        <p
          className={`mt-4 font-serif text-[2.1rem] leading-none numerals-editorial ${
            unavailable ? "text-warm-grey/45" : "text-charcoal"
          }`}
        >
          {unavailable ? "—" : value}
        </p>
      )}

      <div className="mt-3 flex min-h-[30px] items-end justify-between gap-2">
        {!loading && delta ? (
          <span className={`inline-flex items-center gap-1 font-sans text-xs ${up ? "text-racing-green" : "text-destructive"}`}>
            {up ? <ArrowUpRight size={13} strokeWidth={2} /> : <ArrowDownRight size={13} strokeWidth={2} />}
            {Math.abs(delta.pct).toFixed(1)}%<span className="text-warm-grey/80">{delta.label}</span>
          </span>
        ) : (
          <span className="font-sans text-xs text-warm-grey/70">{!loading && unavailable ? "Data unavailable" : ""}</span>
        )}
        {!loading && spark && spark.length >= 2 && <Sparkline values={spark} tone={sparkTone} width={104} height={30} />}
      </div>
    </Card>
  );
}
