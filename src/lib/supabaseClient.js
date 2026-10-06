import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);

if (!supabaseConfigured && import.meta.env.DEV) {
  // eslint-disable-next-line no-console
  console.warn(
    "[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — " +
      "enquiry submissions and the admin dashboard won't work until you add " +
      "them to .env.local (see .env.example) and restart the dev server."
  );
}

/**
 * `null` when unconfigured, so callers can fail gracefully instead of
 * crashing on a missing env var during setup.
 */
export const supabase = supabaseConfigured ? createClient(url, anonKey) : null;
