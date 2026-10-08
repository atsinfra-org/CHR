import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

/**
 * Whether the online payment gateway is switched on (system_settings
 * online_payments_enabled). Fails SAFE: anything other than an explicit
 * `true` — including a read error — means "not enabled", so checkout falls
 * back to placing a pending order instead of dead-ending in a gateway call.
 */
export function useOnlinePayments() {
  const [state, setState] = useState({ status: "loading", enabled: false });

  useEffect(() => {
    let active = true;
    supabase
      .from("system_settings")
      .select("value")
      .eq("key", "online_payments_enabled")
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        setState({ status: error ? "error" : "ready", enabled: !error && data?.value === true });
      });
    return () => {
      active = false;
    };
  }, []);

  return state;
}
