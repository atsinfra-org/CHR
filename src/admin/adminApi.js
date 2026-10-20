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
  FORBIDDEN: "You don't have permission to do that.",
  NOT_RETRYABLE: "That email can't be retried. It was already sent, or the address bounced.",
  EMAIL_NOT_FOUND: "That email no longer exists.",
  INVALID_ROLE: "That isn't a valid role.",
  REASON_REQUIRED: "A reason is required.",
  USER_NOT_FOUND: "That user no longer exists.",
  LAST_ADMIN: "You can't remove the only admin. Promote another admin first.",
  INVALID_STATUS: "That status value isn't allowed.",
  INVALID_AMOUNT: "The adjustment must be a non-zero number.",
  MEMBERSHIP_NOT_FOUND: "That membership no longer exists.",
  NAME_REQUIRED: "A name is required.",
  SESSION_NOT_FOUND: "That session no longer exists.",
  SESSION_HAS_BOOKINGS: "Cancel the session's active bookings first.",
  INVALID_CAPACITY: "Places must be a whole number from 1 to 12.",
  CAPACITY_BELOW_BOOKINGS: "More riders are already booked than that. Cancel a booking first.",
  BOOKING_NOT_FOUND: "That booking no longer exists.",
  BOOKING_NOT_CANCELLABLE: "That booking can't be cancelled — it's already closed.",
  BOOKING_NOT_ATTENDABLE: "Attendance can't be set for that booking.",
  INVALID_DATE_RANGE: "That date range isn't valid.",
  INVALID_GRAIN: "That time grouping isn't supported.",
  ADMIN_ALREADY_EXISTS: "An admin or staff account already exists.",
  ATTENDANCE_LOCKED: "The credit for this class was already restored. Use a credit adjustment to correct it.",
  INVALID_BOOKING_TRANSITION: "That change isn't allowed for this booking's current state.",
  ORDER_NOT_FOUND: "That order no longer exists.",
  ORDER_NOT_COLLECTABLE: "This order has no in-store items to collect.",
  INVALID_ORDER_TRANSITION: "That order can't move to that status from where it is.",
  PRODUCT_NOT_FOUND: "That product no longer exists.",
  UNKNOWN_SETTING: "That setting doesn't exist.",
  SETTING_NOT_EDITABLE: "That setting can't be edited here.",
  INVALID_VALUE: "That value isn't allowed.",
  PLAN_NOT_FOUND: "That plan no longer exists.",
  PLAN_NOT_EDITABLE: "Legacy plans can't be edited.",
  TEMPLATE_OVERLAP: "Another active slot on that day overlaps this time.",
  TEMPLATE_NOT_FOUND: "That timetable slot no longer exists.",
  ENQUIRY_NOT_FOUND: "That enquiry no longer exists.",
  USE_PLAN_PRICING: "Membership prices are set on the membership plan.",
  // Privacy (0030/0031)
  REQUEST_CLOSED: "That request is already closed.",
  NOTE_REQUIRED: "Say what was done, or why the request was declined.",
  USE_ERASURE_WORKFLOW: "An erasure request is closed by carrying out the erasure, not by changing its status.",
  ASSIGNEE_MUST_BE_ADMIN: "A request can only be assigned to an admin.",
  NOT_AN_OPEN_ACCESS_REQUEST: "A copy can only be produced for an open request to access data.",
  LEGAL_REVIEW_NOT_CONFIRMED: "Confirm that the notice has been reviewed before publishing it.",
  CLUB_DETAILS_MISSING: "Some club details are still missing.",
  NOTICE_FROZEN: "A published notice cannot be edited. Save a new version instead.",
  NOTICE_NOT_FOUND: "That notice version does not exist.",
  UNKNOWN_KEY: "That setting does not exist.",
  UNKNOWN_CATEGORY: "That category does not exist.",
  BASIS_REQUIRED: "An approved period needs a number of days and the reason for it.",
  TEXT_TOO_LONG: "That text is too long.",
  ERASURE_DISABLED: "Account erasure is switched off. Turn it on in Notice & details once the club has approved the rules for it.",
  ERASURE_ON_HOLD: "The waiting period for erasure has not passed yet.",
  ERASURE_BLOCKED: "Something still needs settling before this account can be closed.",
  REQUEST_NOT_IN_PROGRESS: "Review the request and move it to \"being handled\" first.",
  DATABASE_STEP_NOT_DONE: "The details have not been removed yet.",
  // Privacy hardening (0032)
  IDENTITY_NOT_VERIFIED: "Confirm that the request really comes from the account holder first (\"Requester identity\").",
  CANNOT_VERIFY_OWN_REQUEST: "Another admin has to confirm the identity for a request you made yourself.",
  INVALID_METHOD: "Choose how the identity was checked.",
  NOT_AUTOMATED: "This category is never removed by a timer. It needs a reviewed, manual decision.",
  RULE_NOT_APPROVED: "Approve a retention period for this category first.",
  LEGAL_HOLD: "This category is under legal hold.",
  RETENTION_CLEANUP_DISABLED: "Cleanup is switched off until the club approves the retention policy.",
  LOGIN_STEP_FAILED: "The details were removed but the sign-in could not be disabled yet. Run the erasure again.",
};

// The functions raise short upper-case codes on purpose (NOT_AUTHORIZED, SESSION_FULL, ...). Anything else is
// raw database or network text, which can carry a member's details (a constraint message quotes the value),
// so it is never put on screen.
const APP_CODE = /^[A-Z][A-Z0-9_]*$/;

