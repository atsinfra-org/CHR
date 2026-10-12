import { CalendarCheck2 } from "lucide-react";
import AccountStateGuard from "./AccountStateGuard";
import { useMemberDashboard } from "./useMemberDashboard";
import UpcomingClasses from "./dashboard/UpcomingClasses";
import ClassHistory from "./dashboard/ClassHistory";
import { ActionButton, CardSkeleton, ErrorState, PageHeader } from "./ui";

/**
 * Every class the rider has: what is booked, with the same move / calendar /
 * cancel actions as the dashboard, and what they have already ridden. The
 * dashboard shows only the next few; this is the full list.
 */
export default function MyClasses() {
  return <AccountStateGuard active="classes">{({ user }) => <Classes userId={user.id} />}</AccountStateGuard>;
}

function Classes({ userId }) {
  const { membership, upcoming, history, extras, refreshAll } = useMemberDashboard(userId);
  const canBook = membership.kind === "active" && (membership.record?.credits_remaining ?? 0) > 0;
  const booked = upcoming.status === "ready" ? upcoming.bookings.length : null;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <PageHeader
        title="My classes"
        description="Everything you have booked, and the classes you've already ridden."
        actions={
          canBook ? (
            <ActionButton href="/account/book" variant="primary" icon={CalendarCheck2}>
              Book a class
            </ActionButton>
          ) : null
        }
      />

      <div className="space-y-10">
        {upcoming.status === "loading" || upcoming.status === "idle" ? (
          <CardSkeleton lines={3} />
        ) : upcoming.status === "error" ? (
          <ErrorState title="We couldn't load your booked classes" detail={upcoming.error} onRetry={upcoming.retry} />
        ) : booked === 0 ? (
          <section>
            <h2 className="font-serif text-2xl text-charcoal">Upcoming</h2>
            <p className="mt-4 border-y border-charcoal/10 py-6 font-sans text-sm text-warm-grey">
              Nothing booked yet.{" "}
              {canBook ? (
                <a href="/account/book" className="text-racing-green underline underline-offset-4">
                  Pick a day and a time
                </a>
              ) : (
                <a href="/store" className="text-racing-green underline underline-offset-4">
                  Choose a plan to start booking
                </a>
              )}
              .
            </p>
          </section>
        ) : (
          <UpcomingClasses
            title={`Upcoming (${booked})`}
            bookings={upcoming.bookings}
            plan={membership.record}
            cancellationReturnsClass={extras.cancellationReturnsClass}
            onChanged={refreshAll}
          />
        )}

        <ClassHistory history={history} />
      </div>
    </div>
  );
}
