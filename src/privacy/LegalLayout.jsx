import { Mail, Phone } from "lucide-react";

/** Header and footer for the standalone legal pages (privacy notice, terms, account deletion). */
export default function LegalLayout({ title, eyebrow, children }) {
  return (
    <div className="flex min-h-screen flex-col bg-warm-ivory">
      <header className="border-b border-antique-gold/20 bg-white/70">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <a href="/" className="font-serif text-lg text-racing-green">
            Colonel Horse Riding
          </a>
          <a href="/account" className="font-sans text-xs tracking-[0.14em] text-warm-grey uppercase transition-colors hover:text-charcoal">
            My account
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-10 sm:py-14">
        {eyebrow && <p className="font-sans text-[10.5px] tracking-[0.22em] text-antique-gold uppercase">{eyebrow}</p>}
        <h1 className="mt-2 mb-6 font-serif text-[2rem] leading-tight text-charcoal sm:text-[2.4rem]">{title}</h1>
        {children}
      </main>

      <footer className="border-t border-antique-gold/20 bg-white/70">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-5 font-sans text-xs text-warm-grey">
          <span>© 2026 Colonel Horse Riding</span>
          <nav className="flex flex-wrap gap-x-5 gap-y-1" aria-label="Legal">
            <a href="/privacy" className="hover:text-charcoal">Privacy Notice</a>
            <a href="/terms" className="hover:text-charcoal">Terms</a>
            <a href="/account-deletion" className="hover:text-charcoal">Delete my account</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/** The club's privacy and grievance contacts, only the ones the club has supplied. */
export function ContactBox({ config }) {
  const hasPrivacy = config?.privacy_contact_email || config?.privacy_contact_phone;
  const hasGrievance = config?.grievance_officer_name || config?.grievance_officer_email || config?.grievance_officer_phone;
  if (!config || (!hasPrivacy && !hasGrievance)) {
    return (
      <div className="rounded-[14px] border border-warning/30 bg-warning/[0.06] p-4 font-sans text-sm leading-relaxed text-charcoal">
        The club&apos;s privacy and complaints contact details are still being finalised. Until they are published here, please use the contact
        details on the club&apos;s website.
      </div>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {hasPrivacy && (
        <div className="rounded-[14px] border border-antique-gold/25 bg-white p-4">
          <p className="font-sans text-[10.5px] tracking-[0.2em] text-antique-gold uppercase">Privacy questions</p>
          {config.legal_entity_name && <p className="mt-2 font-sans text-sm font-medium text-charcoal">{config.legal_entity_name}</p>}
          {config.privacy_contact_email && (
            <p className="mt-1 flex items-center gap-2 font-sans text-sm text-charcoal">
              <Mail size={14} strokeWidth={1.75} />
              <a className="underline underline-offset-4" href={`mailto:${config.privacy_contact_email}`}>
                {config.privacy_contact_email}
              </a>
            </p>
          )}
          {config.privacy_contact_phone && (
            <p className="mt-1 flex items-center gap-2 font-sans text-sm text-charcoal">
              <Phone size={14} strokeWidth={1.75} />
              {config.privacy_contact_phone}
            </p>
          )}
          {config.registered_address && <p className="mt-2 font-sans text-xs leading-relaxed whitespace-pre-line text-warm-grey">{config.registered_address}</p>}
        </div>
      )}
      {hasGrievance && (
        <div className="rounded-[14px] border border-antique-gold/25 bg-white p-4">
          <p className="font-sans text-[10.5px] tracking-[0.2em] text-antique-gold uppercase">Complaints</p>
          {config.grievance_officer_name && <p className="mt-2 font-sans text-sm font-medium text-charcoal">{config.grievance_officer_name}</p>}
          {config.dpo_designation && <p className="font-sans text-xs text-warm-grey">{config.dpo_designation}</p>}
          {config.grievance_officer_email && (
            <p className="mt-1 flex items-center gap-2 font-sans text-sm text-charcoal">
              <Mail size={14} strokeWidth={1.75} />
              <a className="underline underline-offset-4" href={`mailto:${config.grievance_officer_email}`}>
                {config.grievance_officer_email}
              </a>
            </p>
          )}
          {config.grievance_officer_phone && (
            <p className="mt-1 flex items-center gap-2 font-sans text-sm text-charcoal">
              <Phone size={14} strokeWidth={1.75} />
              {config.grievance_officer_phone}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
