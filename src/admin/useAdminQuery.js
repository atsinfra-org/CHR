import { useCallback, useEffect, useState } from "react";

/**
 * Generic read hook for the admin surface. `queryFn` receives no args and
 * returns a Supabase query (or any promise resolving to { data, error }).
 * Reads are scoped by the existing "Staff/admin read all ..." RLS policies —
 * this hook adds nothing to authorization, it only manages request state.
 *
 * `deps` re-runs the query when they change; `reload()` forces a refetch.
 */
export function useAdminQuery(queryFn, deps = []) {
  const [state, setState] = useState({ status: "loading", error: null, data: null });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(queryFn, deps);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: "loading", error: null }));
    const { data, error } = await run();
    if (error) {
      setState({ status: "error", error: error.message ?? String(error), data: null });
      return;
    }
    setState({ status: "ready", error: null, data: data ?? null });
  }, [run]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}
