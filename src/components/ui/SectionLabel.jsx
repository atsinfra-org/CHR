/** Small section eyebrow, set as an italic serif in sentence case (not tracked caps). */
export default function SectionLabel({ children, tone = "dark", className = "" }) {
  const color = tone === "light" ? "text-champagne-gold" : "text-[#8a6a33]";
  return <p className={`font-serif text-lg italic ${color} ${className}`}>{children}</p>;
}
