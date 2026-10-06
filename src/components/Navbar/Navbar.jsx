import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X } from "lucide-react";
import Button from "../ui/Button";
import { useEnquiryModal } from "../../context/EnquiryModalContext";

const LINKS = [
  { label: "Home", href: "#home" },
  { label: "Riding", href: "#riding" },
  { label: "About", href: "#about" },
  { label: "Contact", href: "#contact" },
];

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const { openEnquiry } = useEnquiryModal();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <motion.header
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.9, delay: 0.5, ease: "easeOut" }}
        className={`fixed top-0 inset-x-0 z-50 transition-all duration-500 ease-out ${
          scrolled ? "bg-deep-forest/95 backdrop-blur-sm shadow-[0_1px_0_rgba(198,161,91,0.15)]" : "bg-transparent"
        }`}
      >
        <nav
          className={`mx-auto flex max-w-[1440px] items-center justify-between px-6 transition-all duration-500 ease-out md:px-10 ${
            scrolled ? "py-4" : "py-7"
          }`}
        >
          <a href="#home" className="font-serif text-lg md:text-xl tracking-[0.08em] text-warm-ivory">
            COLONEL HORSE RIDING
          </a>

          <div className="hidden items-center gap-10 md:flex">
            {LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                data-cursor="link"
                className="group relative font-sans text-xs tracking-[0.24em] uppercase text-warm-ivory/85 transition-colors duration-300 hover:text-antique-gold"
              >
                {link.label}
                <span className="absolute -bottom-1.5 left-0 h-px w-0 bg-antique-gold transition-all duration-300 ease-out group-hover:w-full" />
              </a>
            ))}
            <Button onClick={() => openEnquiry()} variant="outline" showArrow={false} className="px-6 py-3 text-[11px]">
              Enquire Now
            </Button>
          </div>

          <button
            aria-label="Open menu"
            onClick={() => setOpen(true)}
            className="text-warm-ivory md:hidden"
          >
            <Menu size={26} strokeWidth={1.5} />
          </button>
        </nav>
      </motion.header>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            className="fixed inset-0 z-[60] flex flex-col bg-deep-forest px-8 py-7 md:hidden"
          >
            <div className="flex items-center justify-between">
              <span className="font-serif text-lg tracking-[0.08em] text-warm-ivory">
                COLONEL HORSE RIDING
              </span>
              <button aria-label="Close menu" onClick={() => setOpen(false)} className="text-warm-ivory">
                <X size={26} strokeWidth={1.5} />
              </button>
            </div>

            <div className="mt-16 flex flex-1 flex-col justify-center gap-8">
              {LINKS.map((link, i) => (
                <motion.a
                  key={link.label}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.1 + i * 0.08, ease: "easeOut" }}
                  className="font-serif text-4xl text-warm-ivory"
                >
                  {link.label}
                </motion.a>
              ))}
            </div>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.5 }}
            >
              <Button
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  openEnquiry();
                }}
                className="w-full justify-center"
              >
                Enquire Now
              </Button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
