import { useEffect } from "react";
import Lenis from "lenis";
import { gsap, ScrollTrigger } from "./gsap";

/**
 * Buttery inertial scroll, wired into GSAP's ticker so ScrollTrigger stays
 * in sync (autoRaf disabled — Lenis is driven by gsap.ticker instead of its
 * own rAF loop, which is the supported way to combine the two).
 * `respectReducedMotion` lets Lenis fall back to native scroll on its own
 * for users who've asked for less motion.
 */
export function useSmoothScroll() {
  useEffect(() => {
    const lenis = new Lenis({
      autoRaf: false,
      respectReducedMotion: true,
      duration: 1.1,
      easing: (t) => 1 - Math.pow(1 - t, 3),
      anchors: { offset: -90 },
    });

    // index.html forces native scroll to 0 on refresh, but Lenis tracks its
    // own scroll position separately — without this it can stay convinced
    // it's wherever the page was before reload, desyncing from what's on
    // screen (and from ScrollTrigger) the moment the user first scrolls.
    lenis.scrollTo(0, { immediate: true, force: true });

    lenis.on("scroll", ScrollTrigger.update);

    const tick = (time) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    return () => {
      gsap.ticker.remove(tick);
      lenis.destroy();
    };
  }, []);
}
