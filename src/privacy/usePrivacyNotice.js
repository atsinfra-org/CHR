import { useCallback, useEffect, useState } from "react";
import { getNotice, getPublicConfig } from "../lib/privacyApi";

/**
 * The privacy notice and the club's contact details, read from the server so
 * the website and the app always show the same thing. `state` is
 * loading | ready | error; a failed read is never shown as "no notice".
 */
export function usePrivacyNotice() {
  const [s, setS] = useState({ state: "loading", notice: null, config: null, error: null });

  const load = useCallback(async () => {
    setS((x) => ({ ...x, state: "loading", error: null }));
    const [n, c] = await Promise.all([getNotice(), getPublicConfig()]);
    if (n.error) return setS({ state: "error", notice: null, config: null, error: n.error });
    setS({ state: "ready", notice: n.data, config: c.error ? null : c.data, error: null });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { ...s, reload: load };
}
