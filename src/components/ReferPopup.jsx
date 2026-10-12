import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Copy, Gift, MessageCircle, X } from "lucide-react";
import { inviteLink, inviteMessage, useWallet } from "../lib/referral";

/**
 * "Refer a friend, earn ₹500" — shown once after a payment is confirmed.
 * The reward is real: it is credited to the referrer's wallet when the friend's
 * first membership is paid (migration 0024). If that update is not applied
 * yet the popup does not appear at all, so nothing is promised that will not
 * be paid.
 */
export default function ReferPopup({ delay = 900 }) {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef(null);

  useEffect(() => {
    if (!wallet.available) return undefined;
    const id = setTimeout(() => setOpen(true), delay);
    return () => clearTimeout(id);
  }, [wallet.available, delay]);

  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!wallet.available || !wallet.code) return null;
  const link = inviteLink(wallet.code);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked: the link is still shown for selecting
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[80] flex items-center justify-center p-4" data-lenis-prevent>
          <div className="absolute inset-0 bg-[rgba(4,25,18,0.72)] backdrop-blur-[6px]" onClick={() => setOpen(false)} aria-hidden="true" />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="refer-title"
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="relative w-full max-w-[440px] overflow-hidden rounded-[24px] bg-warm-ivory shadow-[0_40px_100px_-30px_rgba(4,25,18,0.6)]"
          >
            <div className="relative bg-deep-forest px-7 pt-8 pb-7 text-warm-ivory">
              <button ref={closeRef} type="button" onClick={() => setOpen(false)} aria-label="Close" className="absolute top-3 right-3 flex h-10 w-10 items-center justify-center rounded-full text-warm-ivory/70 hover:bg-warm-ivory/10 hover:text-warm-ivory">
                <X size={19} strokeWidth={1.6} />
              </button>
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-champagne-gold text-deep-forest">
                <Gift size={22} strokeWidth={1.6} />
              </span>
              <p className="mt-4 font-serif text-lg italic text-champagne-gold">Refer &amp; earn</p>
              <h2 id="refer-title" className="mt-1 font-serif text-[2rem] leading-[1.05]">
                Earn ₹500 for every friend who joins
              </h2>
              <p className="mt-3 font-sans text-sm leading-relaxed text-warm-ivory/75">
                When a friend buys their first membership with your link, ₹500 lands in your wallet. It takes that much off any bill.
              </p>
            </div>

            <div className="px-7 py-6">
              <p className="font-sans text-[11px] tracking-[0.14em] text-warm-grey uppercase">Your invite link</p>
              <div className="mt-2 flex items-center gap-2 rounded-[12px] border border-antique-gold/30 bg-white p-1.5 pl-3.5">
                <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-charcoal">{link}</span>
                <button type="button" onClick={copy} className="flex h-10 shrink-0 items-center gap-1.5 rounded-[9px] bg-racing-green px-3.5 font-sans text-xs font-semibold tracking-[0.1em] text-warm-ivory uppercase hover:bg-deep-forest">
                  {copied ? <Check size={14} strokeWidth={2.25} /> : <Copy size={14} strokeWidth={1.75} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>

              <a
                href={`https://wa.me/?text=${encodeURIComponent(inviteMessage(wallet.code))}`}
                target="_blank"
                rel="noreferrer"
                className="mt-3 flex h-11 items-center justify-center gap-2 rounded-[12px] border border-racing-green/35 font-sans text-xs font-semibold tracking-[0.12em] text-racing-green uppercase transition-colors hover:border-racing-green hover:bg-white"
              >
                <MessageCircle size={16} strokeWidth={1.75} /> Share on WhatsApp
              </a>

              <div className="mt-5 flex items-center justify-between gap-3 font-sans text-xs text-warm-grey">
                <a href="/account/wallet" className="text-racing-green underline underline-offset-4">
                  See my wallet
                </a>
                <button type="button" onClick={() => setOpen(false)} className="underline underline-offset-4 hover:text-charcoal">
                  Maybe later
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
