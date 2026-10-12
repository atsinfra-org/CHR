import { Phone, Mail } from "lucide-react";
import { CLUB } from "../../lib/clubInfo";

/* Lucide no longer ships brand/social marks — minimal line-art glyphs keep the same visual weight. */
function InstagramGlyph(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4.2" />
      <circle cx="17.2" cy="6.8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function FacebookGlyph(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
      <path d="M15 4h-2a4 4 0 0 0-4 4v3H6v3h3v6h3v-6h2.5l.5-3H12V8a1 1 0 0 1 1-1h2z" />
    </svg>
  );
}

const LINKS = [
  { label: "Home", href: "#home" },
  { label: "Riding", href: "#riding" },
  { label: "About", href: "#about" },
  { label: "Contact", href: "#contact" },
];

// The yard on Google Maps (embed + the place's own page for directions).
const MAP_EMBED =
  "https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d895.7377703272429!2d91.71960396957705!3d26.10051549857129!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x375a5dbb03589703%3A0xdb1ff6102b38381b!2sColonel%20Horse%20Riding%20Club!5e0!3m2!1sen!2sin!4v1791787495789!5m2!1sen!2sin";

const CONTACT = [
  { icon: Phone, label: "Phone", value: CLUB.phone, href: `tel:${CLUB.phone.replace(/[^+d]/g, "")}` },
  { icon: Mail, label: "Email", value: CLUB.email, href: `mailto:${CLUB.email}` },
];

export default function Footer() {
  return (
    <footer className="relative bg-deep-forest pt-20">
      <div className="mx-auto max-w-[1440px] px-6 md:px-10">
        <div className="grid grid-cols-1 gap-14 border-b border-warm-ivory/10 pb-16 md:grid-cols-12 md:gap-8">
          <div className="md:col-span-4">
            <span className="font-serif text-2xl tracking-[0.06em] text-warm-ivory">COLONEL HORSE RIDING</span>
            <p className="mt-5 max-w-xs font-sans text-sm font-light leading-relaxed text-warm-ivory/50">
              A private equestrian club dedicated to the discipline and joy of horse riding.
            </p>
            <ul className="mt-8 space-y-4">
              {CONTACT.map((item) => (
                <li key={item.label} className="flex items-start gap-3">
                  <item.icon size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-warm-ivory/40" />
                  <span className="font-sans text-sm text-warm-ivory/50">
                    <span className="text-warm-ivory/70">{item.label}: </span>
                    {item.href ? (
                      <a href={item.href} className="text-warm-ivory/70 transition-colors duration-300 hover:text-warm-ivory">
                        {item.value}
                      </a>
                    ) : (
                      item.value
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-8 flex items-center gap-5">
              <a
                href="#"
                aria-label="Instagram"
                className="text-warm-ivory/50 transition-colors duration-300 hover:text-antique-gold"
              >
                <InstagramGlyph className="h-[18px] w-[18px]" />
              </a>
              <a
                href="#"
                aria-label="Facebook"
                className="text-warm-ivory/50 transition-colors duration-300 hover:text-antique-gold"
              >
                <FacebookGlyph className="h-[18px] w-[18px]" />
              </a>
            </div>
          </div>

          <div className="md:col-span-3 md:col-start-6">
            <p className="font-serif text-lg italic text-champagne-gold">Navigate</p>
            <ul className="mt-6 space-y-4">
              {LINKS.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    className="font-sans text-sm text-warm-ivory/70 transition-colors duration-300 hover:text-warm-ivory"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div className="md:col-span-4 md:col-start-9">
            <p className="font-serif text-lg italic text-champagne-gold">Find us</p>
            <div className="mt-6 w-full max-w-[400px] overflow-hidden rounded-[18px] border border-warm-ivory/15">
              <iframe
                title="Map showing the location of Colonel Horse Riding Club"
                src={MAP_EMBED}
                width="400"
                height="300"
                className="block aspect-[4/3] h-auto w-full border-0"
                allowFullScreen
                loading="lazy"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </div>
            <a href={CLUB.mapsUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block font-sans text-sm text-warm-ivory/70 underline underline-offset-4 transition-colors duration-300 hover:text-warm-ivory">
              Open in Google Maps
            </a>
          </div>
        </div>

        <div className="flex flex-col items-center justify-between gap-4 py-8 text-center md:flex-row md:text-left">
          <p className="font-sans text-xs text-warm-ivory/40">
            © 2026 Colonel Horse Riding. All rights reserved.
          </p>
          <div className="flex items-center gap-6">
            <a href="#" className="font-sans text-xs text-warm-ivory/40 transition-colors duration-300 hover:text-warm-ivory/70">
              Privacy Policy
            </a>
            <a href="#" className="font-sans text-xs text-warm-ivory/40 transition-colors duration-300 hover:text-warm-ivory/70">
              Terms &amp; Conditions
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
