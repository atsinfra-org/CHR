/**
 * Client-side auth input helpers. Deliberately permissive: this only catches
 * obvious typos before a network call. The authority on whether an address is
 * acceptable is always Supabase Auth.
 */

/**
 * Trims, lower-cases and removes characters that look like nothing but break
 * validation — spaces (including non-breaking), zero-width characters and the
 * byte-order mark, which commonly ride along when an address is pasted.
 */
export function normalizeEmail(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\s ​-‍⁠﻿]/g, "")
    .toLowerCase();
}

// local@domain.tld — at least one dot in the domain, no empty labels, TLD of 2+ chars.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/;

export function isValidEmail(value) {
  return EMAIL_RE.test(normalizeEmail(value));
}

export const MIN_PASSWORD_LENGTH = 6;

/** Returns `{ field: message }` for every problem found; empty object means valid. */
export function validateAuthForm(mode, { fullName = "", email = "", password = "", confirm = "" }) {
  const errors = {};
  if (mode === "register" && !fullName.trim()) errors.fullName = "Please enter your full name.";
  if (mode !== "reset") {
    if (!normalizeEmail(email)) errors.email = "Please enter your email address.";
    else if (!isValidEmail(email)) errors.email = "Please enter a valid email address.";
  }
  if (mode !== "forgot") {
    if (!password) errors.password = "Please enter your password.";
    else if ((mode === "register" || mode === "reset") && password.length < MIN_PASSWORD_LENGTH)
      errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if ((mode === "register" || mode === "reset") && !errors.password && confirm !== password) {
    errors.confirm = "The two passwords don't match.";
  }
  return errors;
}

/** Member-facing wording for Supabase Auth errors. Never shows raw server text. */
export function friendlyAuthError(error, mode = "login") {
  const msg = error?.message ?? "";
  if (/invalid login credentials/i.test(msg))
    return "We couldn't sign you in with those details. Please check your email and password and try again.";
  if (/email not confirmed/i.test(msg)) return "Please confirm your email address first — check your inbox for the link.";
  if (/already registered|already been registered|user already exists/i.test(msg))
    return "An account with this email already exists. Try signing in instead.";
  if (/(email address .* is invalid|invalid email|email_address_invalid|unable to validate email)/i.test(msg))
    return "We couldn't use that email address. Please check it for typos, or try a different one.";
  if (/password should be at least|weak password|password is too/i.test(msg))
    return "That password is too weak. Please use at least 6 characters.";
  if (/email rate limit|over_email_send_rate_limit|email.*rate/i.test(msg))
    return "We've sent the maximum number of emails for now. Please try again in about an hour, or sign in if you already have an account.";
  if (/rate limit|too many/i.test(msg)) return "Too many attempts — please wait a moment and try again.";
  if (/failed to fetch|network|fetch/i.test(msg)) return "Network error — please check your connection and try again.";
  if (mode === "register") return "We couldn't create your account with those details. Please check them and try again.";
  if (mode === "login") return "We couldn't sign you in right now. Please try again.";
  return "Something went wrong. Please try again.";
}
