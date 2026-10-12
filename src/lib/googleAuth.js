import { useCallback, useEffect, useState } from "react";
import { supabase, supabaseConfigured } from "./supabaseClient";
import { markActivity } from "./idleSession";

/**
 * "Sign in with Google", through Supabase Auth. One button does both jobs:
 * Supabase signs an existing rider in and creates the account for a new one
 * (handle_new_user() fills the profile from the name Google supplies).
 *
 * Google has to be switched on for the project first (Supabase →
 * Authentication → Sign In / Providers → Google). Until it is, the button is
 * not offered at all, because Supabase answers a click with a bare error
 * page. Whether it is on is public information, asked once per page load.
 *
 * A Google sign-in leaves the site and comes back, so nothing held in memory
 * survives it. The one thing that has to carry over is a note, kept in
 * sessionStorage (this tab only), that the trip was started here.
 */
export const AFTER_GOOGLE_PATH = "/account";

const PENDING_KEY = "csf-google-signin";
const PENDING_MAX_AGE_MS = 30 * 60 * 1000;
const RETURN_ERROR_KEYS = ["error", "error_code", "error_description"];

let enabledOnce = null;

/** Resolves true when the project accepts Google sign-in. Never rejects. */
export function googleSignInEnabled() {
  if (!supabaseConfigured) return Promise.resolve(false);
  if (!enabledOnce) {
    enabledOnce = fetch(`${import.meta.env.VITE_SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((settings) => settings?.external?.google === true)
      .catch(() => false);
  }
  return enabledOnce;
}

function notePending() {
  try {
    window.sessionStorage.setItem(PENDING_KEY, String(Date.now()));
  } catch {
    /* storage blocked: the return is then handled like any other sign-in */
  }
}

function clearPending() {
  try {
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

function hasPending() {
  try {
    const at = Number(window.sessionStorage.getItem(PENDING_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < PENDING_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * Sends the browser to Google. On success the page is already leaving; the
 * returned error is only set when the trip could not be started.
 */
export async function startGoogleSignIn() {
  // The same stamp a password sign-in leaves, so the idle timeout does not
  // close the new session the moment the rider comes back.
  markActivity();
  notePending();
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}${AFTER_GOOGLE_PATH}`,
        // Always ask which Google account, so a shared family device does
        // not sign the wrong person in without a word.
        queryParams: { prompt: "select_account" },
      },
    });
    if (!error) return { error: null };
  } catch {
    /* fall through to the message below */
  }
  clearPending();
  return { error: "We couldn't open Google sign-in just now. Please try again, or use your email and password." };
}

/**
 * Call with the session whenever it becomes known. Right after a Google
 * sign-in that began in this tab, the rider is taken to their dashboard
 * wherever Supabase sent them back to: it falls back to the site's home page
 * when the return address is not on its allow list. Returns true when it is
 * navigating away.
 */
export function completeGoogleReturn(session) {
  if (!session || !hasPending()) return false;
  clearPending();
  markActivity();
  if (window.location.pathname.startsWith(AFTER_GOOGLE_PATH)) return false;
  window.location.replace(AFTER_GOOGLE_PATH);
  return true;
}

/**
 * Pure: does this address carry a failed sign-in? Supabase reports one in
 * the query string, the fragment, or both.
 */
export function hasReturnError(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  return RETURN_ERROR_KEYS.some((key) => url.searchParams.has(key) || fragment.has(key));
}

/** Pure: the same address without the failure details (other parameters are kept). */
export function withoutReturnError(href) {
  const url = new URL(href);
  RETURN_ERROR_KEYS.forEach((key) => url.searchParams.delete(key));
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  if (RETURN_ERROR_KEYS.some((key) => fragment.has(key))) url.hash = "";
  return `${url.pathname}${url.search}${url.hash}`;
}

let returnError;

/**
 * The message to show when the rider has just come back from Google without
 * being signed in (they pressed Cancel, or Google or Supabase refused), or
 * null. Read once per page load; the details are then removed from the
 * address bar so a refresh does not show the message again.
 *
 * Other links can come back with an error too (an expired password-reset
 * email, say). Those were not started here, so they are left alone.
 */
export function googleReturnError() {
  if (returnError !== undefined) return returnError;
  returnError = null;
  if (typeof window === "undefined" || !hasReturnError(window.location.href) || !hasPending()) return returnError;
  clearPending();
  returnError = "Google sign-in didn't go through. Please try again, or use your email and password.";
  try {
    window.history.replaceState(window.history.state, "", withoutReturnError(window.location.href));
  } catch {
    /* the message still shows; only the address bar keeps the details */
  }
  return returnError;
}

/**
 * For a sign-in form: whether to offer Google, whether a trip to Google has
 * started, and the function that starts one.
 */
export function useGoogleSignIn() {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    googleSignInEnabled().then((on) => live && setAvailable(on));
    // Coming back with the browser's Back button can restore this page as it
    // was left, button still spinning.
    const onShow = (e) => e.persisted && setBusy(false);
    window.addEventListener("pageshow", onShow);
    return () => {
      live = false;
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  const start = useCallback(async () => {
    setBusy(true);
    const { error } = await startGoogleSignIn();
    if (error) setBusy(false);
    return { error };
  }, []);

  return { available, busy, start };
}
