import ImagePlaceholder from "../ui/ImagePlaceholder";
import Button from "../ui/Button";
import GoldDivider from "../ui/GoldDivider";
import { useRevealOnScroll } from "../../animations/scrollAnimations";
import { useEnquiryModal } from "../../context/EnquiryModalContext";

export default function FinalCTA() {
  const { openEnquiry } = useEnquiryModal();
  const ref = useRevealOnScroll({ y: 28 });

  return (
    <section id="contact" className="relative flex min-h-[70vh] items-center overflow-hidden bg-deep-forest py-28">
      <div className="absolute inset-0">
        <ImagePlaceholder label="Rider at Dusk" tone="dark" className="h-full w-full opacity-60" />
      </div>
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: "linear-gradient(180deg, rgba(8,28,21,0.85) 0%, rgba(8,28,21,0.65) 50%, rgba(8,28,21,0.92) 100%)",
        }}
      />

      <div ref={ref} className="relative z-10 mx-auto max-w-2xl px-6 text-center md:px-10">
        <GoldDivider className="mx-auto" />
        <h2 className="mt-8 font-serif text-4xl leading-tight text-warm-ivory sm:text-5xl md:text-6xl">
          Your riding journey starts here.
        </h2>
        <p className="mx-auto mt-6 max-w-md font-sans text-base font-light leading-relaxed text-warm-ivory/70">
          Discover the experience of horse riding at Colonel Horse Riding.
        </p>

        <div className="mt-10 flex flex-col items-center gap-6">
          <Button onClick={() => openEnquiry()} variant="gold">
            Enquire Now
          </Button>
          <Button href="#riding" variant="link" className="text-warm-ivory/70 hover:text-antique-gold" showArrow={false}>
            See riding programmes
          </Button>
        </div>
      </div>
    </section>
  );
}
