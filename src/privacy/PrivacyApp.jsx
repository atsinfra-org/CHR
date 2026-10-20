import { AlertTriangle, RefreshCw } from "lucide-react";
import LegalLayout, { ContactBox } from "./LegalLayout";
import NoticeBody from "./NoticeBody";
import { usePrivacyNotice } from "./usePrivacyNotice";
import { noticeState } from "../lib/privacyLogic";

/**
 * The public privacy pages: /privacy (the notice), /terms and /account-deletion.
 * No sign-in is needed to read any of them. Rendered from main.jsx by path.
 */
export default function PrivacyApp() {
  const path = window.location.pathname.replace(/\/$/, "");
  if (path === "/terms") return <TermsPage />;
  if (path === "/account-deletion") return <AccountDeletionPage />;
  return <PrivacyPolicyPage />;
}

function Loading() {
  return <p className="font-sans text-sm text-warm-grey">Loading…</p>;
}

function LoadError({ message, onRetry }) {
  return (
    <div className="rounded-[14px] border border-destructive/30 bg-destructive/5 p-4">
      <p className="font-sans text-sm text-destructive">We could not load this page. {message}</p>
      <button type="button" onClick={onRetry} className="mt-3 inline-flex items-center gap-2 font-sans text-xs tracking-[0.12em] text-charcoal uppercase underline underline-offset-4">
        <RefreshCw size={14} strokeWidth={1.75} /> Try again
      </button>
    </div>
  );
}

function PrivacyPolicyPage() {
  const { state, notice, config, error, reload } = usePrivacyNotice();
  const kind = noticeState(notice);

  return (
    <LegalLayout eyebrow="Your data" title="Privacy Notice">
      {state === "loading" && <Loading />}
      {state === "error" && <LoadError message={error} onRetry={reload} />}

      {state === "ready" && kind === "none" && (
        <div className="rounded-[14px] border border-warning/30 bg-warning/[0.06] p-4 font-sans text-sm leading-relaxed text-charcoal">
          The club&apos;s privacy notice is being prepared and has not been published yet.
        </div>
      )}

      {state === "ready" && kind !== "none" && (
        <>
          {kind === "draft" ? (
            <div role="note" className="mb-7 flex gap-3 rounded-[14px] border border-warning/35 bg-warning/[0.07] p-4">
              <AlertTriangle size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warning" />
              <p className="font-sans text-sm leading-relaxed text-charcoal">
                <strong>Draft — not yet in effect.</strong> This notice is still being finalised, and details marked{" "}
                <mark className="rounded bg-warning/15 px-1 text-warning">[not yet provided]</mark> have not been supplied. It will be replaced by the
                published version.
              </p>
            </div>
          ) : (
            <p className="mb-7 font-sans text-sm text-warm-grey">
              Version {notice.version}
              {notice.effective_date ? ` · in effect from ${new Date(notice.effective_date).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}` : ""}
            </p>
          )}

          <NoticeBody body={notice.body} />

          <h2 className="mt-10 mb-3 font-serif text-xl text-charcoal">Contact</h2>
          <ContactBox config={config} />

          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 font-sans text-sm">
            <a className="text-racing-green underline underline-offset-4" href="/account/privacy">Manage my privacy choices and requests</a>
            <a className="text-racing-green underline underline-offset-4" href="/account-deletion">How to close my account</a>
          </div>
        </>
      )}
    </LegalLayout>
  );
}

function TermsPage() {
  const { config } = usePrivacyNotice();
  return (
    <LegalLayout eyebrow="Terms" title="Terms & Conditions">
      <div className="rounded-[14px] border border-warning/30 bg-warning/[0.06] p-4 font-sans text-sm leading-relaxed text-charcoal">
        The club&apos;s terms and conditions have not been published yet. Nothing on this page is in effect.
      </div>
      <h2 className="mt-9 mb-3 font-serif text-xl text-charcoal">Questions</h2>
      <ContactBox config={config} />
    </LegalLayout>
  );
}

function AccountDeletionPage() {
  const { config } = usePrivacyNotice();
  return (
    <LegalLayout eyebrow="Your data" title="Close your account">
      <div className="font-sans text-[15px] leading-relaxed text-charcoal/90">
        <p>
          You can ask us to close your account and erase your personal data at any time, from the website or the Colonel Horse Riding app. We need
          you to ask from inside your own account so that nobody else can close it for you; we cannot act on an email request alone.
        </p>

        <h2 className="mt-8 mb-2 font-serif text-xl text-charcoal">How to ask</h2>
        <ol className="my-3 list-decimal space-y-1.5 pl-5 marker:text-antique-gold">
          <li>Sign in to your account on the website or in the app.</li>
          <li>Open Privacy &amp; data (in the app: Profile → Privacy).</li>
          <li>Choose &quot;Close my account&quot; and confirm.</li>
        </ol>
        <p className="mt-4">
          <a className="inline-flex min-h-[44px] items-center rounded-[10px] bg-racing-green px-5 font-sans text-xs tracking-[0.12em] text-warm-ivory uppercase hover:bg-deep-forest" href="/account/privacy">
            Sign in to continue
          </a>
        </p>

        <h2 className="mt-8 mb-2 font-serif text-xl text-charcoal">What happens next</h2>
        <ul className="my-3 list-disc space-y-1.5 pl-5 marker:text-antique-gold">
          <li>We check whether you have an active membership, upcoming bookings or an unpaid order, and tell you what needs to happen first.</li>
          <li>We then remove your name, email, phone number and date of birth from your profile, delete your phone-alert codes, notifications, weekly schedules and referral code, and stop your sign-in.</li>
          <li>Records the club must keep, such as payments, orders, memberships, credits, bookings and attendance history, and security records, stay, without the details that identify you where we can remove them.</li>
          <li>This cannot be undone, and it is not instant. We will tell you when it is finished.</li>
        </ul>
        <p className="mt-4">
          Closing your account is separate from switching off phone alerts or other optional choices, which you can change at any time in Privacy &amp; data.
        </p>

        <h2 className="mt-8 mb-3 font-serif text-xl text-charcoal">Questions</h2>
        <ContactBox config={config} />
        <p className="mt-6 text-sm text-warm-grey">
          Read the full <a className="underline underline-offset-4" href="/privacy">Privacy Notice</a>.
        </p>
      </div>
    </LegalLayout>
  );
}
