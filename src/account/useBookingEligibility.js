import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

const empty = { status: "idle", error: null, data: null };

/**
 * The ONE authoritative source for the booking page's "what can I book"
 * envelope — membership dates, credits, the eligible booking date range
 * (already clamped to min(booking_window, membership.end_date) server-
 * side), and current weekly-block usage. See
 * public.member_booking_eligibility() (Phase 4.5 —
 * supabase/proposals/0010_booking_security_and_rules.sql). React performs
 * no date-range or eligibility arithmetic of its own — book_class() is
 * still what actually decides whether any given booking is allowed.
 */
export function useBookingEligibility(userId) {
  const [state, setState] = useState(empty);

  const load = useCallback(async () => {
    if (!userId) return;
    setState((s) => ({ ...s, status: "loading", error: null }));
    const { data, error } = await supabase.rpc("member_booking_eligibility");
    if (error) {
      setState({ status: "error", error: error.message, data: null });
      return;
    }
    setState({ status: "ready", error: null, data: data?.[0] ?? null });
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    load();
  }, [userId, load]);

  return { ...state, retry: load };
}
