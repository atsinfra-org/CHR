import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { todayISODate } from "./dashboardUtils";

/** @typedef {import("../lib/database.types").Membership} Membership */
/** @typedef {import("../lib/database.types").MembershipPlan} MembershipPlan */

const emptySection = { status: "idle", error: null };

/**
 * The member's own membership rows, reduced to "which one currently
 * matters and what state is it in" — active (unexpired) / pending payment /
 * lapsed (expired, cancelled, suspended, or an active row past its own
 * end_date) / none. Shared by useMemberDashboard() (Phase 4.2) and the
 * membership purchase page (Phase 4.3) so this derivation exists in
 * exactly one place rather than being refetched/re-derived per screen.
 *
 * This is a read-only VIEW: it decides nothing about eligibility or
 * whether a purchase is allowed — initiate_membership_purchase() is
 * authoritative for that regardless of what this hook shows.
 */
/**
 * A member can hold more than one active plan (for example Gold plus a One-Time Ride).
 *   active     the plan the server books single classes against (book_class / member_booking_eligibility):
 *              a plan with classes left first, then the one ending soonest.
 *   recurring  the plan a weekly schedule runs on, chosen like confirm_recurring_schedule(): an active plan that
 *              allows a weekly schedule, ending soonest. It can differ from `active`.
 */
export function pickActivePlans(rows, today) {
  const activeAll = (rows ?? [])
    .filter((m) => m.status === "active" && m.end_date && m.end_date >= today)
    .sort(
      (a, b) =>
        (b.credits_remaining > 0) - (a.credits_remaining > 0) ||
        String(a.end_date).localeCompare(String(b.end_date)) ||
        String(a.created_at).localeCompare(String(b.created_at))
    );
  const recurring =
    activeAll
      .filter((m) => Number(m.plan?.recurring_slots_per_week ?? 0) > 0)
      .sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)))[0] ?? null;
  return { active: activeAll[0], recurring };
}

export function useMembershipStatus(userId) {
  const [membership, setMembership] = useState({ ...emptySection, kind: "none", record: null, plan: null, recurring: null });

  const load = useCallback(async () => {
    if (!userId) return;
    setMembership((s) => ({ ...s, status: "loading", error: null }));

    const { data, error } = await supabase
      .from("memberships")
      .select("*, plan:membership_plans(*)")
      .eq("user_id", userId)
      .order("end_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (error) {
      setMembership({ status: "error", error: error.message, kind: "none", record: null, plan: null, recurring: null });
      return;
    }

    const rows = data ?? [];
    // IST business date (todayISODate now resolves in Asia/Kolkata) so this
    // active-vs-lapsed split can't disagree with book_class() /
    // member_booking_eligibility() around the IST midnight boundary. This
    // is only a display categorisation — the server re-checks validity on
    // every booking regardless of what card the dashboard shows.
    const today = todayISODate();

    const { active, recurring } = pickActivePlans(rows, today);
    const pending = rows.find((m) => m.status === "pending_payment");
    const lapsed = rows.find(
      (m) =>
        m.status === "expired" ||
        m.status === "cancelled" ||
        m.status === "suspended" ||
        (m.status === "active" && m.end_date && m.end_date < today)
    );

    const chosen = active ?? pending ?? lapsed ?? null;
    const kind = active ? "active" : pending ? "pending" : lapsed ? "lapsed" : "none";

    setMembership({
      status: "ready",
      error: null,
      kind,
      record: chosen,
      plan: chosen?.plan ?? null,
      recurring,
    });
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    load();
  }, [userId, load]);

  return { ...membership, retry: load };
}
