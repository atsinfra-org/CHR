import { CalendarCheck2 } from "lucide-react";
import AccountStateGuard from "./AccountStateGuard";
import { useMemberDashboard } from "./useMemberDashboard";
import NextRide from "./dashboard/NextRide";
import PlanPanel from "./dashboard/PlanPanel";
import WelcomePanel from "./dashboard/WelcomePanel";
import UpcomingClasses from "./dashboard/UpcomingClasses";
import ClassHistory from "./dashboard/ClassHistory";
import { greeting } from "./dashboardUtils";
import { orderNumber } from "../lib/labels";
import { PageHeader, ActionButton, CardSkeleton } from "./ui";

/**
 * The rider's home page. One thing leads — the next ride — with the plan
 * beside it, then any other booked classes and the class history. Each fact
 * appears once; notifications live in the bell, the profile on the Account
 * page. Riders without a plan get a welcome panel instead of empty tiles.
 *
 * Identity comes from useAuth()/AuthProvider; everything else is fetched
 * once via useMemberDashboard() and handed down.
 */
export default function AccountDashboard() {
  return <AccountStateGuard active="dashboard">{({ user, profile }) => <Dashboard user={user} profile={profile} />}</AccountStateGuard>;
}

function Dashboard({ user, profile }) {
  const { membership, weekly, upcoming, history, extras, refreshAll } = useMemberDashboard(user?.id);
  const firstName = profile.full_name ? profile.full_name.trim().split(/\s+/)[0] : "";
  const active = membership.kind === "active";
  const loadingPlan = membership.status === "loading" || membership.status === "idle";
  const others = upcoming.status === "ready" ? upcoming.bookings.slice(1) : [];
  const hasHistory = history.status !== "ready" || history.items.length > 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <PageHeader
        title={`${greeting()}${firstName ? `, ${firstName}` : ""}`}
        actions={
          active ? (
            <ActionButton href="/account/book" variant="primary" icon={CalendarCheck2}>
              Book a class
            </ActionButton>
          ) : null
        }
      />

      <div className="space-y-4">
        {/* Only while a plan is active: without one the welcome panel carries this message.
            A second plan can't be paid for while this one still has classes, so that is not offered. */}
        {active && extras.pendingOrder && !(extras.pendingOrder.has_membership && (membership.record?.credits_remaining ?? 0) > 0) && (
          <PendingOrder order={extras.pendingOrder} />
        )}
        {!profile.phone && (
          <p className="font-sans text-sm text-warm-grey">
            Add your phone number so we can reach you if a class changes.{" "}
            <a href="/account/profile" className="text-racing-green underline underline-offset-4">
              Add it on your account page
            </a>
          </p>
        )}
      </div>

      <div className="mt-6 space-y-10">
        {loadingPlan ? (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <CardSkeleton lines={4} />
            </div>
            <div className="lg:col-span-2">
              <CardSkeleton lines={4} />
            </div>
          </div>
        ) : active || membership.status === "error" ? (
          <>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
              <div className="lg:col-span-3">
                <NextRide
                  upcoming={upcoming}
                  plan={membership.record}
                  classesLeft={membership.record?.credits_remaining ?? 0}
                  cancellationReturnsClass={extras.cancellationReturnsClass}
                  onChanged={refreshAll}
                />
              </div>
              <div className="lg:col-span-2">
                <PlanPanel membership={membership} weekly={weekly} ridden={extras.ridden} />
              </div>
            </div>
            <UpcomingClasses bookings={others} plan={membership.record} cancellationReturnsClass={extras.cancellationReturnsClass} onChanged={refreshAll} />
          </>
        ) : (
          <WelcomePanel lapsed={membership.kind === "lapsed"} pendingOrder={extras.pendingOrder} />
        )}

        {(active || hasHistory) && <ClassHistory history={history} />}
      </div>
    </div>
  );
}

/** An order that was started but has not been paid yet. */
function PendingOrder({ order }) {
  const items = (order.order_items ?? []).map((i) => i.name).join(", ");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-antique-gold/40 bg-antique-gold/[0.08] px-5 py-4">
      <p className="font-sans text-sm text-charcoal">
        <span className="font-medium">Order {orderNumber(order.id)}</span>
        {items ? ` (${items})` : ""} hasn&apos;t been paid yet.
      </p>
      <a href="/orders" className="font-sans text-xs tracking-[0.12em] text-racing-green uppercase underline underline-offset-4">
        Complete payment
      </a>
    </div>
  );
}
