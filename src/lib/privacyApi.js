import { supabase } from "./supabaseClient";
import { friendlyPrivacyError } from "./privacyLogic";

/**
 * The privacy calls (supabase/proposals/0030_privacy_foundation.sql). Every one
 * runs as the signed-in person: the server takes WHO from the session and WHEN
 * from its own clock, so nothing here can name another member or backdate
 * anything. Each resolves to { data, error } with a plain-language error.
 */

async function rpc(name, args) {
  if (!supabase) return { data: null, error: "The site is not connected to the club's servers." };
  const { data, error } = await supabase.rpc(name, args);
  return { data: error ? null : data, error: error ? friendlyPrivacyError(error) : null };
}

// Public (signed out is fine)
export const getNotice = () => rpc("current_privacy_notice", { p_language: "en" });
export const getPublicConfig = () => rpc("public_privacy_config");

// Member
export const getMyConsents = () => rpc("my_consents");
export const recordConsent = (purpose, action, noticeVersion = null) =>
  rpc("record_consent", { p_purpose: purpose, p_action: action, p_notice_version: noticeVersion, p_source: "web" });
export const submitRequest = ({ type, subject, details }) =>
  rpc("submit_privacy_request", { p_type: type, p_subject: subject?.trim() || null, p_details: details?.trim() || null });
export const getMyRequests = () => rpc("my_privacy_requests");
export const cancelRequest = (id) => rpc("cancel_my_privacy_request", { p_id: id });
export const exportMyData = () => rpc("export_my_data");

/** Hands a JSON copy of the member's data to the browser as a file download. */
export function downloadJson(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
