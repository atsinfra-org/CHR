import { useEffect, useRef, useState } from "react";
import { gsap } from "../../lib/gsap";
import { useEnquiryModal } from "../../context/EnquiryModalContext";

function canUseCustomCursor() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(pointer: fine)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Desktop-only custom cursor: a tight dot plus a looser trailing ring that
 * expands and labels itself against elements carrying `data-cursor`
 * ("view" | "explore" | "link"). Never touches mobile/touch input, and
 * mix-blend-mode keeps it legible over both the dark and ivory sections
 * without per-section color logic.
 *
 * Yields to the native cursor entirely whenever a modal is open — an
 * opaque panel (e.g. EnquiryModal, z-[110]) sits above the dot/ring
 * (z-[90]), so they'd render invisibly underneath it anyway, and inputs
 * need their native text-caret affordance back, which `cursor: none`
 * would otherwise strip.
 */
export default function Cursor() {
  const dotRef = useRef(null);
  const ringRef = useRef(null);
  // Resolved synchronously (this is a client-only SPA, `window` is always
  // present) so the dot/ring elements already exist in the DOM by the time
  // the effect below runs — quickTo-ing a ref that mounts only after this
  // state flips would otherwise silently target `null`.
  const [active] = useState(canUseCustomCursor);
  const [label, setLabel] = useState(null);
  const { isOpen: modalOpen } = useEnquiryModal();

  useEffect(() => {
    if (!active) return;

    const dot = dotRef.current;
    const ring = ringRef.current;
    // React 18/19 StrictMode's dev-only mount→cleanup→mount cycle can run
    // this effect once before refs are (re)attached — mirrors the guard
    // already used in useMagnetic/Hero's parallax effect.
    if (!dot || !ring) return;

    // Centering via xPercent/yPercent (GSAP-managed) rather than a Tailwind
    // translate class — GSAP's quickTo(x/y) below fully owns the `transform`
    // inline style, and would silently drop a class-based translate.
    gsap.set([dot, ring], { xPercent: -50, yPercent: -50 });

    const quickDotX = gsap.quickTo(dot, "x", { duration: 0.12, ease: "power3.out" });
    const quickDotY = gsap.quickTo(dot, "y", { duration: 0.12, ease: "power3.out" });
    const quickRingX = gsap.quickTo(ring, "x", { duration: 0.35, ease: "power3.out" });
    const quickRingY = gsap.quickTo(ring, "y", { duration: 0.35, ease: "power3.out" });

    const onMove = (e) => {
      quickDotX(e.clientX);
      quickDotY(e.clientY);
      quickRingX(e.clientX);
      quickRingY(e.clientY);
    };

    const onOver = (e) => {
      const target = e.target.closest?.("[data-cursor]");
      if (!target) return;
      const kind = target.getAttribute("data-cursor");
      setLabel(kind === "view" ? "View" : kind === "explore" ? "Explore" : null);
    };

    const onOut = (e) => {
      const target = e.target.closest?.("[data-cursor]");
      if (!target) return;
      if (!e.relatedTarget || !e.relatedTarget.closest?.("[data-cursor]")) {
        setLabel(null);
      }
    };

    window.addEventListener("mousemove", onMove);
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);

    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
    };
  }, [active]);

  // Kept separate from the listener-setup effect above so opening/closing
  // a modal doesn't tear down and rebuild the mousemove tracking — it just
  // toggles visibility and hands the native cursor back.
  useEffect(() => {
    if (!active) return;
    document.documentElement.classList.toggle("custom-cursor-active", !modalOpen);
    return () => document.documentElement.classList.remove("custom-cursor-active");
  }, [active, modalOpen]);

  if (!active) return null;

  // Hidden via opacity rather than unmounted while a modal is open — the
  // dot/ring nodes need to stay put so the quickTo bindings set up above
  // (tied only to `active`) never go stale against a remounted element.
  const hidden = modalOpen;

  return (
    <>
      <div
        ref={dotRef}
        className={`pointer-events-none fixed left-0 top-0 z-[90] h-1.5 w-1.5 rounded-full bg-antique-gold mix-blend-difference transition-opacity duration-150 ${
          hidden ? "opacity-0" : "opacity-100"
        }`}
      />
      <div
        ref={ringRef}
        className={`pointer-events-none fixed left-0 top-0 z-[90] flex items-center justify-center rounded-full border border-antique-gold mix-blend-difference transition-[width,height,opacity] duration-300 ease-out ${
          label ? "h-16 w-16" : "h-9 w-9"
        } ${hidden ? "opacity-0" : "opacity-100"}`}
      >
        {label && (
          <span className="font-sans text-[10px] tracking-[0.18em] text-antique-gold uppercase">{label}</span>
        )}
      </div>
    </>
  );
}
