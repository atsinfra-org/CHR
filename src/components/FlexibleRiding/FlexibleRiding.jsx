import GoldDivider from "../ui/GoldDivider";
import { useRevealOnScroll } from "../../animations/scrollAnimations";

export default function FlexibleRiding() {
  const ref = useRevealOnScroll({ y: 24 });

  return (
    <section className="relative bg-deep-forest pt-24 pb-4 md:pt-32 md:pb-8">
      <div ref={ref} className="mx-auto max-w-2xl px-6 text-center md:px-10">
        <GoldDivider className="mx-auto" />
        <h2 className="mt-8 font-serif text-4xl leading-tight text-warm-ivory sm:text-5xl">
          Ride at your pace
        </h2>
        <p className="mx-auto mt-6 max-w-lg font-sans text-base font-light leading-relaxed text-warm-ivory/75">
          Choose the sessions that suit you — early mornings or evenings, Tuesday to Sunday — and book them
          yourself online, whenever it fits your week.
        </p>
      </div>
    </section>
  );
}
