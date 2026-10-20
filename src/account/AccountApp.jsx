import { AUTH_LOADING, AUTHENTICATED, useAuth } from "../context/AuthProvider";
import AuthScreen from "../components/auth/AuthScreen";
import AccountDashboard from "./AccountDashboard";
import BookClasses from "./BookClasses";
import WeeklySchedule from "./WeeklySchedule";
import OrdersPage from "./OrdersPage";
import AccountPage from "./AccountPage";
import MyClasses from "./MyClasses";
import HelpPage from "./HelpPage";
import WalletPage from "./WalletPage";
import PrivacyPage from "./PrivacyPage";
import { ToastProvider } from "./ui";

// No router dependency, matching main.jsx's own pathname-prefix pattern for
// /admin vs /account vs /: every page under /account renders through this
// same AuthProvider-wrapped shell, keyed on the exact pathname.
const pathname = window.location.pathname;
// The old in-dashboard purchase page is superseded by the Store (/store).
if (pathname.startsWith("/account/purchase")) window.location.replace("/store");
const isBookRoute = pathname.startsWith("/account/book");
const isWeeklyRoute = pathname.startsWith("/account/weekly");
const isOrdersRoute = pathname.startsWith("/orders");
const isProfileRoute = pathname.startsWith("/account/profile");
const isClassesRoute = pathname.startsWith("/account/classes");
const isHelpRoute = pathname.startsWith("/account/help");
const isWalletRoute = pathname.startsWith("/account/wallet");
const isPrivacyRoute = pathname.startsWith("/account/privacy");

export default function AccountApp() {
  const { configured, status, recovery } = useAuth();

  // Every authenticated page renders its own header (with member nav +
  // sign out) via AccountStateGuard — the plain BrandHeader below is only
  // for the unauthenticated/loading states, which have nothing to
  // navigate yet. Unauthenticated visitors never reach any of these pages.
  // After a password-reset link the person is signed in but still has to
  // choose a new password, which the sign-in screen asks for.
  if (status === AUTHENTICATED && !recovery) {
    return (
      <ToastProvider>
        {isBookRoute ? (
          <BookClasses />
        ) : isWeeklyRoute ? (
          <WeeklySchedule />
        ) : isClassesRoute ? (
          <MyClasses />
        ) : isOrdersRoute ? (
          <OrdersPage />
        ) : isProfileRoute ? (
          <AccountPage />
        ) : isHelpRoute ? (
          <HelpPage />
        ) : isWalletRoute ? (
          <WalletPage />
        ) : isPrivacyRoute ? (
          <PrivacyPage />
        ) : (
          <AccountDashboard />
        )}
      </ToastProvider>
    );
  }

  if (!configured) return <NotConfigured />;
  if (status === AUTH_LOADING) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-warm-ivory">
        <p className="font-sans text-sm text-warm-grey">Checking session…</p>
      </div>
    );
  }
  return <AuthScreen variant="member" />;
}

function NotConfigured() {
  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center bg-warm-ivory px-6 text-center">
      <h1 className="font-serif text-3xl text-charcoal">Database Not Connected</h1>
      <p className="mt-4 font-sans text-sm leading-relaxed text-warm-grey">
        Add <code className="text-charcoal">VITE_SUPABASE_URL</code> and{" "}
        <code className="text-charcoal">VITE_SUPABASE_ANON_KEY</code> to <code className="text-charcoal">.env.local</code>.
      </p>
    </div>
  );
}
