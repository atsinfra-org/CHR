import SectionLabel from "../ui/SectionLabel";
import Button from "../ui/Button";
import { useRevealOnScroll } from "../../animations/scrollAnimations";
import { useEnquiryModal } from "../../context/EnquiryModalContext";

/**
 * Practical information: what to wear, who can ride, how booking works and
 * how to find the yard.
 *
 * The booking rules below mirror the live system settings (Admin → Settings):
 * keep these two numbers in step if they are changed there.
 *
 * VENUE: fill in the street address and a Google Maps link when available;
 * until then the section offers to send directions instead.
 */
const BOOKING_WINDOW_DAYS = 30;
const CLASSES_PER_WEEK = 3;
const VENUE = { address: null, mapsUrl: null };

export default function PracticalInfo() {
  const { openEnquiry } = useEnquiryModal();
  const introRef = useRevealOnScroll({ y: 24 });
  const listRef = useRevealOnScroll({ y: 24 });

  const items = [
    {
      title: "What to wear",
      body: (
        <>
          Long trousers or riding breeches, and boots with a small heel — not trainers or sandals. Wear a riding
          helmet for every ride and leave loose jewellery at home. Helmets, breeches, chaps and boots are on sale
          in our tack shop and can be collected at the yard.
        </>
      ),
    },
    {
      title: "Who can ride",
      body: (
        <>
          Children and adults both ride with us, from complete beginners upward. Tell us the rider&apos;s age and
          experience when you get in touch and we&apos;ll suggest the right session.
        </>
      ),
    },
    {
      title: "Booking a class",
      body: (
        <>
          Buy a plan in the store, then book from your account: pick a day, a session and the horse you&apos;d
          like. We ride Tuesday to Sunday, with one-hour sessions starting at 7 and 8 in the morning and at 4, 5
          and 6 in the evening — three horses, so never more than three riders at once. You can book up to{" "}
          {BOOKING_WINDOW_DAYS} days ahead and up to {CLASSES_PER_WEEK} classes a week.
        </>
      ),
    },
    {
      title: "Getting here",
      body: VENUE.address ? (
        <>
          {VENUE.address}
          {VENUE.mapsUrl && (
            <>
              {" "}
              <a href={VENUE.mapsUrl} target="_blank" rel="noreferrer" className="text-racing-green underline underline-offset-4 hover:text-deep-forest">
                Open in Google Maps
              </a>
            </>
          )}
        </>
      ) : (
        <>
          We&apos;re in Guwahati, Assam. Send us a message and we&apos;ll reply with directions and a map pin for
          the yard.
        </>
      ),
    },
  ];

  return (
    <section id="visit" className="paper-grain relative bg-warm-ivory py-24 md:py-32">
      <div className="mx-auto grid max-w-[1440px] grid-cols-1 gap-12 px-6 md:grid-cols-12 md:gap-8 md:px-10">
        <div className="md:col-span-4">
          <div ref={introRef} className="md:sticky md:top-32">
            <SectionLabel>Practical information</SectionLabel>
            <h2 className="mt-4 font-serif text-4xl leading-tight text-charcoal [text-wrap:balance] sm:text-5xl">
              Before your first ride
            </h2>
            <p className="mt-6 max-w-sm font-sans text-base font-light leading-relaxed text-warm-grey">
              The short version of how things work at the yard. Anything not covered here, just ask.
            </p>
            <div className="mt-8">
              <Button onClick={() => openEnquiry(VENUE.address ? "Other" : "Directions")} variant="link" className="text-charcoal hover:text-racing-green">
                {VENUE.address ? "Ask a question" : "Ask for directions"}
              </Button>
            </div>
          </div>
        </div>

        <dl ref={listRef} className="border-y border-charcoal/12 md:col-span-7 md:col-start-6">
          {items.map((item, i) => (
            <div key={item.title} className="grid grid-cols-[2.25rem_1fr] gap-x-4 border-b border-charcoal/10 py-8 last:border-b-0 sm:grid-cols-[3rem_1fr]">
              <span className="pt-1 font-serif text-lg italic text-[#8a6a33]" aria-hidden="true">
                {i + 1}.
              </span>
              <div>
                <dt className="font-serif text-2xl leading-snug text-charcoal">{item.title}</dt>
                <dd className="mt-3 max-w-[62ch] font-sans text-[15px] leading-relaxed text-warm-grey">{item.body}</dd>
              </div>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
