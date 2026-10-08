import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_TIMEOUT_MS, clearActivity, isIdleExpired, markActivity, readActivity, startIdleWatch } from "./idleSession";

function stubBrowser() {
  const store = new Map();
  const listeners = {};
  const win = {
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    addEventListener: (e, fn) => ((listeners[e] ??= []).push(fn)),
    removeEventListener: (e, fn) => (listeners[e] = (listeners[e] ?? []).filter((f) => f !== fn)),
    setInterval: (...a) => setInterval(...a),
    clearInterval: (...a) => clearInterval(...a),
  };
  const doc = { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  return { fire: (e) => (listeners[e] ?? []).forEach((f) => f()) };
}

describe("idle timeout", () => {
  it("is 15 minutes", () => expect(IDLE_TIMEOUT_MS).toBe(900000));

  it("isIdleExpired: boundary and missing timestamp", () => {
    expect(isIdleExpired(1000, 1000 + IDLE_TIMEOUT_MS - 1)).toBe(false);
    expect(isIdleExpired(1000, 1000 + IDLE_TIMEOUT_MS)).toBe(true);
    expect(isIdleExpired(null, 99999999)).toBe(false);
  });
});

describe("startIdleWatch", () => {
  let env;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T09:00:00Z"));
    env = stubBrowser();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("expires silently after 15 idle minutes, exactly once", () => {
    const onExpire = vi.fn();
    startIdleWatch(onExpire);
    vi.advanceTimersByTime(14 * 60 * 1000);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("user input keeps the session alive; the clock restarts from the last input", () => {
    const onExpire = vi.fn();
    startIdleWatch(onExpire);
    vi.advanceTimersByTime(10 * 60 * 1000);
    env.fire("pointerdown");
    vi.advanceTimersByTime(10 * 60 * 1000); // 20 min since login, 10 since input
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(6 * 60 * 1000); // 16 min since input
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("a stale timestamp (user returns after closing the tab) expires immediately", () => {
    markActivity(Date.now() - 16 * 60 * 1000);
    const onExpire = vi.fn();
    startIdleWatch(onExpire);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("input after the deadline cannot resurrect an expired session", () => {
    const onExpire = vi.fn();
    startIdleWatch(onExpire, { timeout: 60000 });
    vi.setSystemTime(Date.now() + 61000);
    env.fire("keydown");
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("clearActivity removes the stored timestamp", () => {
    markActivity();
    expect(readActivity()).not.toBeNull();
    clearActivity();
    expect(readActivity()).toBeNull();
  });
});
