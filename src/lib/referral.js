import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

const REF_KEY = "csf-ref";
const CODE_SHAPE = /^[A-Za-z0-9]{4,12}$/;

/** Remembers a code from an invite link (?ref=CODE) until the visitor signs in. */
export function captureReferralFromUrl() {
  try {
    const code = new URLSearchParams(window.location.search).get("ref");
    if (code && CODE_SHAPE.test(code)) window.localStorage.setItem(REF_KEY, code.toUpperCase());
  } catch {
    // storage blocked — the invite simply is not remembered
  }
}

/**
 * After sign-in: hand any remembered code to the database, which decides
 * whether it counts (first-time customer, someone else's code). The answer is
 * not shown to the visitor; the code is forgotten either way.
 */
export async function claimRememberedReferral() {
  let code = null;
  try {
    code = window.localStorage.getItem(REF_KEY);
  } catch {
    return;
  }
  if (!code) return;
  const { error } = await supabase.rpc("claim_referral", { p_code: code });
  if (error?.code === "PGRST202") return; // database update not applied yet: keep the code for later
  try {
    window.localStorage.removeItem(REF_KEY);
  } catch {
    // ignore
  }
}

/** The member's invite link and wallet balance. `available` is false until the database update is applied. */
export function useWallet() {
  const [state, setState] = useState({ status: "loading", available: false, balance: 0, code: null });

  const load = useCallback(async () => {
    const [bal, code] = await Promise.all([supabase.rpc("my_wallet_balance"), supabase.rpc("my_referral_code")]);
    if (bal.error || code.error) {
      setState({ status: "ready", available: false, balance: 0, code: null });
      return;
    }
    setState({ status: "ready", available: true, balance: Number(bal.data) || 0, code: code.data });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}

export const inviteLink = (code) => `${window.location.origin}/?ref=${code}`;

export const inviteMessage = (code) =>
  `Come riding with me at Colonel Horse Riding Club! Join with my link: ${inviteLink(code)}`;
