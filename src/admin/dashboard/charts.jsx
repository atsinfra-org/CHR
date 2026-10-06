import { useId, useMemo, useState } from "react";

/**
 * Hand-built SVG chart primitives for the admin dashboard. No charting
 * dependency is added — these are ~small, theme-aware, and render cleanly at
 * any width via a fixed viewBox + non-scaling strokes. Every one degrades to
 * a caller-supplied empty state when there is no data; none fabricates
 * points.
 *
 * Palette is the brand: racing-green / antique-gold on warm-ivory.
 */

const INK = "#12372a"; // racing-green
const GOLD = "#c6a15b"; // antique-gold
const GRID = "rgba(27,27,24,0.08)";
const AXIS = "#706d63"; // warm-grey

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

/* ------------------------------------------------------------------ */
/* Sparkline — inline micro-trend for KPI cards                        */
/* ------------------------------------------------------------------ */
export function Sparkline({ values = [], width = 120, height = 32, tone = "ink" }) {
  const stroke = tone === "gold" ? GOLD : INK;
  const pts = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (pts.length < 2) return <svg width={width} height={height} aria-hidden="true" />;

  const pad = 3; // keep the stroke + end dot inside the box
  const max = Math.max(...pts);
  const min = Math.min(...pts);
  const flat = max === min;
  const span = flat ? 1 : max - min;
  const stepX = width / (pts.length - 1);
  const yOf = (v) => (flat ? height / 2 : height - pad - ((v - min) / span) * (height - 2 * pad));
  const d = pts.map((v, i) => `${i === 0 ? "M" : "L"} ${(i * stepX).toFixed(2)} ${yOf(v).toFixed(2)}`).join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={flat ? 0.4 : 1}
      />
      <circle cx={(pts.length - 1) * stepX} cy={yOf(pts[pts.length - 1])} r="2" fill={stroke} opacity={flat ? 0.4 : 1} />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* AreaLineChart — one or two series, smooth area + hover readout      */
/* series: [{ key, label, tone, points: [{x:Date|string, y:number}] }] */
/* ------------------------------------------------------------------ */
export function AreaLineChart({ series = [], height = 220, formatX, formatY, yLabel }) {
  const gid = useId().replace(/:/g, "");
  const [hoverIdx, setHoverIdx] = useState(null);

  const W = 640;
  const H = height;
  const padL = 44;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const primary = series[0];
  const n = primary?.points?.length ?? 0;

  const yMax = useMemo(() => {
    const all = series.flatMap((s) => s.points.map((p) => p.y));
    return niceMax(Math.max(1, ...all));
  }, [series]);

  if (n < 2) return null;

  const xAt = (i) => padL + (i / (n - 1)) * plotW;
  const yAt = (v) => padT + plotH - (v / yMax) * plotH;

  const buildPath = (points) =>
    points.map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(p.y).toFixed(1)}`).join(" ");

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * yMax);
  const xTickEvery = Math.max(1, Math.ceil(n / 6));

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: H }}
        role="img"
        aria-label={yLabel || "Chart"}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(((x - padL) / plotW) * (n - 1));
          setHoverIdx(Math.min(n - 1, Math.max(0, i)));
        }}
        onPointerLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id={`area-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={INK} stopOpacity="0.16" />
            <stop offset="100%" stopColor={INK} stopOpacity="0" />
          </linearGradient>
        </defs>

        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={yAt(t)} y2={yAt(t)} stroke={GRID} strokeWidth="1" />
            <text x={padL - 8} y={yAt(t) + 3} textAnchor="end" fontSize="10" fill={AXIS} fontFamily="Manrope, sans-serif">
              {formatY ? formatY(t) : Math.round(t)}
            </text>
          </g>
        ))}

        {primary && (
          <path
            d={`${buildPath(primary.points)} L ${xAt(n - 1)} ${padT + plotH} L ${xAt(0)} ${padT + plotH} Z`}
            fill={`url(#area-${gid})`}
          />
        )}

        {series.map((s, si) => (
          <path
            key={s.key}
            d={buildPath(s.points)}
            fill="none"
            stroke={s.tone === "gold" ? GOLD : INK}
            strokeWidth={si === 0 ? 2 : 1.5}
            strokeDasharray={si === 0 ? "0" : "4 4"}
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {primary.points.map((p, i) =>
          i % xTickEvery === 0 || i === n - 1 ? (
            <text
              key={i}
              x={xAt(i)}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              fontSize="10"
              fill={AXIS}
              fontFamily="Manrope, sans-serif"
            >
              {formatX ? formatX(p.x, i) : i}
            </text>
          ) : null
        )}

        {hoverIdx != null && (
          <g>
            <line x1={xAt(hoverIdx)} x2={xAt(hoverIdx)} y1={padT} y2={padT + plotH} stroke={AXIS} strokeWidth="1" strokeDasharray="3 3" />
            {series.map((s) => (
              <circle key={s.key} cx={xAt(hoverIdx)} cy={yAt(s.points[hoverIdx].y)} r="3.5" fill={s.tone === "gold" ? GOLD : INK} stroke="#fff" strokeWidth="1.5" />
            ))}
          </g>
        )}
      </svg>

      {hoverIdx != null && primary && (
        <div className="pointer-events-none absolute left-0 top-0 flex w-full justify-center">
          <div className="mt-1 rounded-md border border-charcoal/10 bg-white px-3 py-1.5 text-center shadow-sm">
            <p className="font-sans text-[11px] tracking-[0.06em] text-warm-grey uppercase">
              {formatX ? formatX(primary.points[hoverIdx].x, hoverIdx) : hoverIdx}
            </p>
            {series.map((s) => (
              <p key={s.key} className="font-sans text-sm text-charcoal">
                <span className="text-warm-grey">{s.label}: </span>
                {formatY ? formatY(s.points[hoverIdx].y) : s.points[hoverIdx].y}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* BarChart — vertical bars with hover highlight                       */
/* bars: [{ label, value, sub? }]                                      */
/* ------------------------------------------------------------------ */
export function BarChart({ bars = [], height = 200, formatY, tone = "ink" }) {
  const [hover, setHover] = useState(null);
  const W = 640;
  const H = height;
  const padL = 44;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const fill = tone === "gold" ? GOLD : INK;

  const yMax = niceMax(Math.max(1, ...bars.map((b) => b.value)));
  if (bars.length === 0) return null;

  const slot = plotW / bars.length;
  const bw = Math.min(46, slot * 0.6);
  const ticks = [0, 0.5, 1].map((t) => t * yMax);

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: H }}
        role="img"
        aria-label="Bar chart"
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={padT + plotH - (t / yMax) * plotH} y2={padT + plotH - (t / yMax) * plotH} stroke={GRID} />
            <text x={padL - 8} y={padT + plotH - (t / yMax) * plotH + 3} textAnchor="end" fontSize="10" fill={AXIS} fontFamily="Manrope, sans-serif">
              {formatY ? formatY(t) : Math.round(t)}
            </text>
          </g>
        ))}
        {bars.map((b, i) => {
          const h = (b.value / yMax) * plotH;
          const x = padL + i * slot + (slot - bw) / 2;
          const y = padT + plotH - h;
          return (
            <g key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <rect x={padL + i * slot} y={padT} width={slot} height={plotH} fill="transparent" />
              <rect
                x={x}
                y={b.value > 0 ? y : padT + plotH - 2}
                width={bw}
                height={b.value > 0 ? h : 2}
                rx="3"
                fill={fill}
                opacity={hover == null || hover === i ? 0.9 : 0.35}
                style={{ transition: "opacity .15s" }}
              />
              <text x={padL + i * slot + slot / 2} y={H - 10} textAnchor="middle" fontSize="10" fill={AXIS} fontFamily="Manrope, sans-serif">
                {b.label}
              </text>
            </g>
          );
        })}
      </svg>
      {hover != null && (
        <div className="pointer-events-none absolute left-0 top-0 flex w-full justify-center">
          <div className="mt-1 rounded-md border border-charcoal/10 bg-white px-3 py-1.5 text-center shadow-sm">
            <p className="font-sans text-[11px] tracking-[0.06em] text-warm-grey uppercase">{bars[hover].label}</p>
            <p className="font-sans text-sm text-charcoal">{formatY ? formatY(bars[hover].value) : bars[hover].value}</p>
            {bars[hover].sub && <p className="font-sans text-xs text-warm-grey">{bars[hover].sub}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Donut — status/plan breakdown                                       */
/* segments: [{ label, value, color }]                                 */
/* ------------------------------------------------------------------ */
export function Donut({ segments = [], size = 168, thickness = 20, centerValue, centerLabel }) {
  const [hover, setHover] = useState(null);
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(27,27,24,0.06)" strokeWidth={thickness} />
          {total > 0 &&
            segments.map((seg, i) => {
              const len = (seg.value / total) * c;
              const el = (
                <circle
                  key={i}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={thickness}
                  strokeDasharray={`${len} ${c - len}`}
                  strokeDashoffset={-offset}
                  opacity={hover == null || hover === i ? 1 : 0.35}
                  style={{ transition: "opacity .15s" }}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                />
              );
              offset += len;
              return el;
            })}
        </g>
        <text x="50%" y="46%" textAnchor="middle" fontSize="24" fill={INK} fontFamily="Cormorant Garamond, serif" fontWeight="600">
          {centerValue}
        </text>
        <text x="50%" y="60%" textAnchor="middle" fontSize="10" fill={AXIS} fontFamily="Manrope, sans-serif" letterSpacing="1">
          {centerLabel}
        </text>
      </svg>

      <ul className="w-full space-y-1.5">
        {segments.map((seg, i) => (
          <li
            key={i}
            className="flex items-center justify-between gap-3 rounded-md px-2 py-1 transition-colors"
            style={{ background: hover === i ? "rgba(27,27,24,0.04)" : "transparent" }}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
          >
            <span className="flex items-center gap-2 font-sans text-sm text-charcoal">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: seg.color }} />
              {seg.label}
            </span>
            <span className="font-sans text-sm text-warm-grey">{seg.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
