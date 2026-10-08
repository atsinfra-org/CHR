import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, Check, AlertCircle } from "lucide-react";
import Button from "../ui/Button";
import GoldDivider from "../ui/GoldDivider";
import { useEnquiryModal } from "../../context/EnquiryModalContext";
import { supabase, supabaseConfigured } from "../../lib/supabaseClient";

// One shared form ends up carrying whatever the site adds next, so the
// subject is explicit and user-confirmed rather than only ever inferred
// from which button was clicked.
const SUBJECT_OPTIONS = [
  "General Enquiry",
  "Junior Riding",
  "Adult Riding",
  "Book Riding Classes",
  "Book Therapy Sessions",
  "Tack Shop",
  "Café",
  "Horse Float Rental",
  "Horse Trading (Auctions)",
  "Guest House Bookings",
  "Memberships",
  "Horse Lease",
  "Donations for the NGO",
  "Other",
];

function initialForm(topic) {
  const known = SUBJECT_OPTIONS.includes(topic);
  return {
    name: "",
    age: "",
    email: "",
    phone: "",
    subject: known ? topic : topic ? "Other" : "General Enquiry",
    subjectOther: known ? "" : topic ?? "",
  };
}

export default function EnquiryModal() {
  const { isOpen, topic, closeEnquiry } = useEnquiryModal();
  const [status, setStatus] = useState("idle"); // idle | submitting | submitted | error
  const [errorMessage, setErrorMessage] = useState("");
  const [form, setForm] = useState(() => initialForm(topic));
  const firstFieldRef = useRef(null);
  const panelRef = useRef(null);

  // Fresh form every time the modal opens, regardless of how it was last left.
  useEffect(() => {
    if (isOpen) {
      setStatus("idle");
      setErrorMessage("");
      setForm(initialForm(topic));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = "hidden";
    const id = requestAnimationFrame(() => firstFieldRef.current?.focus());

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        closeEnquiry();
        return;
      }
      // Trap focus inside the dialog — without this, Tab quietly walks
      // focus into the (visually dimmed but still-present) page behind it.
      if (e.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = panel.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = "";
      cancelAnimationFrame(id);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, closeEnquiry]);

  const handleChange = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!supabaseConfigured) {
      setStatus("error");
      setErrorMessage(
        "The enquiry database isn't connected yet. Add your Supabase credentials to .env.local — see .env.example."
      );
      return;
    }

    const subject = form.subject === "Other" ? form.subjectOther.trim() : form.subject;

    setStatus("submitting");
    const { error } = await supabase.from("enquiries").insert([
      {
        name: form.name.trim(),
        age: Number(form.age),
        email: form.email.trim(),
        phone: form.phone.trim(),
        topic: subject || null,
      },
    ]);

    if (error) {
      setStatus("error");
      setErrorMessage("Something went wrong sending your enquiry. Please try again.");
      return;
    }

    setStatus("submitted");
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div data-lenis-prevent className="fixed inset-0 z-[110] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Enquiry form">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="absolute inset-0 bg-deep-forest/75 backdrop-blur-sm"
            onClick={closeEnquiry}
          />

          <motion.div
            ref={panelRef}
            data-lenis-prevent
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="relative max-h-[90dvh] w-full max-w-md overflow-y-auto border border-antique-gold/30 bg-warm-ivory p-6 shadow-[0_30px_80px_-20px_rgba(8,28,21,0.5)] sm:p-8 md:p-10"
          >
            <button
              type="button"
              onClick={closeEnquiry}
              aria-label="Close"
              className="absolute right-5 top-5 text-charcoal/50 transition-colors duration-300 hover:text-racing-green"
            >
              <X size={20} strokeWidth={1.5} />
            </button>

            {status === "submitted" ? (
              <div className="flex flex-col items-center py-6 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full border border-antique-gold text-antique-gold">
                  <Check size={22} strokeWidth={1.75} />
                </span>
                <h3 className="mt-6 font-serif text-3xl text-charcoal">Thank You</h3>
                <GoldDivider className="my-6" width="w-12" />
                <p className="max-w-xs font-sans text-sm font-light leading-relaxed text-warm-grey">
                  We will contact you soon.
                </p>
                <Button variant="solid" onClick={closeEnquiry} showArrow={false} className="mt-8">
                  Close
                </Button>
              </div>
            ) : (
              <>
                <span className="font-sans text-xs tracking-[0.32em] text-antique-gold uppercase">
                  {topic ? topic : "Get In Touch"}
                </span>
                <h3 className="mt-3 font-serif text-3xl text-charcoal">Enquire Now</h3>
                <p className="mt-3 font-sans text-sm font-light leading-relaxed text-warm-grey">
                  {topic
                    ? `Interested in ${topic}? Share a few details and our team will be in touch.`
                    : "Share a few details and our team will be in touch."}
                </p>

                <form onSubmit={handleSubmit} className="mt-8 space-y-5">
                  <Field
                    ref={firstFieldRef}
                    label="Full Name"
                    id="enquiry-name"
                    type="text"
                    autoComplete="name"
                    required
                    value={form.name}
                    onChange={handleChange("name")}
                  />

                  <div>
                    <label htmlFor="enquiry-subject" className="font-sans text-xs tracking-[0.14em] text-charcoal/70 uppercase">
                      Subject
                    </label>
                    <select
                      id="enquiry-subject"
                      name="subject"
                      required
                      value={form.subject}
                      onChange={handleChange("subject")}
                      className="mt-2 w-full border border-charcoal/15 bg-white px-4 py-3 font-sans text-sm text-charcoal outline-none transition-colors duration-300 focus:border-antique-gold"
                    >
                      {SUBJECT_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>

                  {form.subject === "Other" && (
                    <Field
                      label="Tell us briefly what about"
                      id="enquiry-subject-other"
                      type="text"
                      required
                      value={form.subjectOther}
                      onChange={handleChange("subjectOther")}
                    />
                  )}

                  <Field
                    label="Age"
                    id="enquiry-age"
                    type="number"
                    min={3}
                    max={99}
                    required
                    value={form.age}
                    onChange={handleChange("age")}
                  />
                  <Field
                    label="Email"
                    id="enquiry-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={form.email}
                    onChange={handleChange("email")}
                  />
                  <Field
                    label="Phone Number"
                    id="enquiry-phone"
                    type="tel"
                    autoComplete="tel"
                    required
                    value={form.phone}
                    onChange={handleChange("phone")}
                  />

                  {status === "error" && (
                    <div className="flex items-start gap-2.5 border border-destructive/30 bg-destructive/5 px-4 py-3">
                      <AlertCircle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-destructive" />
                      <p className="font-sans text-xs leading-relaxed text-destructive">{errorMessage}</p>
                    </div>
                  )}

                  <Button
                    type="submit"
                    variant="solid"
                    showArrow={false}
                    className="mt-2 w-full justify-center"
                  >
                    {status === "submitting" ? "Sending…" : "Submit Enquiry"}
                  </Button>
                </form>
              </>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

function Field({ label, id, ref, ...inputProps }) {
  return (
    <div>
      <label htmlFor={id} className="font-sans text-xs tracking-[0.14em] text-charcoal/70 uppercase">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        name={id}
        {...inputProps}
        className="mt-2 w-full border border-charcoal/15 bg-white px-4 py-3 font-sans text-sm text-charcoal outline-none transition-colors duration-300 placeholder:text-warm-grey/60 focus:border-antique-gold"
      />
    </div>
  );
}
