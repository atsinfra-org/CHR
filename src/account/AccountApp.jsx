import { AUTH_LOADING, AUTHENTICATED, useAuth } from "../context/AuthProvider";
import AccountLogin from "./AccountLogin";
import AccountDashboard from "./AccountDashboard";
import BookClasses from "./BookClasses";
import OrdersPage from "./OrdersPage";
import AccountPage from "./AccountPage";
import { ToastProvider } from "./ui";

// No router dependency, matching main.jsx's own pathname-prefix pattern for
// /admin vs /account vs /: every page under /account renders through this
// same AuthProvider-wrapped shell, keyed on the exact pathname.
const pathname = window.location.pathname;
// The old in-dashboard purchase page is superseded by the Store (/store).
if (pathname.startsWith("/account/purchase")) window.location.replace("/store");
const isBookRoute = pathname.startsWith("/account/book");
const isOrdersRoute = pathname.startsWith("/orders");
const isProfileRoute = pathname.startsWith("/account/profile");

export default function AccountApp() {
  const { configured, status } = useAuth();

  // Every authenticated page renders its own header (with member nav +
  // sign out) via AccountStateGuard — the plain BrandHeader below is only
  // for the unauthenticated/loading states, which have nothing to
  // navigate yet. Unauthenticated visitors never reach any of these pages.
  if (status === AUTHENTICATED) {
    return (
      <ToastProvider>
        {isBookRoute ? <BookClasses /> : isOrdersRoute ? <OrdersPage /> : isProfileRoute ? <AccountPage /> : <AccountDashboard />}
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
