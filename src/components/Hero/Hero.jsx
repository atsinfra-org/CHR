import { useEffect, useRef } from "react";
import Button from "../ui/Button";
import { useHeroIntro } from "../../animations/heroAnimations";
import { gsap } from "../../lib/gsap";
import { useEnquiryModal } from "../../context/EnquiryModalContext";

const HEADLINE_LINES = ["THE ART", "OF HORSE", "RIDING"];

export default function Hero() {
  const { openEnquiry } = useEnquiryModal();
  const imageRef = useRef(null);
  const overlayRef = useRef(null);
  const goldLineRef = useRef(null);
  const headlineLineRefs = useRef([]);
  const subRef = useRef(null);
  const ctaRef = useRef(null);
  const sectionRef = useRef(null);

  useHeroIntro({ imageRef, overlayRef, goldLineRef, headlineLineRefs, subRef, ctaRef });

  // Subtle mouse-driven parallax on desktop only — disabled for touch/reduced motion.
  useEffect(() => {
    const isTouch = window.matchMedia("(pointer: coarse)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (isTouch || reduced) return;

    const section = sectionRef.current;
    const image = imageRef.current;
    if (!section || !image) return;

    const quickX = gsap.quickTo(image, "xPercent", { duration: 1.2, ease: "power3.out" });
    const quickY = gsap.quickTo(image, "yPercent", { duration: 1.2, ease: "power3.out" });

    const onMove = (e) => {
      const rect = section.getBoundingClientRect();
      const relX = (e.clientX - rect.left) / rect.width - 0.5;
      const relY = (e.clientY - rect.top) / rect.height - 0.5;
      quickX(relX * -1.5);
      quickY(relY * -1.5);
    };

    section.addEventListener("mousemove", onMove);
    return () => section.removeEventListener("mousemove", onMove);
  }, []);

  return (
    <section
      id="home"
      ref={sectionRef}
      className="relative flex h-[100svh] min-h-[640px] w-full items-end overflow-hidden bg-deep-forest"
    >
      <div ref={imageRef} data-cursor="view" className="absolute inset-0 will-change-transform">
        <img
          src="/hero 1.png"
          alt="Rider and horse cantering in a sunlit riding arena at Colonel Horse Riding"
          className="h-full w-full object-cover"
        />
      </div>

      <div
        ref={overlayRef}
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(8,28,21,0.55) 0%, rgba(8,28,21,0.35) 38%, rgba(8,28,21,0.75) 82%, rgba(8,28,21,0.92) 100%)",
        }}
      />

      <div className="relative z-10 mx-auto w-full max-w-[1440px] px-6 pb-10 md:px-10 md:pb-14 lg:pb-16">
        <div ref={goldLineRef} className="mb-6 h-px w-16 origin-left bg-antique-gold" />


        <h1 className="font-serif text-6xl leading-[0.98] text-warm-ivory sm:text-7xl md:text-8xl lg:text-[7.5rem]">
          {HEADLINE_LINES.map((line, i) => (
            <span key={line} className="block overflow-hidden">
              <span ref={(el) => (headlineLineRefs.current[i] = el)} className="block">
                {line}
              </span>
            </span>
          ))}
        </h1>

        <p ref={subRef} className="mt-7 max-w-md font-sans text-base font-light leading-relaxed text-warm-ivory/80 md:text-lg">
          Discover the discipline, confidence and connection that make horse riding an experience unlike any other.
        </p>

        <div ref={ctaRef} className="mt-10 flex flex-wrap items-center gap-5">
          <Button href="#riding" variant="solid">
            Explore Riding
          </Button>
          <Button onClick={() => openEnquiry()} variant="outline">
            Enquire Now
          </Button>
        </div>
      </div>
    </section>
  );
}
