import GoldDivider from "../ui/GoldDivider";
import { useRevealOnScroll } from "../../animations/scrollAnimations";

export default function AboutSection() {
  const ref = useRevealOnScroll({ y: 24 });

  return (
    <section id="about" className="relative bg-warm-ivory py-24 md:py-32">
      <div ref={ref} className="mx-auto max-w-2xl px-6 text-center md:px-10">
        <p className="font-sans text-xs tracking-[0.32em] text-antique-gold uppercase">Colonel Horse Riding</p>
        <h2 className="mt-5 font-serif text-3xl leading-tight text-charcoal sm:text-4xl md:text-5xl">
          A Place to Learn. Ride. Grow.
        </h2>
        <GoldDivider className="mx-auto my-8" />
        <p className="mx-auto max-w-md font-sans text-base font-light leading-relaxed text-warm-grey">
          Colonel Horse Riding is a home for riders learning to move with horses — building skill, discipline
          and connection, one class at a time.
        </p>
      </div>
    </section>
  );
}
