import HorseMark from "./HorseMark";

/**
 * Elegant, on-brand placeholder standing in for real equestrian photography.
 * Designed to be swapped for a genuine <img>/<video> without layout changes —
 * every consumer just replaces this component with the final asset.
 */
export default function ImagePlaceholder({ label, tone = "dark", className = "" }) {
  const isDark = tone === "dark";

  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={{
        background: isDark
          ? "linear-gradient(150deg, #12372a 0%, #081c15 62%, #0a1f18 100%)"
          : "linear-gradient(150deg, #ede7d8 0%, #dfd6bd 100%)",
      }}
    >
      {/* fine grain */}
      <div
        className="absolute inset-0 opacity-[0.12] mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
      {/* hairline frame */}
      <div className="absolute inset-4 border border-antique-gold/25 pointer-events-none" />

      <div className="relative z-10 flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center">
        <HorseMark className={`h-10 w-10 md:h-12 md:w-12 ${isDark ? "text-antique-gold/60" : "text-racing-green/50"}`} />
        {label && (
          <p
            className={`font-sans text-[10px] md:text-xs tracking-[0.28em] uppercase ${
              isDark ? "text-warm-ivory/45" : "text-charcoal/40"
            }`}
          >
            {label}
          </p>
        )}
      </div>
    </div>
  );
}
