import SectionLabel from "../ui/SectionLabel";
import HorseMark from "../ui/HorseMark";
import { useRevealOnScroll, useImageReveal } from "../../animations/scrollAnimations";

export default function CertificateSection() {
  const textRef = useRevealOnScroll({ y: 28 });
  const certRef = useImageReveal();

  return (
    <section className="relative overflow-hidden bg-deep-forest pt-16 pb-24 md:pt-24 md:pb-36">
      <div className="mx-auto grid max-w-[1440px] grid-cols-1 items-center gap-16 px-6 md:grid-cols-12 md:px-10">
        <div ref={textRef} className="md:col-span-5">
          <SectionLabel tone="light">Certification</SectionLabel>
          <h2 className="mt-4 font-serif text-4xl leading-tight text-warm-ivory sm:text-5xl md:text-6xl">
            Recognising your progress
          </h2>
          <p className="mt-6 max-w-md font-sans text-base font-light leading-relaxed text-warm-ivory/70">
            Riders completing the applicable riding program may receive a certificate recognising their
            achievement.
          </p>
        </div>

        <div className="md:col-span-6 md:col-start-7">
          <div ref={certRef} className="group mx-auto w-full max-w-md">
            <div className="relative aspect-[7/5] w-full border border-antique-gold/50 bg-gradient-to-br from-[#0e2e22] to-[#081c15] p-3 transition-all duration-500 ease-out group-hover:-translate-y-1.5 group-hover:border-antique-gold group-hover:shadow-[0_20px_60px_-15px_rgba(198,161,91,0.35)]">
              <div className="flex h-full w-full flex-col items-center justify-center gap-4 border border-antique-gold/30 px-8 text-center">
                <HorseMark className="h-9 w-9 text-antique-gold/70" />
                <div className="h-px w-14 bg-antique-gold/60" />
                <p className="font-sans text-[10px] tracking-[0.32em] text-champagne-gold/80 uppercase">
                  Certificate of Recognition
                </p>
                <p className="font-serif text-lg italic text-warm-ivory/50">Colonel Horse Riding</p>
                <div className="mt-2 h-px w-24 bg-warm-ivory/15" />
                <p className="font-sans text-[9px] tracking-[0.2em] text-warm-ivory/35 uppercase">
                  Sample Placeholder
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
