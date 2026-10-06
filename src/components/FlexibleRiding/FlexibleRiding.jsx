import GoldDivider from "../ui/GoldDivider";
import { useRevealOnScroll } from "../../animations/scrollAnimations";

export default function FlexibleRiding() {
  const ref = useRevealOnScroll({ y: 24 });

  return (
    <section className="relative bg-racing-green py-24 md:py-32">
      <div ref={ref} className="mx-auto max-w-2xl px-6 text-center md:px-10">
        <GoldDivider className="mx-auto" />
        <h2 className="mt-8 font-serif text-4xl leading-tight text-warm-ivory sm:text-5xl">
          Ride at Your Pace
        </h2>
        <p className="mx-auto mt-6 max-w-lg font-sans text-base font-light leading-relaxed text-warm-ivory/75">
          Each monthly program includes eight riding classes, with scheduling designed to provide flexibility
          throughout the month.
        </p>
      </div>
    </section>
  );
}
