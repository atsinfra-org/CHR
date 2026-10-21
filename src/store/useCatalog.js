import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { STORE_CATEGORIES } from "./storeConfig";
import { mergeTackDetails } from "./tackCatalog";

/**
 * The store catalog, from store_catalog() (prices and "can it be bought" resolved server-side), joined with the Tack
 * Shop display details from store_tack_details() (categories, photos, specifications, sizes). Both are read live, so an
 * administrator's change shows on the next visit without a redeploy. If the details call is missing or fails, the store
 * still works with the built-in photos.
 */
export function useCatalog(enabled = true) {
  const [state, setState] = useState({ status: "idle", error: null, products: [], details: null });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: "loading", error: null }));
    const [catalog, details] = await Promise.all([supabase.rpc("store_catalog"), supabase.rpc("store_tack_details")]);
    if (catalog.error) {
      setState({ status: "error", error: catalog.error.message, products: [], details: null });
      return;
    }
    const tackDetails = details.error ? null : details.data ?? null;
    // Only categories the store currently offers; others (café) are hidden.
    const products = (catalog.data ?? []).filter((p) => STORE_CATEGORIES.includes(p.category));
    setState({ status: "ready", error: null, products: mergeTackDetails(products, tackDetails), details: tackDetails });
  }, []);

  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);

  return { ...state, retry: load };
}
