/**
 * A gentle diagonal seam between two sections — a quiet break from the
 * hard horizontal color bands elsewhere on the page. Used sparingly, at
 * the highest-impact transitions only.
 */
export default function SectionDivider({ from, to, flip = false, height = "h-16 md:h-28" }) {
  return (
    <div className={`relative w-full ${height}`} style={{ backgroundColor: from }} aria-hidden="true">
      <svg
        className="absolute inset-0 h-full w-full"
        preserveAspectRatio="none"
        viewBox="0 0 100 100"
      >
        <polygon points={flip ? "0,0 100,0 100,100 0,35" : "0,0 100,0 100,35 0,100"} fill={to} />
      </svg>
    </div>
  );
}
