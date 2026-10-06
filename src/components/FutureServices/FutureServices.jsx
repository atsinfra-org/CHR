import { CoverflowCarousel } from "@/components/ui/coverflow-carousel";
import SectionLabel from "../ui/SectionLabel";
import Button from "../ui/Button";
import { serviceCardImage } from "../../lib/serviceIcons";
import { useRevealOnScroll } from "../../animations/scrollAnimations";
import { useEnquiryModal } from "../../context/EnquiryModalContext";

const SERVICES = [
  { title: "Book Riding Classes", icon: "calendarCheck", active: true },
  { title: "Book Therapy Sessions", icon: "heartPulse" },
  { title: "Tack Shop", icon: "shoppingBag" },
  { title: "Café", icon: "coffee" },
  { title: "Horse Float Rental", icon: "truck" },
  { title: "Horse Trading (Auctions)", icon: "gavel" },
  { title: "Guest House Bookings", icon: "house" },
  { title: "Memberships", icon: "award" },
  { title: "Horse Lease", icon: "handshake" },
  { title: "Donations for the NGO", icon: "heartHandshake" },
];

const SLIDES = SERVICES.map((service) => ({
  src: serviceCardImage(service.icon, service.active ? "active" : "default"),
  alt: service.active
    ? `${service.title} — open for booking at Colonel Horse Riding`
    : `${service.title} — coming soon to Colonel Horse Riding`,
  title: service.title,
  subtitle: service.active ? "Open Now" : "Coming Soon",
  meta: service.active ? [{ label: "Status", value: "Accepting Enquiries" }] : undefined,
}));

export default function FutureServices() {
  const headerRef = useRevealOnScroll({ y: 24 });
  const { openEnquiry } = useEnquiryModal();

  return (
    <section className="relative overflow-hidden bg-soft-cream py-24 md:py-36">
      <div className="mx-auto max-w-[1440px] px-6 md:px-10">
        <div ref={headerRef} className="mx-auto max-w-xl text-center">
          <SectionLabel className="justify-center">The Wider Estate</SectionLabel>
          <h2 className="mt-6 font-serif text-4xl leading-tight text-charcoal sm:text-5xl md:text-6xl">
            Beyond the Arena.
          </h2>
          <p className="mx-auto mt-6 max-w-lg font-sans text-base font-light leading-relaxed text-warm-grey">
            Colonel Horse Riding is growing into a fuller estate experience. Riding classes are open today —
            here&apos;s a look at what else is on the horizon.
          </p>
        </div>
      </div>

      <div className="mt-16 md:mt-20">
        <CoverflowCarousel
          slides={SLIDES}
          showCaption
          showNavigation
          showPagination
          label="Services at Colonel Horse Riding"
          onSlideClick={(slide) => openEnquiry(slide.title)}
        />
      </div>

      <div className="mx-auto mt-14 flex max-w-xl flex-col items-center gap-5 px-6 text-center md:px-10">
        <p className="font-sans text-sm text-warm-grey">
          Riding classes are the one thing on this list open today — everything else is on its way.
        </p>
        <Button href="#riding" variant="solid">
          Book Riding Classes
        </Button>
      </div>
    </section>
  );
}
