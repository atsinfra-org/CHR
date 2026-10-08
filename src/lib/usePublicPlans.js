import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

/**
 * The three memberships as sold in the store, read live from
 * membership_plans (active plans are publicly readable), so the public
 * pages can never drift from what the store charges. FALLBACK mirrors the
 * current plans and is only shown if that read fails.
 */
export const FALLBACK_PLANS = [
  { plan_code: "ONE_TIME_RIDE", name: "One-Time Ride", price: 2000, class_credits: 1, validity_days: 30, reschedules_allowed: 1 },
  { plan_code: "GOLD", name: "Gold Membership", price: 15000, class_credits: 8, validity_days: 30, reschedules_allowed: 2 },
  { plan_code: "PLATINUM", name: "Platinum Membership", price: 18000, class_credits: 12, validity_days: 30, reschedules_allowed: 2 },
];

export function usePublicPlans() {
  const [plans, setPlans] = useState(FALLBACK_PLANS);

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    supabase
      .from("membership_plans")
      .select("plan_code, name, price, class_credits, validity_days, reschedules_allowed")
      .not("plan_code", "is", null)
      .eq("is_active", true)
      .order("price")
      .then(({ data, error }) => {
        if (active && !error && data?.length) setPlans(data.map((p) => ({ ...p, price: Number(p.price) })));
      });
    return () => {
      active = false;
    };
  }, []);

  return plans;
}
