import { supabase } from "../lib/supabaseClient";

/**
 * Every admin mutation goes through one of the Phase 4.6 SECURITY DEFINER
 * RPCs (supabase/proposals/0014_admin_operations.sql), never a direct
 * table write. Each RPC re-checks is_admin()/is_staff_or_admin() server-
 * side, runs in a single transaction, and writes public.audit_logs. This
 * module is the only place the admin UI names those RPCs.
 *
 * Each call resolves to { data, error } where `error` is null on success or
 * a human-readable string mapped from the RPC's structured error code.
 */

const MESSAGES = {
  NOT_AUTHORIZED: "You don't have permission to do that.",
  INVALID_ROLE: "That isn't a valid role.",
  REASON_REQUIRED: "A reason is required.",
  USER_NOT_FOUND: "That user no longer exists.",
  LAST_ADMIN: "You can't remove the only admin. Promote another admin first.",
  INVALID_STATUS: "That status value isn't allowed.",
  INVALID_AMOUNT: "The adjustment must be a non-zero number.",
  MEMBERSHIP_NOT_FOUND: "That membership no longer exists.",
  NAME_REQUIRED: "A name is required.",
  HORSE_NOT_FOUND: "That horse no longer exists.",
  SESSION_NOT_FOUND: "That session no longer exists.",
  SESSION_HAS_BOOKINGS: "Cancel the session's active bookings first.",
  BOOKING_NOT_FOUND: "That booking no longer exists.",
  BOOKING_NOT_CANCELLABLE: "That booking can't be cancelled — it's already closed.",
  BOOKING_NOT_ATTENDABLE: "Attendance can't be set for that booking.",
  INVALID_DATE_RANGE: "That date range isn't valid.",
  INVALID_GRAIN: "That time grouping isn't supported.",
  ADMIN_ALREADY_EXISTS: "An admin or staff account already exists.",
};

function mapError(error) {
  if (!error) return null;
  const code = error.message?.trim();
  return MESSAGES[code] || error.details || code || "Something went wrong. Please try again.";
}

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  return { data: error ? null : data, error: mapError(error) };
}

export const adminApi = {
  // --- Dashboard read-only aggregations (0015_dashboard_aggregations.sql) ---
  dashboardMetrics: () => rpc("admin_dashboard_metrics"),

  dashboardBookingSeries: (from, to) =>
    rpc("admin_dashboard_booking_series", { p_from: from, p_to: to }),

  dashboardRevenueSeries: (from, to, grain = "day") =>
    rpc("admin_dashboard_revenue_series", { p_from: from, p_to: to, p_grain: grain }),

  dashboardMembershipBreakdown: () => rpc("admin_dashboard_membership_breakdown"),

  setRole: (userId, role, reason) =>
    rpc("admin_set_role", { p_user_id: userId, p_role: role, p_reason: reason }),

  adjustCredits: (membershipId, amount, reason) =>
    rpc("admin_adjust_credits", { p_membership_id: membershipId, p_amount: amount, p_reason: reason }),

  generateSessions: (from, to) =>
    rpc("admin_generate_sessions", { p_from: from, p_to: to }),

  setSessionStatus: (sessionId, status) =>
    rpc("admin_set_session_status", { p_session_id: sessionId, p_status: status }),

  createHorse: (name, description) =>
    rpc("admin_create_horse", { p_name: name, p_description: description }),

  setHorseStatus: (horseId, status, isActive) =>
    rpc("admin_set_horse_status", { p_horse_id: horseId, p_status: status, p_is_active: isActive }),

  cancelBooking: (bookingId, reason, refundCredit) =>
    rpc("admin_cancel_booking", { p_booking_id: bookingId, p_reason: reason, p_refund_credit: refundCredit }),

  markAttendance: (bookingId, status, notes) =>
    rpc("admin_mark_attendance", { p_booking_id: bookingId, p_status: status, p_notes: notes }),
};
