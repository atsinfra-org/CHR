import { CalendarCheck2, CreditCard, ShieldCheck } from "lucide-react";
import AccountStateGuard from "./AccountStateGuard";
import { useMemberDashboard } from "./useMemberDashboard";
import MembershipCard from "./dashboard/MembershipCard";
import WeeklyProgress from "./dashboard/WeeklyProgress";
import UpcomingClasses from "./dashboard/UpcomingClasses";
import RecentActivity from "./dashboard/RecentActivity";
import ProfileSummary from "./dashboard/ProfileSummary";
import ClassHistory from "./dashboard/ClassHistory";
import NotificationsCard from "./dashboard/NotificationsCard";
import { greeting, formatDate, formatTime } from "./dashboardUtils";
import { PageHeader, StatGrid, StatCard, ActionButton } from "./ui";

/**
 * The authenticated member's landing page. Identity (session + profile)
 * comes from useAuth()/AuthProvider; everything membership/booking/
 * activity-related is fetched once here via useMemberDashboard() and handed
 * down to cards that each own their own loading/error/empty state.
 */
export default function AccountDashboard() {
  return (
    <AccountStateGuard active="dashboard">
      {({ user, profile, refreshProfile }) => <Dashboard user={user} profile={profile} refreshProfile={refreshProfile} />}
    </AccountStateGuard>
  );
}

function Dashboard({ user, profile, refreshProfile }) {
  const { membership, weekly, upcoming, activity, history } = useMemberDashboard(user?.id);

  // Cancelling a booking can change credits, weekly-block usage, the
  // upcoming list, and recent activity all at once — refresh every affected
  // section from the database rather than guessing the new state client-side.
  const handleCancelled = () => {
    membership.retry();
    weekly.retry();
    upcoming.retry();
    activity.retry();
    history.retry();
  };

  const nextBooking = upcoming.status === "ready" ? upcoming.bookings[0] : null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <PageHeader
        title={`${greeting()}${profile.full_name ? `, ${profile.full_name.split(" ")[0]}` : ""}`}
        description="Ready for your next ride?"
        actions={
          <ActionButton href="/account/book" variant="primary" icon={CalendarCheck2}>
            Book a Class
          </ActionButton>
        }
      />

      <StatGrid className="mb-8">
        <StatCard
          icon={CreditCard}
          label="Classes Remaining"
          status={membership.status === "error" ? "error" : "ready"}
          loading={membership.status === "loading" || membership.status === "idle"}
          value={membership.kind === "active" ? membership.record.credits_remaining : null}
          emptyHint={membership.kind === "active" ? "No data yet" : "No active membership"}
          hint={membership.kind === "active" && (membership.record.total_credits ?? membership.plan?.class_credits) ? `of ${membership.record.total_credits ?? membership.plan.class_credits} in this plan` : ""}
          onRetry={membership.retry}
        />
        <StatCard
          icon={ShieldCheck}
          label="Membership"
          status={membership.status === "error" ? "error" : "ready"}
          loading={membership.status === "loading" || membership.status === "idle"}
          value={MEMBERSHIP_KIND_LABEL[membership.kind] ?? null}
          emptyHint="No membership on file"
          hint={membership.kind === "active" ? `Valid until ${formatDate(membership.record.end_date) ?? "—"}` : ""}
          onRetry={membership.retry}
        />
        <StatCard
          icon={CalendarCheck2}
          label="Next Class"
          status={upcoming.status === "error" ? "error" : "ready"}
          loading={upcoming.status === "loading" || upcoming.status === "idle"}
          value={nextBooking ? formatDate(nextBooking.class_sessions?.session_date) : null}
          emptyHint="No class booked"
          hint={nextBooking ? formatTime(nextBooking.class_sessions?.start_time) : ""}
          onRetry={upcoming.retry}
        />
      </StatGrid>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <MembershipCard membership={membership} />
          {membership.kind === "active" && <WeeklyProgress weekly={weekly} />}
          <UpcomingClasses upcoming={upcoming} onCancelled={handleCancelled} membership={membership} />
          <ClassHistory history={history} />
          <RecentActivity activity={activity} />
        </div>

        <div className="space-y-6">
          <NotificationsCard userId={user?.id} />
          <ProfileSummary user={user} profile={profile} onSaved={refreshProfile} />
        </div>
      </div>
    </div>
  );
}

const MEMBERSHIP_KIND_LABEL = {
  active: "Active",
  pending: "Pending",
  lapsed: "Lapsed",
};
