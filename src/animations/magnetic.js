import { useEffect } from "react";
import { gsap } from "../lib/gsap";

/**
 * Subtle magnetic pull toward the cursor within a button's own bounds —
 * desktop, fine-pointer only. Capped low (see `strength`) so it reads as a
 * refined detail rather than the exaggerated "chasing" effect the brief
 * explicitly warns against.
 */
export function useMagnetic(ref, strength = 0.25) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const isFine = window.matchMedia("(pointer: fine)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!isFine || reduced) return;

    const quickX = gsap.quickTo(el, "x", { duration: 0.4, ease: "power3.out" });
    const quickY = gsap.quickTo(el, "y", { duration: 0.4, ease: "power3.out" });

    const onMove = (e) => {
      const rect = el.getBoundingClientRect();
      quickX((e.clientX - rect.left - rect.width / 2) * strength);
      quickY((e.clientY - rect.top - rect.height / 2) * strength);
    };

    const onLeave = () => {
      quickX(0);
      quickY(0);
    };

    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [ref, strength]);
}
