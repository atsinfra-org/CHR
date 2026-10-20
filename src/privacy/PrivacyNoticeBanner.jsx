import { useEffect, useState } from "react";
import { ShieldCheck, X } from "lucide-react";
import { getMyConsents, recordConsent } from "../lib/privacyApi";
import { takePendingAcknowledgement } from "../lib/privacyLogic";

const DISMISS_KEY = "chr.privacy.bannerDismissed";

function readDismissed() {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * Inside the member area. Two jobs, neither of which blocks anything:
 *  1. If this person ticked the notice when they registered, ask the server to record that (once they have a
 *     session). The server stamps the time and the person and re-checks the version; nothing is sent from here
 *     but the version they saw.
 *  2. If a published notice is waiting for them to read, say so — with a way to read it and a way to say "I
 *     have read it". "Not now" hides it for this visit only. Existing members are never marked as having
 *     agreed to anything they did not act on.
 */
export default function PrivacyNoticeBanner() {
  const [consents, setConsents] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      let { data } = await getMyConsents();
      if (!live || !data) return;
      // The registration tick, recorded now that there is a session.
      if (data.needs_acknowledgement) {
        const version = takePendingAcknowledgement(window.localStorage, data.current_notice_version);
        if (version) {
          const rec = await recordConsent("membership_service", "granted", version);
          if (!rec.error) ({ data } = await getMyConsents());
        }
      }
      if (live && data) setConsents(data);
    })();
    return () => {
      live = false;
    };
  }, []);

  if (hidden || !consents?.needs_acknowledgement) return null;
  if (readDismissed() === consents.current_notice_version) return null;

  async function acknowledge() {
    setBusy(true);
    setError(null);
    const { error: err } = await recordConsent("membership_service", "granted", consents.current_notice_version);
    setBusy(false);
    if (err) return setError(err);
    setHidden(true);
  }

  function notNow() {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, consents.current_notice_version);
    } catch {
      /* the banner simply shows again next visit */
    }
    setHidden(true);
  }

  return (
    <div role="region" aria-label="Privacy notice" className="border-b border-antique-gold/25 bg-soft-cream/70">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6 md:px-10">
        <ShieldCheck size={18} strokeWidth={1.75} className="shrink-0 text-racing-green" />
        <p className="min-w-0 flex-1 font-sans text-[13px] leading-snug text-charcoal">
          Our privacy notice (version {consents.current_notice_version}) explains how we use your data.{" "}
          <a href="/privacy" target="_blank" rel="noopener noreferrer" className="text-racing-green underline underline-offset-4">
            Read it
          </a>
          .{error && <span className="ml-1 text-destructive">{error}</span>}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={acknowledge}
            disabled={busy}
            className="min-h-[36px] rounded-[10px] bg-racing-green px-3.5 font-sans text-[11px] tracking-[0.12em] text-warm-ivory uppercase hover:bg-deep-forest disabled:opacity-60"
          >
            {busy ? "Saving…" : "I have read it"}
          </button>
          <button type="button" onClick={notNow} aria-label="Not now" className="p-1.5 text-warm-grey hover:text-charcoal">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </div>
  );
}
