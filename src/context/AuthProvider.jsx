import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { supabase, supabaseConfigured } from "../lib/supabaseClient";
import { clearActivity, startIdleWatch } from "../lib/idleSession";

/** @typedef {import("../lib/database.types").Profile} Profile */

// Explicit auth status — every consumer branches on this rather than
// inferring "loading" from session/profile both being null, which is
// genuinely ambiguous (also true right after a real logout).
export const AUTH_LOADING = "loading";
export const AUTHENTICATED = "authenticated";
export const UNAUTHENTICATED = "unauthenticated";

const AuthContext = createContext(null);

/**
 * Single shared session + profile subscription for the whole app — mounted
 * around /admin and /account only (see main.jsx), not the public marketing
 * site, which has no use for auth state today.
 *
 * Session -> auth.users comes from Supabase Auth (supabase.auth.*); profile
 * -> public.profiles is fetched once per distinct user id, not on every
 * render or every token-refresh event, via the loadedForUserId guard below.
 */
export function AuthProvider({ children }) {
  const [status, setStatus] = useState(AUTH_LOADING);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  // idle: no user yet. loading: fetching. ready: fetched (profile may still
  // be null — see AccountApp's "profile missing" handling). error: the
  // query itself failed (network, etc.) — distinct from "no row found".
  const [profileStatus, setProfileStatus] = useState("idle");
  const [profileError, setProfileError] = useState(null);
  const loadedForUserId = useRef(null);

  const loadProfile = useCallback(async (userId, { force = false } = {}) => {
    if (!userId) {
      loadedForUserId.current = null;
      setProfile(null);
      setProfileStatus("idle");
      setProfileError(null);
      return;
    }
    if (!force && loadedForUserId.current === userId) return;
    loadedForUserId.current = userId;
    setProfileStatus("loading");
    setProfileError(null);

    const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();

    if (error) {
      setProfileStatus("error");
      setProfileError(error.message);
      return;
    }
    setProfile(data ?? null);
    setProfileStatus("ready");
  }, []);

  useEffect(() => {
    if (!supabaseConfigured) {
      setStatus(UNAUTHENTICATED);
      return;
    }

    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setStatus(data.session ? AUTHENTICATED : UNAUTHENTICATED);
      if (data.session?.user?.id) loadProfile(data.session.user.id);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setStatus(nextSession ? AUTHENTICATED : UNAUTHENTICATED);
      loadProfile(nextSession?.user?.id ?? null);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [loadProfile]);

  // 15-minute inactivity timeout. Silent: no warning, no countdown. On expiry
  // the Supabase session is revoked (global sign-out invalidates the refresh
  // token server-side), AuthProvider flips to UNAUTHENTICATED and every page
  // shows its existing login. Background polling does not count as activity.
  useEffect(() => {
    if (status !== AUTHENTICATED) return undefined;
    return startIdleWatch(async () => {
      const { error } = await supabase.auth.signOut();
      if (error) await supabase.auth.signOut({ scope: "local" });
      clearActivity();
    });
  }, [status]);

  const refreshProfile = useCallback(() => {
    if (session?.user?.id) loadProfile(session.user.id, { force: true });
  }, [session, loadProfile]);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    clearActivity();
    return { error: error?.message ?? null };
  }, []);

  const value = {
    configured: supabaseConfigured,
    status,
    session,
    user: session?.user ?? null,
    /** @type {Profile | null} */
    profile,
    role: profile?.role ?? null,
    profileStatus,
    profileError,
    refreshProfile,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
