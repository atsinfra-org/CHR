import { Phone, Mail, MapPin } from "lucide-react";

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

const CONTACT = [
  { icon: Phone, label: "Phone", value: "Available on request" },
  { icon: Mail, label: "Email", value: "Available on request" },
  { icon: MapPin, label: "Location", value: "Guwahati, Assam" },
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
            <p className="font-serif text-lg italic text-champagne-gold">Contact</p>
            <ul className="mt-6 space-y-4">
              {CONTACT.map((item) => (
                <li key={item.label} className="flex items-start gap-3">
                  <item.icon size={16} strokeWidth={1.5} className="mt-0.5 shrink-0 text-warm-ivory/40" />
                  <span className="font-sans text-sm text-warm-ivory/50">
                    <span className="text-warm-ivory/70">{item.label}: </span>
                    {item.value}
                  </span>
                </li>
              ))}
            </ul>
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
