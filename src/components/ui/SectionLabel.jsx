export default function SectionLabel({ children, tone = "dark", className = "" }) {
  const color = tone === "light" ? "text-champagne-gold" : "text-racing-green";
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <span className="h-px w-8 bg-antique-gold" />
      <span className={`font-sans text-xs tracking-[0.32em] uppercase ${color}`}>{children}</span>
    </div>
  );
}
