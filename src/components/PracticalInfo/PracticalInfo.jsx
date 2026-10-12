import { useEnquiryModal } from "../../context/EnquiryModalContext";
import { CLUB } from "../../lib/clubInfo";

/**
 * Before your first ride: when we ride, what to wear, who can ride, how
 * booking works and where we are.
 *
 * The two things a new rider has to get right, the hours and the kit, are set
 * large beside a photograph; the rest are three short notes. There are no
 * numbers because nothing here is a sequence.
 *
 * The hours and figures mirror the live system (Admin → Settings and the
 * schedule templates): keep them in step if those change.
 */
const RIDERS_PER_CLASS = 3;
const BOOKING_WINDOW_DAYS = 30;
const CLASSES_PER_WEEK = 3;

const LINK = "text-racing-green underline decoration-racing-green/40 underline-offset-4 transition-colors hover:decoration-racing-green";

export default function PracticalInfo() {
  const { openEnquiry } = useEnquiryModal();

  return (
    <section id="visit" className="paper-grain relative bg-warm-ivory py-20 md:py-28">
      <div className="mx-auto max-w-[1440px] px-6 md:px-10">
        <header className="max-w-3xl">
          <h2 className="font-serif text-4xl leading-[1.05] text-charcoal sm:text-5xl md:text-6xl">Before your first ride</h2>
          <p className="mt-5 max-w-xl font-sans text-base leading-relaxed text-warm-grey">
            When we ride, what to wear and how to find us.
            {CLUB.phone && (
              <>
                {" "}
                Anything else, call us on{" "}
                <a href={`tel:${CLUB.phone.replace(/[^+\d]/g, "")}`} className={`${LINK} whitespace-nowrap`}>
                  {CLUB.phone}
                </a>
                .
              </>
            )}
          </p>
        </header>

        <div className="mt-12 grid grid-cols-1 gap-x-12 gap-y-10 md:mt-16 lg:grid-cols-12">
          <div className="relative h-64 sm:h-80 lg:col-span-5 lg:h-auto lg:min-h-[420px] xl:col-span-4">
            <img
              src="/assests/tack/helmet.jpg"
              alt="A rider in a riding helmet beside her horse"
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover object-[26%_38%]"
            />
          </div>

          <div className="grid grid-cols-1 gap-x-12 gap-y-10 md:grid-cols-2 lg:col-span-7 lg:grid-cols-1 lg:self-center xl:col-span-8 xl:grid-cols-2">
            <Essentials title="When we ride" lines={["Tuesday to Sunday.", "Mornings at 7 and 8 am.", "Evenings at 4, 5 and 6 pm."]}>
              Closed on Mondays. Every class is one hour, with no more than {RIDERS_PER_CLASS} riders. You can book up to {BOOKING_WINDOW_DAYS} days ahead, and up to{" "}
              {CLASSES_PER_WEEK} classes a week.
            </Essentials>
            <Essentials title="What to wear" lines={["A riding helmet, every ride.", "Long trousers or breeches.", "Boots with a small heel."]}>
              Leave trainers, sandals and loose jewellery at home. If you don&apos;t have the kit yet, it&apos;s all in our{" "}
              <a href="/store" className={LINK}>
                tack shop
              </a>{" "}
              and you collect it at the club.
            </Essentials>
          </div>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-x-10 gap-y-9 border-t border-charcoal/12 pt-10 md:mt-16 md:grid-cols-3">
          <Note title="Who can ride">
            Children and adults, from complete beginners up. Tell us the rider&apos;s age and experience and we&apos;ll suggest the right class.
          </Note>
          <Note title="How booking works">
            Buy a plan in the{" "}
            <a href="/store" className={LINK}>
              store
            </a>
            , then choose a day and a time from your account. Your coach will assign your horse at the ground.
          </Note>
          <Note title="Finding us">
            We&apos;re in {CLUB.city}.{" "}
            {CLUB.mapsUrl && (
              <>
                <a href={CLUB.mapsUrl} target="_blank" rel="noreferrer" className={LINK}>
                  Open the club in Google Maps
                </a>
                , or{" "}
              </>
            )}
            <button type="button" onClick={() => openEnquiry("Directions")} className={`${LINK} cursor-pointer`}>
              {CLUB.mapsUrl ? "ask us for directions" : "Ask us for directions"}
            </button>
            .
          </Note>
        </div>
      </div>
    </section>
  );
}

/** A short heading, three lines to remember, and the small print under them. */
function Essentials({ title, lines, children }) {
  return (
    <div>
      <h3 className="font-sans text-sm font-medium text-warm-grey">{title}</h3>
      <ul className="mt-3 space-y-1.5 font-serif text-[1.7rem] leading-[1.15] text-charcoal xl:text-[1.9rem]">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-5 max-w-[38ch] font-sans text-[15px] leading-relaxed text-warm-grey">{children}</p>
    </div>
  );
}

function Note({ title, children }) {
  return (
    <div>
      <h3 className="font-serif text-2xl leading-snug text-charcoal">{title}</h3>
      <p className="mt-2 max-w-[44ch] font-sans text-[15px] leading-relaxed text-warm-grey">{children}</p>
    </div>
  );
}
