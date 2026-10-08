import { useEffect } from "react";
import { gsap } from "../lib/gsap";

/**
 * gsap.context + ctx.revert() (rather than tl.kill()) is required here:
 * React 18 StrictMode mounts this effect, cleans it up, then mounts again,
 * all before first paint. gsap.from() applies its start values (opacity:0
 * etc.) synchronously on creation, and a plain kill() leaves those inline
 * styles stuck — the elements never recover on the second, persisting
 * mount. revert() removes every GSAP-applied style so the real mount
 * starts clean.
 */

/**
 * Hero page-load sequence: image reveal -> gold line -> headline lines ->
 * supporting copy -> CTAs. Mirrors the sequence specified for the hero
 * section and settles into a slow continuous image drift.
 */
export function useHeroIntro(refs) {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const { imageRef, overlayRef, goldLineRef, headlineLineRefs, subRef, ctaRef } = refs;

    if (reduced) {
      gsap.set(
        [imageRef.current, overlayRef.current, goldLineRef.current, subRef.current, ctaRef.current, ...(headlineLineRefs.current || [])],
        { clearProps: "all" }
      );
      return;
    }

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ delay: 0.1, defaults: { ease: "power3.out" } });

      tl.set(imageRef.current, { scale: 1.12, autoAlpha: 0 })
        .to(imageRef.current, { autoAlpha: 1, duration: 1.4 }, 0.1)
        .to(imageRef.current, { scale: 1, duration: 2.6, ease: "power2.out" }, 0.1)
        .fromTo(goldLineRef.current, { scaleX: 0 }, { scaleX: 1, duration: 0.8, transformOrigin: "left center" }, 0.6)
        .from(
          headlineLineRefs.current || [],
          { autoAlpha: 0, y: 34, duration: 1, stagger: 0.12 },
          0.85
        )
        .from(subRef.current, { autoAlpha: 0, y: 18, duration: 0.9 }, "-=0.5")
        .from(ctaRef.current, { autoAlpha: 0, y: 16, duration: 0.8 }, "-=0.5");

      // slow continuous drift after settle
      gsap.to(imageRef.current, {
        scale: 1.06,
        duration: 18,
        ease: "sine.inOut",
        repeat: -1,
        yoyo: true,
        delay: 2.5,
      });
    });

    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