function mapError(error) {
  if (!error) return null;
  const code = error.message?.trim();
  if (MESSAGES[code]) return MESSAGES[code];
  if (APP_CODE.test(code ?? "")) return error.details || code;
  return "Something went wrong. Please try again.";
}

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  return { data: error ? null : data, error: mapError(error) };
}

export const adminApi = {
  // --- Transactional email log (0033_transactional_email.sql). Retrying only re-queues the email. ---
  emailDeliveries: (status = null) => rpc("admin_email_deliveries", { p_status: status, p_limit: 200 }),
  retryEmail: (id) => rpc("admin_retry_email", { p_id: id }),

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

  // Places for one class (migration 0022). Never below what is already booked.
  setSessionCapacity: async (sessionId, capacity) => {
    const { data, error } = await supabase.rpc("admin_set_session_capacity", { p_session_id: sessionId, p_capacity: capacity });
    if (error?.code === "PGRST202") return { data: null, error: "Changing places needs database update 0022, which has not been applied yet." };
    return { data: error ? null : data, error: mapError(error) };
  },

  cancelBooking: (bookingId, reason, refundCredit) =>
    rpc("admin_cancel_booking", { p_booking_id: bookingId, p_reason: reason, p_refund_credit: refundCredit ?? null }),

  markAttendance: (bookingId, status, notes) =>
    rpc("admin_mark_attendance", { p_booking_id: bookingId, p_status: status, p_notes: notes }),

  // --- Phase 5: roster, store orders, catalog, notifications ---
  sessionRoster: (date) => rpc("admin_session_roster", { p_date: date }),

  setOrderStatus: (orderId, status) =>
    rpc("admin_set_order_status", { p_order_id: orderId, p_status: status }),

  setProductPrice: (productId, price, isActive) =>
    rpc("admin_set_product_price", { p_product_id: productId, p_price: price, p_is_active: isActive }),

  markNotificationsRead: (ids = null) => rpc("mark_notifications_read", { p_ids: ids }),

  // --- Phase 6 ---
  updateSetting: (key, value) => rpc("admin_update_setting", { p_key: key, p_value: value }),

  updatePlan: (planId, price, classCredits, reschedulesAllowed, isActive) =>
    rpc("admin_update_plan", {
      p_plan_id: planId,
      p_price: price,
      p_class_credits: classCredits,
      p_reschedules_allowed: reschedulesAllowed,
      p_is_active: isActive,
    }),

  saveTemplate: (id, day, start, end, capacity, active) =>
    rpc("admin_save_template", { p_id: id, p_day: day, p_start: start, p_end: end, p_capacity: capacity, p_active: active }),

  setEnquiryStatus: (id, status) => rpc("admin_set_enquiry_status", { p_id: id, p_status: status }),

  storeMetrics: () => rpc("admin_store_metrics"),

  // --- Privacy and data protection (supabase/proposals/0030, 0031) ---
  privacyOverview: () => rpc("admin_privacy_overview"),
  privacyRequests: (status = null, offset = 0) => rpc("admin_list_privacy_requests", { p_status: status, p_limit: 200, p_offset: offset }),
  verifyRequesterIdentity: (requestId, method, note) =>
    rpc("admin_verify_requester_identity", { p_request_id: requestId, p_method: method, p_note: note ?? null }),
  memberConsents: (userId, limit = 100, offset = 0) => rpc("admin_member_consents", { p_user: userId, p_limit: limit, p_offset: offset }),
  privacyRequestEvents: (id) => rpc("admin_privacy_request_events", { p_id: id }),
  updatePrivacyRequest: (id, status, assignedTo, note) =>
    rpc("admin_update_privacy_request", { p_id: id, p_status: status ?? null, p_assigned_to: assignedTo ?? null, p_note: note ?? null }),
  exportMemberData: (requestId) => rpc("admin_export_member_data", { p_request_id: requestId }),
  erasurePreflight: (requestId) => rpc("admin_erasure_preflight", { p_request_id: requestId }),
  privacyConfig: () => rpc("admin_privacy_config"),
  setPrivacyConfig: (key, value) => rpc("admin_set_privacy_config", { p_key: key, p_value: value }),
  listNotices: () => rpc("admin_list_notices"),
  saveNoticeDraft: (version, title, body) => rpc("admin_save_notice_draft", { p_version: version, p_title: title, p_body: body }),
  publishNotice: (version, legalReviewConfirmed, effectiveDate) =>
    rpc("admin_publish_privacy_notice", { p_version: version, p_legal_review_confirmed: legalReviewConfirmed, p_effective_date: effectiveDate }),
  privacyAudit: (limit = 100, offset = 0) => rpc("admin_privacy_audit", { p_limit: limit, p_offset: offset }),
  retentionRules: () => rpc("admin_retention_rules"),
  retentionPreview: () => rpc("admin_retention_preview"),
  setRetentionRule: (category, days, basis, approve) =>
    rpc("admin_set_retention_rule", { p_category: category, p_days: days, p_basis: basis, p_approve: approve }),

  /**
   * Carries out an account erasure: removes the member's details (database step), then disables their sign-in
   * (Edge Function account-erasure). Every guard is enforced by the database; this only starts it.
   */
  carryOutErasure: async (requestId) => {
    const { data, error } = await supabase.functions.invoke("account-erasure", { body: { request_id: requestId } });
    if (error) {
      let body = null;
      try {
        body = await error.context?.json?.();
      } catch {
        /* no readable body */
      }
      const code = body?.error;
      return { data: null, error: MESSAGES[code] || body?.message || "The erasure could not be completed. Nothing has been marked finished; you can run it again." };
    }
    return { data, error: data?.completed === true ? null : "The erasure did not finish. Run it again." };
  },
};
