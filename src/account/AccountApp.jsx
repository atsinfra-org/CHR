import { AUTH_LOADING, AUTHENTICATED, useAuth } from "../context/AuthProvider";
import AccountLogin from "./AccountLogin";
import AccountDashboard from "./AccountDashboard";
import MembershipPurchase from "./MembershipPurchase";
import BookClasses from "./BookClasses";
import { ToastProvider } from "./ui";

// No router dependency, matching main.jsx's own pathname-prefix pattern for
// /admin vs /account vs /: every page under /account renders through this
// same AuthProvider-wrapped shell, keyed on the exact pathname.
const pathname = window.location.pathname;
const isPurchaseRoute = pathname.startsWith("/account/purchase");
const isBookRoute = pathname.startsWith("/account/book");

export default function AccountApp() {
  const { configured, status } = useAuth();

  // Every authenticated page renders its own header (with member nav +
  // sign out) via AccountStateGuard — the plain BrandHeader below is only
  // for the unauthenticated/loading states, which have nothing to
  // navigate yet. Unauthenticated visitors never reach any of these pages.
  if (status === AUTHENTICATED) {
    return (
      <ToastProvider>
        {isPurchaseRoute ? <MembershipPurchase /> : isBookRoute ? <BookClasses /> : <AccountDashboard />}
      </ToastProvider>
    );
  }

  return (
    <div className="min-h-screen bg-warm-ivory">
      <BrandHeader />

      {!configured ? (
        <NotConfigured />
      ) : status === AUTH_LOADING ? (
        <div className="flex min-h-[60vh] items-center justify-center">
          <p className="font-sans text-sm text-warm-grey">Checking session…</p>
        </div>
      ) : (
        <AccountLogin />
      )}
    </div>
  );
}

function BrandHeader() {
  return (
    <header className="border-b border-charcoal/10 bg-deep-forest px-6 py-5 md:px-10">
      <a href="/" className="font-serif text-lg tracking-[0.08em] text-warm-ivory">
        COLONEL HORSE RIDING <span className="text-antique-gold">— Member Access</span>
      </a>
    </header>
  );
}

function NotConfigured() {
  return (
    <div className="mx-auto max-w-lg px-6 py-24 text-center">
      <h1 className="font-serif text-3xl text-charcoal">Database Not Connected</h1>
      <p className="mt-4 font-sans text-sm leading-relaxed text-warm-grey">
        Add <code className="text-charcoal">VITE_SUPABASE_URL</code> and{" "}
        <code className="text-charcoal">VITE_SUPABASE_ANON_KEY</code> to <code className="text-charcoal">.env.local</code>.
      </p>
    </div>
  );
}
