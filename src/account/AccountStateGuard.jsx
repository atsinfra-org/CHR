import { AlertCircle, RefreshCw } from "lucide-react";
import { useAuth } from "../context/AuthProvider";
import MemberLayout from "./MemberLayout";

/**
 * Shared "is there a usable profile yet" gate for every page under
 * /account (dashboard, membership purchase, …) — extracted out of what was
 * originally AccountDashboard-only boilerplate so a second page doesn't
 * have to duplicate the loading/error/missing-profile handling verbatim.
 * Renders the member shell consistently either way; calls `children` with
 * `{ user, profile, refreshProfile, signOut }` once a real profile exists.
 */
export default function AccountStateGuard({ active, children }) {
  const { user, profile, profileStatus, profileError, refreshProfile, signOut } = useAuth();

  if (profileStatus === "loading" || profileStatus === "idle") {
    return (
      <Shell user={user} profile={profile} active={active}>
        <CenteredMessage>Loading your profile…</CenteredMessage>
      </Shell>
    );
  }

  if (profileStatus === "error") {
    return (
      <Shell user={user} profile={profile} active={active}>
        <CenteredMessage>
          <div className="flex items-start gap-2.5 border border-destructive/30 bg-destructive/5 px-4 py-3 text-left">
            <AlertCircle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-destructive" />
            <p className="font-sans text-xs leading-relaxed text-destructive">
              Couldn&apos;t load your profile ({profileError}). This is usually temporary.
            </p>
          </div>
          <button
            type="button"
            onClick={refreshProfile}
            className="mx-auto mt-6 flex items-center gap-2 border border-charcoal/15 px-5 py-2.5 font-sans text-xs tracking-[0.14em] text-charcoal uppercase transition-colors hover:border-antique-gold"
          >
            <RefreshCw size={14} strokeWidth={1.75} />
            Try Again
          </button>
        </CenteredMessage>
      </Shell>
    );
  }

  if (!profile) {
    return (
      <Shell user={user} profile={profile} active={active}>
        <CenteredMessage>
          <p className="font-sans text-sm text-warm-grey">
            Your account is signed in, but no profile record was found yet.
          </p>
          <button
            type="button"
            onClick={refreshProfile}
            className="mx-auto mt-6 flex items-center gap-2 border border-charcoal/15 px-5 py-2.5 font-sans text-xs tracking-[0.14em] text-charcoal uppercase transition-colors hover:border-antique-gold"
          >
            <RefreshCw size={14} strokeWidth={1.75} />
            Refresh
          </button>
        </CenteredMessage>
      </Shell>
    );
  }

  return children({ user, profile, refreshProfile, signOut });
}

function Shell({ user, profile, active, children }) {
  return (
    <MemberLayout user={user} profile={profile} active={active}>
      {children}
    </MemberLayout>
  );
}

function CenteredMessage({ children }) {
  return <div className="mx-auto max-w-sm px-6 py-24 text-center">{children}</div>;
}
