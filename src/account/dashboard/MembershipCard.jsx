import { CalendarClock } from "lucide-react";
import { Card, SectionHeader, StatusPill, ActionButton, CardSkeleton, ErrorState } from "../ui";
import { formatDate } from "../dashboardUtils";

/**
 * Renders exactly one of the four membership states (Active / Pending
 * Payment / Lapsed [expired/cancelled/suspended] / None). `membership` is
 * the shape returned by useMembershipStatus()'s slice — `kind` is derived
 * read-only from real `memberships.status` rows, never assumed. The state
 * indicator uses StatusPill wherever a real status value exists (active,
 * pending_payment, and the real lapsed sub-status); "None" has no backing
 * status row at all, so it gets a plain neutral label instead of a
 * fabricated one.
 */
export default function MembershipCard({ membership }) {
  if (membership.status === "loading" || membership.status === "idle") {
    return (
      <Card id="membership">
        <SectionHeader title="Riding Membership" />
        <CardSkeleton lines={2} />
      </Card>
    );
  }

  if (membership.status === "error") {
    return (
      <Card id="membership">
        <SectionHeader title="Riding Membership" />
        <ErrorState detail={membership.error} onRetry={membership.retry} />
      </Card>
    );
  }

  if (membership.kind === "active") {
    const m = membership.record;
    const plan = membership.plan;
    const total = plan?.class_credits ?? null;
    const remaining = m.credits_remaining;
    const used = total !== null ? Math.max(total - remaining, 0) : null;

    return (
      <Card id="membership">
        <SectionHeader title={plan?.name ?? "Riding Membership"} action={<StatusPill value="active" />} />

        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
          <Stat label="Classes Remaining" value={total !== null ? `${remaining} / ${total}` : remaining} />
          <Stat label="Classes Used" value={total !== null ? `${used} / ${total}` : "—"} />
          <Stat label="Valid Until" value={formatDate(m.end_date) ?? "—"} />
        </div>

        <p className="mt-6 font-sans text-xs text-warm-grey">
          Membership period: {formatDate(m.start_date) ?? "—"} – {formatDate(m.end_date) ?? "—"}
        </p>

        <div className="mt-6">
          <ActionButton href="/account/book" variant="primary">
            Book a Class
          </ActionButton>
        </div>
      </Card>
    );
  }

  if (membership.kind === "pending") {
    return (
      <Card id="membership">
        <SectionHeader title="Riding Membership" action={<StatusPill value="pending_payment" label="Payment Pending" />} />
        <p className="font-sans text-sm leading-relaxed text-warm-grey">
          Your membership has not been activated yet. This updates automatically once payment is confirmed.
        </p>
        <div className="mt-6">
          <ActionButton href="/account/purchase" variant="secondary">
            View Purchase Details
          </ActionButton>
        </div>
      </Card>
    );
  }

  if (membership.kind === "lapsed") {
    const m = membership.record;
    const label = m.status === "cancelled" ? "Cancelled" : m.status === "suspended" ? "Suspended" : "Expired";
    return (
      <Card id="membership">
        <SectionHeader title="Riding Membership" action={<StatusPill value={m.status} label={label} />} />
        <p className="font-sans text-sm leading-relaxed text-warm-grey">
          {m.end_date
            ? `Your previous membership ended on ${formatDate(m.end_date)}.`
            : "Your previous membership is no longer active."}
        </p>
        <div className="mt-6">
          <ActionButton href="/account/purchase" variant="primary">
            Renew Membership
          </ActionButton>
        </div>
      </Card>
    );
  }

  // kind === "none" — no membership row exists at all, so there is no real
  // status value to show a pill for; a plain neutral label is honest here.
  return (
    <Card id="membership">
      <SectionHeader
        title="Riding Membership"
        action={
          <span className="inline-flex items-center gap-1.5 font-sans text-[13px] font-medium text-warm-grey">
            <CalendarClock size={14} strokeWidth={1.75} />
            No Active Membership
          </span>
        }
      />
      <p className="font-sans text-sm leading-relaxed text-warm-grey">
        Purchase a riding membership to start booking your classes.
      </p>
      <div className="mt-6">
        <ActionButton href="/account/purchase" variant="primary">
          View Membership Plans
        </ActionButton>
      </div>
    </Card>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <p className="font-sans text-[11px] tracking-[0.14em] text-warm-grey uppercase">{label}</p>
      <p className="mt-1.5 font-serif text-2xl text-charcoal">{value}</p>
    </div>
  );
}

