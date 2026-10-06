import SectionLabel from "../ui/SectionLabel";
import { useRevealOnScroll, useImageReveal } from "../../animations/scrollAnimations";

export default function IntroSection() {
  const textRef = useRevealOnScroll({ y: 32 });
  const imageRef = useImageReveal();

  return (
    <section className="relative bg-warm-ivory py-24 md:py-36">
      <div className="mx-auto grid max-w-[1440px] grid-cols-1 items-center gap-14 px-6 md:grid-cols-12 md:gap-8 md:px-10">
        <div ref={textRef} className="md:col-span-5 md:col-start-1">
          <SectionLabel>The Riding Experience</SectionLabel>
          <h2 className="mt-6 font-serif text-4xl leading-tight text-charcoal sm:text-5xl md:text-6xl">
            A Journey Measured One Ride at a Time.
          </h2>
          <p className="mt-6 max-w-md font-sans text-base font-light leading-relaxed text-warm-grey">
            Whether beginning your first ride or developing your confidence in the saddle, Colonel Horse Riding
            provides a structured environment to experience the discipline and joy of horse riding.
          </p>
        </div>

        <div className="md:col-span-6 md:col-start-7">
          <div
            ref={imageRef}
            data-cursor="view"
            className="group aspect-[4/5] w-full overflow-hidden md:aspect-[3/4]"
          >
            <img
              src="/hero.png"
              alt="Rider and horse cantering in a sunlit riding arena at Colonel Horse Riding"
              className="h-full w-full object-cover transition-transform duration-[1400ms] ease-out group-hover:scale-[1.05]"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
