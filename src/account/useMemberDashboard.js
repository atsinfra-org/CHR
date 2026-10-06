import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { todayISODate } from "./dashboardUtils";
import { useMembershipStatus } from "./useMembershipStatus";

const ACTIVE_BOOKING_STATUSES = ["held", "confirmed"];

const emptySection = { status: "idle", error: null };

/**
 * All Supabase reads the member dashboard needs, in one place, so no two
 * cards issue the same query independently. Identity (session/profile)
 * still comes from useAuth()/AuthProvider — this hook only owns
 * dashboard-specific data: membership, this block's usage, upcoming
 * bookings, and recent credit-ledger activity.
 *
 * Every section tracks its own status/error/retry so one failed query never
 * blanks out the sections that loaded fine (see phase 4.2 brief §13).
 *
 * This is a read-only VIEW of database state. It does not decide whether a
 * booking is allowed, does not activate memberships, and does not touch the
 * credit ledger — those remain book_class()/activate_membership()'s job.
 */
export function useMemberDashboard(userId) {
  const membership = useMembershipStatus(userId);
  const [weekly, setWeekly] = useState({ ...emptySection, data: null });
  const [upcoming, setUpcoming] = useState({ ...emptySection, bookings: [] });
  const [activity, setActivity] = useState({ ...emptySection, items: [] });

  const loadWeekly = useCallback(async () => {
    if (membership.kind !== "active" || !membership.record?.id) return;
    setWeekly((s) => ({ ...s, status: "loading", error: null }));

    // The database is the sole source of truth for the membership block
    // definition (block dates, weekly limit, usage) — see
    // public.member_current_block_usage() in
    // supabase/proposals/0007_member_block_usage.sql. It shares the same
    // system_settings-backed constants and the same arithmetic as
    // book_class() itself, so the two can never disagree. React only formats
    // whatever this RPC returns; it does not compute any of it.
    const { data, error } = await supabase.rpc("member_current_block_usage");

    if (error) {
      setWeekly({ status: "error", error: error.message, data: null });
      return;
    }

    const row = data?.[0];
    if (!row) {
      // No row back (e.g. membership lapsed between the two queries) —
      // treat like "nothing to show" rather than a hard error.
      setWeekly({ status: "ready", error: null, data: null });
      return;
    }

    setWeekly({
      status: "ready",
      error: null,
      data: {
        blockStart: row.current_block_start,
        blockEnd: row.current_block_end,
        max: row.block_class_limit,
        used: row.block_classes_used,
        remaining: row.block_classes_remaining,
      },
    });
  }, [membership.kind, membership.record?.id]);

  const loadUpcoming = useCallback(async () => {
    if (!userId) return;
    setUpcoming((s) => ({ ...s, status: "loading", error: null }));

    const { data, error } = await supabase
      .from("bookings")
      .select("id, status, class_sessions!inner(session_date, start_time, end_time), horses(name)")
      .eq("user_id", userId)
      .in("status", ACTIVE_BOOKING_STATUSES)
      .gte("class_sessions.session_date", todayISODate())
      .order("session_date", { foreignTable: "class_sessions", ascending: true })
      .order("start_time", { foreignTable: "class_sessions", ascending: true })
      .limit(10);

    if (error) {
      setUpcoming({ status: "error", error: error.message, bookings: [] });
      return;
    }
    setUpcoming({ status: "ready", error: null, bookings: data ?? [] });
  }, [userId]);

  const loadActivity = useCallback(async () => {
    if (!userId) return;
    setActivity((s) => ({ ...s, status: "loading", error: null }));

    const { data, error } = await supabase
      .from("credit_ledger")
      .select("id, amount, transaction_type, description, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(8);

    if (error) {
      setActivity({ status: "error", error: error.message, items: [] });
      return;
    }
    setActivity({ status: "ready", error: null, items: data ?? [] });
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    loadUpcoming();
    loadActivity();
  }, [userId, loadUpcoming, loadActivity]);

  useEffect(() => {
    if (membership.status !== "ready") return;
    if (membership.kind === "active") {
      loadWeekly();
    } else {
      setWeekly({ ...emptySection, status: "ready", data: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membership.status, membership.kind, membership.record?.id]);

  return {
    membership,
    weekly: { ...weekly, retry: loadWeekly },
    upcoming: { ...upcoming, retry: loadUpcoming },
    activity: { ...activity, retry: loadActivity },
  };
}
