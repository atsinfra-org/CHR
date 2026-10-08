/**
 * Inactivity timeout (15 minutes). Silent by design: no warning, countdown or
 * banner. "Activity" means real user input (pointer, key, touch, wheel) — NOT
 * network traffic, because the app polls in the background (availability,
 * notifications) and that must never keep a session alive.
 *
 * The timestamp lives in localStorage purely so every tab and a returning
 * visitor agree on when the user last did something. It is not a secret and
 * it does not authenticate anything; when it is stale the Supabase session is
 * revoked with signOut() (see AuthProvider), which invalidates the refresh
 * token on the server.
 */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const KEY = "csf-last-activity";
const WRITE_THROTTLE_MS = 5000;
const CHECK_EVERY_MS = 15000;
const EVENTS = ["pointerdown", "keydown", "touchstart", "wheel"];

export function markActivity(at = Date.now()) {
  try {
    window.localStorage.setItem(KEY, String(at));
  } catch {
    /* storage blocked: the watcher then falls back to in-memory time */
  }
}

export function clearActivity() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function readActivity() {
  try {
    const v = Number(window.localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Pure: has the idle period elapsed since `last` (ms epoch)? */
export function isIdleExpired(last, now = Date.now(), timeout = IDLE_TIMEOUT_MS) {
  return last != null && now - last >= timeout;
}

/**
 * Watches for inactivity while a session exists. Calls `onExpire` once when
 * the user has been idle for `timeout` (also immediately if the stored
 * timestamp is already stale, e.g. the user comes back after closing the
 * tab). Returns a cleanup function.
 */
export function startIdleWatch(onExpire, { timeout = IDLE_TIMEOUT_MS } = {}) {
  let memoryLast = readActivity() ?? Date.now();
  let lastWrite = 0;
  let fired = false;

  if (readActivity() == null) markActivity(memoryLast);

  const expire = () => {
    if (fired) return;
    fired = true;
    onExpire();
  };

  const check = () => {
    const last = readActivity() ?? memoryLast;
    if (isIdleExpired(last, Date.now(), timeout)) expire();
  };

  const onInput = () => {
    const now = Date.now();
    // Input after the deadline must not resurrect an expired session.
    if (isIdleExpired(readActivity() ?? memoryLast, now, timeout)) return check();
    memoryLast = now;
    if (now - lastWrite >= WRITE_THROTTLE_MS) {
      lastWrite = now;
      markActivity(now);
    }
  };

  const onVisible = () => document.visibilityState === "visible" && check();

  EVENTS.forEach((e) => window.addEventListener(e, onInput, { passive: true, capture: true }));
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", check);
  const timer = window.setInterval(check, CHECK_EVERY_MS);
  check(); // returning after a long absence

  return () => {
    EVENTS.forEach((e) => window.removeEventListener(e, onInput, { capture: true }));
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", check);
    window.clearInterval(timer);
  };
}
