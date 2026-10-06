import { useEffect, useRef, useState } from "react";
import { gsap } from "../../lib/gsap";

/**
 * First-impression curtain: a gold hairline draws itself on a deep-forest
 * panel, then the panel wipes up and out — timed to overlap the tail of the
 * wipe with the hero's own image fade-in (see heroAnimations.js's initial
 * delay) so the reveal feels continuous rather than a hard cut.
 */
export default function LoadCurtain() {
  const panelRef = useRef(null);
  const lineRef = useRef(null);
  const [mounted, setMounted] = useState(true);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const tl = gsap.timeline({ onComplete: () => setMounted(false) });
      tl.to(panel, { autoAlpha: 0, duration: 0.2, delay: 0.05 });
      return () => tl.kill();
    }

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ onComplete: () => setMounted(false) });
      tl.fromTo(
        lineRef.current,
        { scaleX: 0 },
        { scaleX: 1, duration: 0.5, ease: "power2.inOut", transformOrigin: "center" }
      ).to(panel, { yPercent: -100, duration: 0.7, ease: "power4.inOut" }, "+=0.15");
    });

    return () => ctx.revert();
  }, []);

  if (!mounted) return null;

  return (
    <div
      ref={panelRef}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-deep-forest"
      aria-hidden="true"
    >
      <div ref={lineRef} className="h-px w-24 origin-center bg-antique-gold" />
    </div>
  );
}
