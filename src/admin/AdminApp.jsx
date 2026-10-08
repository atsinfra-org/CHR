import { ShieldAlert } from "lucide-react";
import { AUTH_LOADING, AUTHENTICATED, useAuth } from "../context/AuthProvider";
import AdminLogin from "./AdminLogin";
import AdminLayout from "./AdminLayout";
import { useAdminRoute } from "./useAdminRoute";
import AdminOverview from "./pages/AdminOverview";
import AdminEnquiries from "./pages/AdminEnquiries";
import AdminMembers from "./pages/AdminMembers";
import AdminHorses from "./pages/AdminHorses";
import AdminSessions from "./pages/AdminSessions";
import AdminBookings from "./pages/AdminBookings";
import AdminAttendance from "./pages/AdminAttendance";
import AdminSchedule from "./pages/AdminSchedule";
import AdminOrders from "./pages/AdminOrders";
import AdminNotifications from "./pages/AdminNotifications";
import AdminSettings from "./pages/AdminSettings";
import AdminPayments from "./pages/AdminPayments";
import AdminCredits from "./pages/AdminCredits";
import AdminAudit from "./pages/AdminAudit";
import AdminRoles from "./pages/AdminRoles";
import { PAGE_META } from "./adminNav";

// Sections only an admin may open, derived from the same adminNav.js
// metadata AdminLayout's sidebar and every PageHeader read — one definition
// rather than a second hardcoded list that could silently drift from it.
// This is a UX guard only — each admin RPC re-checks
// is_admin()/is_staff_or_admin() server-side, and RLS independently scopes
// every table read (audit_logs and enquiries are is_admin()-only in the
// database regardless of this).
const ADMIN_ONLY = new Set(Object.keys(PAGE_META).filter((key) => PAGE_META[key].adminOnly));

export default function AdminApp() {
  const { configured, status, user, profile, profileStatus, profileError, signOut } = useAuth();
  const { route, param } = useAdminRoute();

  if (!configured) {
    return (
      <Shell>
        <NotConfigured />
      </Shell>
    );
  }

  // Two independent "still loading" conditions: the session check itself,
  // and — once a session exists — the profile fetch that determines role.
  // Neither may be skipped, or a member could see a flash of the admin
  // shell (or an admin a false "access denied") for one frame.
  if (status === AUTH_LOADING || (status === AUTHENTICATED && profileStatus === "loading")) {
    return (
      <Shell>
        <div className="flex min-h-[60vh] items-center justify-center">
          <p className="font-sans text-sm text-warm-grey">Checking session…</p>
        </div>
      </Shell>
    );
  }

  if (status !== AUTHENTICATED) {
    return (
      <Shell>
        <AdminLogin />
      </Shell>
    );
  }

  if (profileStatus === "error") {
    return (
      <Shell>
        <AccessMessage title="Couldn't Verify Access" detail={profileError} onSignOut={signOut} />
      </Shell>
    );
  }

  // The authorization decision is profile.role — never "is anyone logged
  // in", never email. The database's RLS + SECURITY DEFINER RPCs are what
  // actually enforce this regardless of what the check here does.
  const role = profile?.role;
  if (role !== "admin" && role !== "staff") {
    return (
      <Shell>
        <AccessMessage
          title="Access Denied"
          detail="This account does not have admin or staff access."
          onSignOut={signOut}
        />
      </Shell>
    );
  }

  const isAdmin = role === "admin";
  const effectiveRoute = ADMIN_ONLY.has(route) && !isAdmin ? "overview" : route;

  return (
    <AdminLayout route={effectiveRoute} user={user} profile={profile} role={role}>
      <Page route={effectiveRoute} param={param} isAdmin={isAdmin} />
    </AdminLayout>
  );
}

function Page({ route, param, isAdmin }) {
  switch (route) {
    case "members":
      return <AdminMembers memberId={param} isAdmin={isAdmin} />;
    case "horses":
      return <AdminHorses isAdmin={isAdmin} />;
    case "sessions":
      return <AdminSessions isAdmin={isAdmin} />;
    case "bookings":
      return <AdminBookings isAdmin={isAdmin} />;
    case "schedule":
      return <AdminSchedule />;
    case "orders":
      return <AdminOrders isAdmin={isAdmin} />;
    case "notifications":
      return <AdminNotifications />;
    case "settings":
      return <AdminSettings />;
    case "attendance":
      return <AdminAttendance isAdmin={isAdmin} />;
    case "payments":
      return <AdminPayments />;
    case "credits":
      return <AdminCredits isAdmin={isAdmin} />;
    case "enquiries":
      return <AdminEnquiries />;
    case "audit":
      return <AdminAudit />;
    case "roles":
      return <AdminRoles />;
    default:
      return <AdminOverview isAdmin={isAdmin} />;
  }
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-warm-ivory">
      <header className="border-b border-charcoal/10 bg-deep-forest px-6 py-5 md:px-10">
        <span className="font-serif text-lg tracking-[0.08em] text-warm-ivory">
          COLONEL HORSE RIDING <span className="text-antique-gold">— Admin</span>
        </span>
      </header>
      {children}
    </div>
  );
}

function AccessMessage({ title, detail, onSignOut }) {
  return (
    <div className="mx-auto max-w-md px-6 py-24 text-center">
      <ShieldAlert size={28} strokeWidth={1.5} className="mx-auto text-antique-gold" />
      <h1 className="mt-5 font-serif text-2xl text-charcoal">{title}</h1>
      {detail && <p className="mt-3 font-sans text-sm leading-relaxed text-warm-grey">{detail}</p>}
      <button
        type="button"
        onClick={onSignOut}
        className="mt-8 font-sans text-xs tracking-[0.14em] text-racing-green uppercase underline underline-offset-4"
      >
        Sign Out
      </button>
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="mx-auto max-w-lg px-6 py-24 text-center">
      <h1 className="font-serif text-3xl text-charcoal">Database Not Connected</h1>
      <p className="mt-4 font-sans text-sm leading-relaxed text-warm-grey">
        Add <code className="text-charcoal">VITE_SUPABASE_URL</code> and{" "}
        <code className="text-charcoal">VITE_SUPABASE_ANON_KEY</code> to a{" "}
        <code className="text-charcoal">.env.local</code> file (see <code className="text-charcoal">.env.example</code>),
        run <code className="text-charcoal">supabase/schema.sql</code> in your Supabase project&apos;s SQL editor, then
        restart the dev server.
      </p>
    </div>
  );
}
