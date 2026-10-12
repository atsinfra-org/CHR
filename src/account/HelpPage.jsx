import { useEffect, useId, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertCircle, CalendarDays, CheckCircle2, ChevronDown, Clock, Mail, MapPin, MessageCircle, Phone } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { CLUB } from "../lib/clubInfo";
import AccountStateGuard from "./AccountStateGuard";
import { ageFrom } from "./dashboardUtils";
import { PageHeader } from "./ui";

const SUBJECTS = ["A booking or class", "A payment or order", "My membership", "Directions to the club", "Something else"];
const MAX_MESSAGE = 500;
// Fields on the dark message card. Native <option>s are drawn by the OS on a
// light list, so they are given dark text explicitly.
const FIELD =
  "mt-1.5 block w-full rounded-[10px] border border-warm-ivory/20 bg-warm-ivory/[0.08] px-3.5 font-sans text-sm text-warm-ivory outline-none transition-colors placeholder:text-warm-ivory/45 focus:border-champagne-gold [&>option]:text-charcoal";
const PILL = "inline-flex items-center gap-2 rounded-full border border-antique-gold/30 bg-white px-3.5 py-2 font-sans text-xs text-charcoal";

/**
 * Help & contact: the answers riders ask for most, and a way to reach the
 * club. The booking rules are read live from system_settings so this page
 * cannot drift from what the booking screen enforces. Phone, WhatsApp, email
 * and address come from src/lib/clubInfo.js and appear only once filled in;
 * the message form always works and lands in Admin → Enquiries.
 *
 * It is meant to be taken in at a glance: the answers fold away (one open at
 * a time) and, on desktop and laptop screens, the lg: spacing scales with the
 * screen height so the whole page fits without scrolling.
 */
export default function HelpPage() {
  return <AccountStateGuard active="help">{({ user, profile }) => <Help user={user} profile={profile} />}</AccountStateGuard>;
}

