import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { STORE_CATEGORIES } from "./storeConfig";

/** The store catalog, from the store_catalog() RPC (prices resolved server-side). */
export function useCatalog(enabled = true) {
  const [state, setState] = useState({ status: "idle", error: null, products: [] });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: "loading", error: null }));
    const { data, error } = await supabase.rpc("store_catalog");
    if (error) {
      setState({ status: "error", error: error.message, products: [] });
      return;
    }
    // Only categories the store currently offers; others (café) are hidden.
    setState({ status: "ready", error: null, products: (data ?? []).filter((p) => STORE_CATEGORIES.includes(p.category)) });
  }, []);

  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);

  return { ...state, retry: load };
}
