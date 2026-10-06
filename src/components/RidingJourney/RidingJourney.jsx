import { useEffect, useRef } from "react";
import SectionLabel from "../ui/SectionLabel";
import { useRevealOnScroll } from "../../animations/scrollAnimations";
import { gsap, ScrollTrigger } from "../../lib/gsap";

const STAGES = [
  { label: "Begin", copy: "Build the fundamentals." },
  { label: "Develop", copy: "Strengthen balance, confidence and control." },
  { label: "Progress", copy: "Refine technique through continued practice." },
  { label: "Achieve", copy: "Continue progressing toward your riding goals." },
];

export default function RidingJourney() {
  const headerRef = useRevealOnScroll({ y: 24 });
  const sectionRef = useRef(null);
  const stagesRowRef = useRef(null);
  const progressFillRef = useRef(null);
  const stageRefs = useRef([]);

  useEffect(() => {
    const section = sectionRef.current;
    const stages = stageRefs.current;
    if (!section || !stages.length) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    const ctx = gsap.context(() => {
      // Desktop: the section pins while scroll scrubs the progress line and
      // sequentially brightens each stage — the "journey" plays out with the
      // scroll itself rather than just fading in. Mobile keeps a plain,
      // non-pinned reveal (pinning is a common source of jank on mobile
      // browsers, and the brief calls for simpler mobile motion anyway).
      ScrollTrigger.matchMedia({
        "(min-width: 768px)": () => {
          gsap.set(stages, { opacity: 0.35, scale: 0.92 });
          gsap.set(progressFillRef.current, { scaleX: 0 });

          const tl = gsap.timeline({
            scrollTrigger: {
              trigger: section,
              start: "top top",
              end: "+=140%",
              scrub: 0.6,
              pin: true,
              anticipatePin: 1,
            },
          });

          tl.to(progressFillRef.current, { scaleX: 1, ease: "none", duration: 4 }, 0);
          stages.forEach((el, i) => {
            tl.to(el, { opacity: 1, scale: 1, duration: 0.8 }, i);
          });
        },

        "(max-width: 767px)": () => {
          gsap.set(progressFillRef.current, { scaleX: 1 });
          gsap.fromTo(
            stages,
            { autoAlpha: 0, y: 24 },
            {
              autoAlpha: 1,
              y: 0,
              duration: 0.8,
              stagger: 0.14,
              ease: "power3.out",
              scrollTrigger: { trigger: stagesRowRef.current, start: "top 78%" },
            }
          );
        },
      });
    }, section);

    return () => ctx.revert();
  }, []);

  return (
    <section ref={sectionRef} className="relative flex min-h-screen items-center bg-soft-cream py-24 md:py-0">
      <div className="mx-auto w-full max-w-[1440px] px-6 md:px-10">
        <div ref={headerRef} className="mx-auto max-w-xl text-center">
          <SectionLabel className="justify-center">The Riding Journey</SectionLabel>
          <h2 className="mt-6 font-serif text-4xl leading-tight text-charcoal sm:text-5xl md:text-6xl">
            More Than a Ride. A Journey.
          </h2>
          <p className="mx-auto mt-6 max-w-lg font-sans text-base font-light leading-relaxed text-warm-grey">
            Horse riding is built through consistency, patience and practice. Every class develops a deeper
            understanding between rider, horse and movement.
          </p>
        </div>

        <div
          ref={stagesRowRef}
          className="relative mx-auto mt-20 grid max-w-5xl grid-cols-1 gap-12 md:grid-cols-4 md:gap-8"
        >
          <div className="pointer-events-none absolute left-0 right-0 top-[10px] hidden h-px bg-antique-gold/20 md:block">
            <div ref={progressFillRef} className="h-full origin-left bg-antique-gold" />
          </div>

          {STAGES.map((stage, i) => (
            <div
              key={stage.label}
              ref={(el) => (stageRefs.current[i] = el)}
              className="relative flex flex-col items-center text-center md:items-center"
            >
              <div className="relative z-10 flex h-5 w-5 items-center justify-center">
                <span className="h-2 w-2 rounded-full bg-antique-gold" />
              </div>
              <span className="mt-6 font-sans text-[11px] tracking-[0.28em] text-antique-gold">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-3 font-serif text-2xl text-charcoal md:text-3xl">{stage.label}</h3>
              <p className="mt-3 max-w-[200px] font-sans text-sm font-light leading-relaxed text-warm-grey">
                {stage.copy}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