function Help({ user, profile }) {
  const [rules, setRules] = useState(null);

  useEffect(() => {
    let active = true;
    supabase
      .from("system_settings")
      .select("key, value")
      .in("key", ["weekly_class_limit", "booking_window_days", "cancellation_returns_credit", "cancellation_cutoff_hours"])
      .then(({ data, error }) => {
        if (active && !error) setRules(Object.fromEntries((data ?? []).map((r) => [r.key, r.value])));
      });
    return () => {
      active = false;
    };
  }, []);

  const perWeek = rules?.weekly_class_limit ?? 3;
  const daysAhead = rules?.booking_window_days ?? 30;
  const answers = [
    {
      q: "When can I ride?",
      a: "Tuesday to Sunday. One-hour classes start at 7 and 8 in the morning, and at 4, 5 and 6 in the evening. The club is closed on Mondays.",
    },
    {
      q: "How far ahead can I book?",
      a: `Up to ${daysAhead} days ahead, and up to ${perWeek} class${perWeek === 1 ? "" : "es"} in any one week of your plan.`,
    },
    {
      q: "Can I change a class?",
      a: "Yes. A booked class can be moved once to another day or time, as long as your plan has a reschedule left. Moving it does not use another class.",
    },
    {
      q: "What if I cancel?",
      a:
        rules?.cancellation_returns_credit === true
          ? `Cancel at least ${rules?.cancellation_cutoff_hours ?? 24} hours before the class and it is returned to your plan.`
          : "A cancelled class is not returned to your plan, so move it to another time instead whenever you can.",
    },
    { q: "Which horse will I ride?", a: "Your coach will assign your horse at the ground." },
    {
      q: "What should I wear?",
      a: "Long trousers or breeches, boots with a small heel, and a riding helmet for every ride. Leave loose jewellery at home.",
    },
    {
      q: "I paid but my order still shows unpaid",
      a: "Payments are confirmed automatically, usually within a minute. If it has not changed after a few minutes, send us a message with the order number from My Orders.",
    },
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 md:px-10 md:pt-12 md:pb-4 lg:pt-[clamp(1.5rem,calc(13.8vh-53px),3rem)]">
      <PageHeader
        title="Help & contact"
        description="The answers riders ask for most, and a way to reach the club."
        className="lg:mb-[clamp(1rem,calc(7.7vh-28px),1.75rem)]"
        actions={
          <ul className="flex flex-wrap gap-2">
            <li className={PILL}>
              <CalendarDays size={14} strokeWidth={1.75} className="text-racing-green" /> Tuesday to Sunday
            </li>
            <li className={PILL}>
              <Clock size={14} strokeWidth={1.75} className="text-racing-green" /> 7 &amp; 8 am · 4, 5 &amp; 6 pm
            </li>
            <li>
              {CLUB.mapsUrl ? (
                <a href={CLUB.mapsUrl} target="_blank" rel="noreferrer" className={`${PILL} transition-colors hover:border-antique-gold`}>
                  <MapPin size={14} strokeWidth={1.75} className="text-racing-green" /> {CLUB.address ?? CLUB.city}
                </a>
              ) : (
                <span className={PILL}>
                  <MapPin size={14} strokeWidth={1.75} className="text-racing-green" /> {CLUB.address ?? CLUB.city}
                </span>
              )}
            </li>
          </ul>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5 lg:items-start">
        <Answers items={answers} />
        <MessageCard user={user} profile={profile} />
      </div>
    </div>
  );
}

/** The questions, folded: one answer open at a time, the first to begin with. */
function Answers({ items }) {
  const [open, setOpen] = useState(0);
  const reduceMotion = useReducedMotion();
  const base = useId();

  return (
    <section className="lg:col-span-3" aria-labelledby={`${base}-title`}>
      <div className="rounded-[22px] border border-antique-gold/25 bg-white px-5 py-2 shadow-[0_1px_2px_rgba(27,27,24,0.04),0_12px_32px_-18px_rgba(8,28,21,0.13)] sm:px-7">
        <h2 id={`${base}-title`} className="sr-only">
          Good to know
        </h2>
        <ul className="divide-y divide-charcoal/[0.08]">
          {items.map((item, i) => {
            const isOpen = open === i;
            return (
              <li key={item.q}>
                <button
                  type="button"
                  id={`${base}-q${i}`}
                  aria-expanded={isOpen}
                  aria-controls={`${base}-a${i}`}
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="group flex w-full items-center justify-between gap-4 py-3.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-antique-gold lg:py-[clamp(0.25rem,1.1vh,0.875rem)]"
                >
                  <span className={`font-serif text-[1.15rem] leading-snug transition-colors lg:text-[clamp(1rem,2.5vh,1.15rem)] ${isOpen ? "text-racing-green" : "text-charcoal group-hover:text-racing-green"}`}>{item.q}</span>
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-all duration-200 ${
                      isOpen ? "rotate-180 border-racing-green bg-racing-green text-warm-ivory" : "border-antique-gold/40 text-racing-green group-hover:border-antique-gold"
                    }`}
                    aria-hidden="true"
                  >
                    <ChevronDown size={15} strokeWidth={1.75} />
                  </span>
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      id={`${base}-a${i}`}
                      role="region"
                      aria-labelledby={`${base}-q${i}`}
                      initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                      transition={{ duration: 0.22, ease: "easeOut" }}
                      className="overflow-hidden"
                    >
                      <p className="pr-6 pb-3 font-sans text-sm leading-relaxed text-warm-grey lg:text-[clamp(0.8125rem,1.95vh,0.875rem)]">{item.a}</p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/**
 * A message to the club from a signed-in rider. It is saved where the public
 * enquiry form saves (the enquiries table: name, age, email, phone, topic),
 * so staff read it in Admin → Enquiries; the rider's details come from their
 * profile, and only what the profile lacks is asked for.
 */
function MessageCard({ user, profile }) {
  const knownAge = ageFrom(profile?.date_of_birth);
  const email = profile?.email || user?.email || "";
  const [form, setForm] = useState({ subject: SUBJECTS[0], message: "", phone: profile?.phone ?? "", age: "" });
  const [state, setState] = useState({ status: "idle", error: null }); // idle | sending | sent | error
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const shell =
    "rounded-[22px] border border-[#1d4a37] bg-[linear-gradient(140deg,#0c261c_0%,#16402f_100%)] p-6 text-warm-ivory shadow-[0_24px_48px_-28px_rgba(8,28,21,0.6)] lg:col-span-2 lg:p-[clamp(0.875rem,2.6vh,1.5rem)]";

  const submit = async (e) => {
    e.preventDefault();
    const message = form.message.trim();
    const phone = form.phone.trim();
    const age = knownAge ?? Number(form.age);
    if (message.length < 10) return setState({ status: "error", error: "Please tell us a little more, at least a sentence." });
    if (phone.replace(/\D/g, "").length < 7) return setState({ status: "error", error: "Please add a phone number we can reach you on." });
    if (!Number.isInteger(age) || age < 3 || age > 110) return setState({ status: "error", error: "Please enter your age." });

    setState({ status: "sending", error: null });
    const { error } = await supabase.from("enquiries").insert([
      {
        name: profile?.full_name?.trim() || email,
        age,
        email,
        phone,
        topic: `Member message — ${form.subject}: ${message}`.slice(0, MAX_MESSAGE + 60),
      },
    ]);
    if (error) return setState({ status: "error", error: "We couldn't send your message. Please try again." });
    setState({ status: "sent", error: null });
  };

  if (state.status === "sent") {
    return (
      <section className={shell} aria-live="polite">
        <CheckCircle2 size={26} strokeWidth={1.5} className="text-champagne-gold" />
        <h2 className="mt-3 font-serif text-2xl">Message sent</h2>
        <p className="mt-2 font-sans text-sm leading-relaxed text-warm-ivory/75">Thank you. The club has your message and will reply by phone or email.</p>
        <button
          type="button"
          onClick={() => {
            setForm((f) => ({ ...f, message: "" }));
            setState({ status: "idle", error: null });
          }}
          className="mt-6 inline-flex min-h-[44px] items-center rounded-[10px] border border-warm-ivory/30 px-4 font-sans text-xs tracking-[0.12em] uppercase transition-colors hover:border-warm-ivory hover:bg-warm-ivory/10"
        >
          Send another
        </button>
      </section>
    );
  }

  return (
    <section className={shell}>
      <p className="font-serif text-lg italic text-champagne-gold">Reach the club</p>
      <h2 className="font-serif text-2xl leading-tight">Send us a message</h2>
      <p className="mt-1 font-sans text-xs leading-relaxed text-warm-ivory/65">
        We&apos;ll reply to {email || "your email"}
        {profile?.phone ? ` or ${profile.phone}` : ""}.
      </p>

      {(CLUB.phone || CLUB.whatsapp || CLUB.email) && (
        <ul className="mt-3 flex flex-wrap gap-2 font-sans text-xs">
          {CLUB.phone && (
            <li>
              <a href={`tel:${CLUB.phone.replace(/[^+\d]/g, "")}`} className="inline-flex items-center gap-1.5 rounded-full border border-warm-ivory/25 px-3 py-1.5 transition-colors hover:border-warm-ivory">
                <Phone size={13} strokeWidth={1.75} /> {CLUB.phone}
              </a>
            </li>
          )}
          {CLUB.whatsapp && (
            <li>
              <a href={`https://wa.me/${CLUB.whatsapp}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full border border-warm-ivory/25 px-3 py-1.5 transition-colors hover:border-warm-ivory">
                <MessageCircle size={13} strokeWidth={1.75} /> WhatsApp
              </a>
            </li>
          )}
          {CLUB.email && (
            <li>
              <a href={`mailto:${CLUB.email}`} className="inline-flex items-center gap-1.5 rounded-full border border-warm-ivory/25 px-3 py-1.5 transition-colors hover:border-warm-ivory">
                <Mail size={13} strokeWidth={1.75} /> {CLUB.email}
              </a>
            </li>
          )}
        </ul>
      )}

      <form onSubmit={submit} className="mt-4 space-y-4 lg:space-y-[clamp(0.6rem,1.9vh,1rem)]" noValidate>
        <label className="block font-sans text-[13px] text-warm-ivory/85">
          What is it about?
          <select value={form.subject} onChange={set("subject")} className={`${FIELD} h-[42px]`}>
            {SUBJECTS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>

        <label className="block font-sans text-[13px] text-warm-ivory/85">
          Your message
          <textarea
            value={form.message}
            onChange={set("message")}
            maxLength={MAX_MESSAGE}
            placeholder="A question, a problem, or ask for directions and a map pin."
            className={`${FIELD} h-28 resize-none py-2.5 leading-relaxed lg:h-[clamp(4rem,10.5vh,7.5rem)]`}
          />
        </label>

        {(!profile?.phone || knownAge === null) && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {!profile?.phone && (
              <label className="block font-sans text-[13px] text-warm-ivory/85">
                Phone
                <input type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={set("phone")} className={`${FIELD} h-[42px]`} />
              </label>
            )}
            {knownAge === null && (
              <label className="block font-sans text-[13px] text-warm-ivory/85">
                Your age
                <input type="number" inputMode="numeric" min="3" max="110" value={form.age} onChange={set("age")} className={`${FIELD} h-[42px]`} />
              </label>
            )}
          </div>
        )}

        {state.status === "error" && (
          <p role="alert" className="flex items-start gap-2 font-sans text-[13px] leading-relaxed text-[#f6c4b9]">
            <AlertCircle size={15} strokeWidth={1.75} className="mt-0.5 shrink-0" />
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={state.status === "sending"}
          className="flex h-11 w-full items-center justify-center rounded-[10px] bg-warm-ivory font-sans text-xs font-semibold tracking-[0.14em] text-racing-green uppercase transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-champagne-gold disabled:opacity-60"
        >
          {state.status === "sending" ? "Sending…" : "Send message"}
        </button>
      </form>
    </section>
  );
}
