import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { sessionInstant, todayISODate } from "./dashboardUtils";
import { useMembershipStatus } from "./useMembershipStatus";

const ACTIVE_BOOKING_STATUSES = ["held", "confirmed"];

const emptySection = { status: "idle", error: null };

/**
 * All Supabase reads the member dashboard needs, in one place, so no two
 * panels issue the same query independently. Identity (session/profile)
 * still comes from useAuth()/AuthProvider — this hook only owns
 * dashboard-specific data: the plan, this week's usage, upcoming classes,
 * class history, and a few small extras (an order awaiting confirmation,
 * classes ridden so far, the cancellation policy).
 *
 * Every section tracks its own status/error/retry so one failed query never
 * blanks out the sections that loaded fine.
 *
 * This is a read-only VIEW of database state. It does not decide whether a
 * booking is allowed and does not touch the ledger.
 */
export function useMemberDashboard(userId) {
  const membership = useMembershipStatus(userId);
  const [weekly, setWeekly] = useState({ ...emptySection, data: null });
  const [upcoming, setUpcoming] = useState({ ...emptySection, bookings: [] });
  const [history, setHistory] = useState({ ...emptySection, items: [] });
  const [extras, setExtras] = useState({ pendingOrder: null, ridden: null, cancellationReturnsClass: false });

  const loadWeekly = useCallback(async () => {
    if (membership.kind !== "active" || !membership.record?.id) return;
    setWeekly((s) => ({ ...s, status: "loading", error: null }));

    // The database is the sole source of truth for the weekly block (dates,
    // limit, usage) — public.member_current_block_usage() shares its
    // arithmetic with book_class(). React only formats what it returns.
    const { data, error } = await supabase.rpc("member_current_block_usage");

    if (error) {
      setWeekly({ status: "error", error: error.message, data: null });
      return;
    }

    const row = data?.[0];
    if (!row) {
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
      .select("id, status, session_id, reschedule_count, class_sessions!inner(session_date, start_time, end_time)")
      .eq("user_id", userId)
      .in("status", ACTIVE_BOOKING_STATUSES)
      .gte("class_sessions.session_date", todayISODate())
      .order("session_date", { foreignTable: "class_sessions", ascending: true })
      .order("start_time", { foreignTable: "class_sessions", ascending: true })
      .limit(12);

    if (error) {
      setUpcoming({ status: "error", error: error.message, bookings: [] });
      return;
    }
    // PostgREST orders the embedded rows, not the parents — sort here so the
    // first entry really is the next class, and drop classes that have
    // already finished today (they move to history once attendance is marked).
    const now = Date.now();
    const sorted = [...(data ?? [])]
      .filter((b) => sessionInstant(b.class_sessions.session_date, b.class_sessions.end_time) > now)
      .sort((a, b) => {
        const ka = `${a.class_sessions.session_date} ${a.class_sessions.start_time}`;
        const kb = `${b.class_sessions.session_date} ${b.class_sessions.start_time}`;
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
    setUpcoming({ status: "ready", error: null, bookings: sorted });
  }, [userId]);

  const loadHistory = useCallback(async () => {
    if (!userId) return;
    setHistory((s) => ({ ...s, status: "loading", error: null }));
    // Closed bookings with the ledger rows recorded against each (append-only),
    // which is what tells "class returned" from "class not returned".
    const { data, error } = await supabase
      .from("bookings")
      .select("id, status, reschedule_count, class_sessions!inner(session_date, start_time, end_time), credit_ledger(amount, transaction_type)")
      .eq("user_id", userId)
      .in("status", ["completed", "absent", "no_show", "rescheduled", "cancelled"])
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) {
      setHistory({ status: "error", error: error.message, items: [] });
      return;
    }
    const sorted = [...(data ?? [])].sort((a, b) => {
      const ka = `${a.class_sessions.session_date} ${a.class_sessions.start_time}`;
      const kb = `${b.class_sessions.session_date} ${b.class_sessions.start_time}`;
      return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
    setHistory({ status: "ready", error: null, items: sorted });
  }, [userId]);

  // Small, non-critical reads: if any fails the dashboard simply omits it.
  const loadExtras = useCallback(async () => {
    if (!userId) return;
    const [orders, ridden, setting] = await Promise.all([
      supabase
        .from("orders")
        .select("id, status, total_amount, has_membership, created_at, order_items(name, category)")
        .eq("user_id", userId)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1),
      supabase.from("bookings").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "completed"),
      supabase.from("system_settings").select("value").eq("key", "cancellation_returns_credit").maybeSingle(),
    ]);
    setExtras({
      pendingOrder: orders.error ? null : (orders.data?.[0] ?? null),
      ridden: ridden.error ? null : (ridden.count ?? null),
      cancellationReturnsClass: !setting.error && setting.data?.value === true,
    });
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    loadUpcoming();
    loadHistory();
    loadExtras();
  }, [userId, loadUpcoming, loadHistory, loadExtras]);

  useEffect(() => {
    if (membership.status !== "ready") return;
    if (membership.kind === "active") {
      loadWeekly();
    } else {
      setWeekly({ ...emptySection, status: "ready", data: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membership.status, membership.kind, membership.record?.id]);

  // After a move or a cancellation everything on the page may have changed.
  const refreshAll = useCallback(() => {
    membership.retry();
    loadWeekly();
    loadUpcoming();
    loadHistory();
    loadExtras();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membership.retry, loadWeekly, loadUpcoming, loadHistory, loadExtras]);

  return {
    membership,
    weekly: { ...weekly, retry: loadWeekly },
    upcoming: { ...upcoming, retry: loadUpcoming },
    history: { ...history, retry: loadHistory },
    extras,
    refreshAll,
  };
}
