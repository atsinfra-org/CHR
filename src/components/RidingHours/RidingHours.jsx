import { Sun, SunMoon } from "lucide-react";
import SectionLabel from "../ui/SectionLabel";
import { useRevealOnScroll, useStaggerReveal } from "../../animations/scrollAnimations";

const SEASONS = [
  {
    name: "Summer",
    slots: [
      { label: "Morning", time: "6:00 AM — 9:00 AM", icon: Sun },
      { label: "Evening", time: "4:00 PM — 6:00 PM", icon: SunMoon },
    ],
  },
  {
    name: "Winter",
    slots: [
      { label: "Morning", time: "7:00 AM — 10:00 AM", icon: Sun },
      { label: "Evening", time: "3:00 PM — 6:00 PM", icon: SunMoon },
    ],
  },
];

export default function RidingHours() {
  const headerRef = useRevealOnScroll({ y: 24 });
  const gridRef = useStaggerReveal({ y: 32, stagger: 0.15 });

  return (
    <section className="relative bg-warm-ivory py-24 md:py-36">
      <div className="mx-auto max-w-[1440px] px-6 md:px-10">
        <div ref={headerRef} className="mx-auto max-w-xl text-center">
          <SectionLabel className="justify-center">Riding Hours</SectionLabel>
          <h2 className="mt-6 font-serif text-4xl leading-tight text-charcoal sm:text-5xl md:text-6xl">
            Ride With the Seasons
          </h2>
        </div>

        <div ref={gridRef} className="mx-auto mt-16 grid max-w-4xl grid-cols-1 gap-14 md:mt-20 md:grid-cols-2 md:gap-0 md:divide-x md:divide-antique-gold/25">
          {SEASONS.map((season) => (
            <div key={season.name} className="px-0 text-center md:px-14">
              <span className="font-serif text-3xl italic text-racing-green md:text-4xl">{season.name}</span>
              <div className="mx-auto mt-6 h-px w-10 bg-antique-gold" />

              <div className="mt-8 space-y-6">
                {season.slots.map((slot) => (
                  <div key={slot.label} className="flex items-center justify-center gap-4">
                    <slot.icon size={16} strokeWidth={1.5} className="shrink-0 text-antique-gold" />
                    <div className="text-left">
                      <p className="font-sans text-[11px] uppercase tracking-[0.24em] text-warm-grey">
                        {slot.label}
                      </p>
                      <p className="mt-1 font-serif text-xl text-charcoal">{slot.time}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
