import SectionLabel from "../ui/SectionLabel";
import GoldDivider from "../ui/GoldDivider";
import Button from "../ui/Button";
import { useRevealOnScroll, useStaggerReveal } from "../../animations/scrollAnimations";
import { useEnquiryModal } from "../../context/EnquiryModalContext";

const PROGRAMS = [
  {
    id: "01",
    title: "Junior Riding",
    age: "Under 12 Years",
    price: "₹12,000",
    period: "/ Month",
    includes: "8 Riding Classes Monthly",
  },
  {
    id: "02",
    title: "Adult Riding",
    age: "Above 12 Years",
    price: "₹16,000",
    period: "/ Month",
    includes: "8 Riding Classes Monthly",
  },
];

export default function RidingPrograms() {
  const { openEnquiry } = useEnquiryModal();
  const headerRef = useRevealOnScroll({ y: 24 });
  const gridRef = useStaggerReveal({ y: 36, stagger: 0.15 });

  return (
    <section id="riding" className="relative bg-soft-cream py-24 md:py-36">
      <div className="mx-auto max-w-[1440px] px-6 md:px-10">
        <div ref={headerRef} className="max-w-xl">
          <SectionLabel>Riding Programs</SectionLabel>
          <h2 className="mt-6 font-serif text-4xl leading-tight text-charcoal sm:text-5xl md:text-6xl">
            Find Your Place in the Saddle.
          </h2>
        </div>

        <div ref={gridRef} className="mt-16 grid grid-cols-1 gap-px bg-charcoal/10 md:mt-20 md:grid-cols-2">
          {PROGRAMS.map((program) => (
            <div key={program.id} className="flex flex-col justify-between bg-soft-cream p-10 md:p-14">
              <div>
                <span className="font-sans text-xs tracking-[0.32em] text-antique-gold">
                  PROGRAM {program.id}
                </span>
                <h3 className="mt-4 font-serif text-3xl text-charcoal md:text-4xl">{program.title}</h3>
                <p className="mt-2 font-sans text-sm tracking-wide text-warm-grey">{program.age}</p>

                <GoldDivider className="my-8" width="w-12" />

                <div className="flex items-baseline gap-2">
                  <span className="numerals-editorial font-serif text-5xl text-racing-green md:text-6xl">
                    {program.price}
                  </span>
                  <span className="font-sans text-sm text-warm-grey">{program.period}</span>
                </div>

                <p className="mt-4 font-sans text-sm uppercase tracking-[0.14em] text-charcoal/70">
                  {program.includes}
                </p>
              </div>

              <div className="mt-12">
                <Button
                  onClick={() => openEnquiry(program.title)}
                  variant="link"
                  className="text-charcoal hover:text-racing-green"
                >
                  Enquire Now
                </Button>
              </div>
            </div>
          ))}
        </div>

        <p className="mt-10 max-w-2xl font-sans text-sm font-light leading-relaxed text-warm-grey">
          Each program is a monthly riding package. Riders are welcome to continue their journey across multiple
          months as they build skill and confidence in the saddle.
        </p>
      </div>
    </section>
  );
}
