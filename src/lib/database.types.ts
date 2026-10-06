/**
 * Hand-written to match the schema actually applied to the live project
 * (supabase/proposals/0002_riding_club_core.sql, run and cross-verified by
 * the user). Moved here from docs/database-redesign/database.types.draft.ts
 * so the application can actually import it; that file was also missing two
 * fields that are real applied columns (Profile.date_of_birth and
 * MembershipPlan.min_age/max_age), fixed here.
 *
 * Once real usage across more of the schema warrants it, regenerate the
 * authoritative version with:
 *   npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts
 * and treat that as the source of truth instead of this hand-written one.
 */

export type ProfileRole = "member" | "staff" | "admin";
export type ProfileStatus = "active" | "suspended";
export type MembershipStatus = "pending_payment" | "active" | "expired" | "cancelled" | "suspended";
export type PaymentStatus =
  | "created"
  | "pending"
  | "processing"
  | "success"
  | "failed"
  | "expired"
  | "refunded"
  | "partially_refunded";
export type CreditTransactionType =
  | "membership_purchase"
  | "booking"
  | "cancellation"
  | "admin_adjustment"
  | "refund"
  | "expiry";
export type HorseStatus = "available" | "maintenance" | "rest" | "medical" | "retired";
export type SessionStatus = "open" | "closed" | "cancelled" | "completed";
export type BookingStatus = "held" | "confirmed" | "cancelled" | "completed" | "no_show" | "expired";
export type AttendanceStatus = "present" | "absent" | "no_show" | "excused";

export interface Profile {
  id: string; // uuid, == auth.users.id
  full_name: string | null;
  phone: string | null;
  email: string | null;
  avatar_url: string | null;
  date_of_birth: string | null; // date, "YYYY-MM-DD" — server-side age source, see membership_plans
  role: ProfileRole;
  status: ProfileStatus;
  created_at: string;
  updated_at: string;
}

export interface MembershipPlan {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  class_credits: number;
  validity_days: number;
  min_age: number | null; // inclusive; null = no lower bound
  max_age: number | null; // inclusive; null = no upper bound
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Membership {
  id: string;
  user_id: string;
  plan_id: string;
  status: MembershipStatus;
  start_date: string | null; // date
  end_date: string | null; // date
  payment_id: string | null;
  credits_remaining: number; // cached; credit_ledger is authoritative
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: string;
  user_id: string;
  membership_id: string;
  gateway: string;
  gateway_order_id: string | null;
  gateway_payment_id: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  paid_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Idempotency ledger for Razorpay webhook deliveries / synced
 * verification calls (Phase 4.4 — supabase/proposals/0009_razorpay_integration.sql).
 * Written only by process_payment_webhook(); readable by staff/admin only. */
export interface PaymentWebhookEvent {
  id: string;
  event_id: string;
  event_type: string;
  gateway_order_id: string | null;
  gateway_payment_id: string | null;
  payment_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface CreditLedgerEntry {
  id: string;
  user_id: string;
  membership_id: string;
  booking_id: string | null;
  amount: number;
  transaction_type: CreditTransactionType;
  description: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Horse {
  id: string;
  name: string;
  description: string | null;
  status: HorseStatus;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ScheduleTemplate {
  id: string;
  day_of_week: number; // 0-6, 0 = Sunday
  start_time: string; // "HH:MM:SS"
  end_time: string;
  capacity: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ClassSession {
  id: string;
  session_date: string; // date
  start_time: string;
  end_time: string;
  capacity: number;
  status: SessionStatus;
  template_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClassSessionAvailability extends ClassSession {
  session_id: string;
  booked_count: number;
  available_slots: number;
}

export interface Booking {
  id: string;
  user_id: string;
  membership_id: string;
  session_id: string;
  horse_id: string | null;
  status: BookingStatus;
  booked_at: string;
  cancelled_at: string | null;
  completed_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface Attendance {
  id: string;
  booking_id: string;
  status: AttendanceStatus;
  marked_by: string | null;
  marked_at: string;
  notes: string | null;
}

export interface SystemSetting {
  key: string;
  value: unknown; // jsonb
  description: string | null;
  updated_at: string;
}

export interface AuditLogEntry {
  id: string;
  table_name: string;
  record_id: string;
  action: string;
  performed_by: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  created_at: string;
}

/** Row shape returned by public.member_current_block_usage() (Phase 4.2
 * correction — supabase/proposals/0007_member_block_usage.sql). The
 * dashboard's sole, authoritative source for the current membership
 * block's dates/usage; React only formats these values. Empty array when
 * the caller has no currently-active membership. */
export interface MemberBlockUsage {
  membership_id: string;
  current_block_start: string; // date
  current_block_end: string; // date
  block_class_limit: number;
  block_classes_used: number;
  block_classes_remaining: number;
}

/** Row shape returned by public.eligible_membership_plan() (Phase 4.3 —
 * supabase/proposals/0008_membership_purchase.sql). Tells the caller which
 * plan applies to them and at what price, computed entirely server-side
 * from profiles.date_of_birth — React performs no age/eligibility math. */
export interface EligibleMembershipPlan {
  age: number | null;
  dob_missing: boolean;
  dob_invalid: boolean;
  plan_id: string | null;
  plan_name: string | null;
  plan_description: string | null;
  amount: number | null;
  currency: string | null;
  class_credits: number | null;
  validity_days: number | null;
}

/** Row shape returned by public.initiate_membership_purchase() (Phase
 * 4.3). The ONLY membership-purchase entry point the frontend calls —
 * accepts nothing but plan_id; price/credits/validity/eligibility are all
 * authoritative, server-derived values in the response, never client input. */
export interface InitiateMembershipPurchaseResult {
  membership_id: string;
  payment_id: string;
  plan_id: string;
  plan_name: string;
  amount: number;
  currency: string;
  class_credits: number;
  validity_days: number;
  membership_status: MembershipStatus;
  payment_status: PaymentStatus;
  is_new_purchase: boolean;
}

/** Error codes initiate_membership_purchase()/eligible_membership_plan()
 * raise — branch on `error.message`, prefer showing `error.details` (the
 * human-readable USING DETAIL text) when present. */
export type MembershipPurchaseErrorCode =
  | "Not authenticated"
  | "DATE_OF_BIRTH_REQUIRED"
  | "INVALID_DATE_OF_BIRTH"
  | "PLAN_NOT_FOUND"
  | "PLAN_AGE_INELIGIBLE"
  | "ACTIVE_MEMBERSHIP_EXISTS";

/** Error codes attach_gateway_order() raises (Phase 4.4) — surfaced to the
 * razorpay-create-order Edge Function, not called directly by the browser. */
export type AttachGatewayOrderErrorCode =
  | "Not authenticated"
  | "PAYMENT_NOT_FOUND"
  | "WRONG_GATEWAY"
  | "PAYMENT_NOT_PENDING"
  | "ORDER_AMOUNT_MISMATCH";

/** Error codes the razorpay-create-order / razorpay-verify-payment Edge
 * Functions return as `{ error: <code> }` — branch on this in the UI. */
export type PaymentFunctionErrorCode =
  | "Not authenticated"
  | "INVALID_REQUEST"
  | "PAYMENT_NOT_FOUND"
  | "WRONG_GATEWAY"
  | "PAYMENT_NOT_PENDING"
  | "MEMBERSHIP_NOT_ELIGIBLE"
  | "ORDER_CREATION_FAILED"
  | "ORDER_ATTACH_FAILED"
  | "ORDER_ID_MISMATCH"
  | "INVALID_SIGNATURE"
  | "VERIFICATION_FAILED"
  | "SERVER_NOT_CONFIGURED"
  | "INTERNAL_ERROR";

/** Row shape returned by public.admin_dashboard_metrics() (Phase 4.6, extended
 * by supabase/proposals/0015_dashboard_aggregations.sql). The admin
 * dashboard's SOLE source of scalar numbers — every count is computed
 * server-side on the Asia/Kolkata calendar; React never aggregates rows for
 * these. `staff` callers get `enquiries_total: null` (that count is
 * is_admin()-only). Revenue = SUM(payments.amount) WHERE status='success'
 * AND currency='INR'. */
export interface AdminDashboardMetrics {
  total_members: number;
  active_memberships: number;
  pending_payment_memberships: number;
  active_horses: number;
  sessions_today: number;
  bookings_today: number;
  open_sessions_next_7d: number;
  capacity_next_7d: number;
  booked_next_7d: number;
  pending_payments: number;
  cancellations_7d: number;
  bookings_awaiting_attendance: number;
  enquiries_total: number | null;
  // 0015 additions
  total_bookings: number; // seats booked all-time, excludes cancelled/expired
  revenue_total: number;
  revenue_30d: number;
  revenue_prev_30d: number;
  horses_total: number;
  horses_available: number;
  horses_maintenance: number;
  horses_rest: number;
  horses_medical: number;
  horses_retired: number;
  horses_inactive: number;
}

/** Row of public.admin_dashboard_booking_series(p_from, p_to) — one per
 * calendar day (zero-filled), aggregated by class_sessions.session_date.
 * Also carries per-day session count + capacity so the same series drives
 * the Session Capacity Utilisation chart (bookings / capacity). */
export interface AdminDashboardBookingPoint {
  day: string; // "YYYY-MM-DD"
  bookings: number;
  sessions: number;
  capacity: number;
}

/** Row of public.admin_dashboard_revenue_series(p_from, p_to, p_grain) —
 * SUM(payments.amount) for successful INR payments, bucketed by paid_at on
 * the Asia/Kolkata calendar. Zero-filled; an all-zero series is a real
 * "no revenue yet" result, not a placeholder. */
export interface AdminDashboardRevenuePoint {
  bucket: string; // "YYYY-MM-DD" (bucket start)
  revenue: number;
  payments: number;
}

/** Row of public.admin_dashboard_membership_breakdown(). `dimension`
 * is "status" (the five real memberships.status values; an 'active' row
 * past end_date is folded into 'expired') or "plan" (one per
 * membership_plans row). */
export interface AdminDashboardBreakdownRow {
  dimension: "status" | "plan";
  key: string;
  label: string;
  count: number;
}

/** RPC call shapes, for reference when wiring later phases. */
export interface RpcSignatures {
  book_class: { args: { p_session_id: string }; returns: Booking };
  cancel_booking: { args: { p_booking_id: string; p_reason?: string }; returns: Booking };
  admin_adjust_credits: { args: { p_membership_id: string; p_amount: number; p_reason: string }; returns: CreditLedgerEntry };
  generate_sessions: { args: { p_from: string; p_to: string }; returns: number };
  available_sessions: { args: { p_date: string }; returns: ClassSessionAvailability[] };

  /** Phase 4.6 admin operations — all SECURITY DEFINER, all re-check
   * is_admin()/is_staff_or_admin() internally, all write public.audit_logs.
   * Granted to `authenticated` (the RPC's own check is the gate); never to
   * anon. See supabase/proposals/0014_admin_operations.sql. */
  admin_dashboard_metrics: { args: Record<string, never>; returns: AdminDashboardMetrics[] };
  admin_dashboard_booking_series: { args: { p_from: string; p_to: string }; returns: AdminDashboardBookingPoint[] };
  admin_dashboard_revenue_series: {
    args: { p_from: string; p_to: string; p_grain: "day" | "week" | "month" };
    returns: AdminDashboardRevenuePoint[];
  };
  admin_dashboard_membership_breakdown: { args: Record<string, never>; returns: AdminDashboardBreakdownRow[] };
  admin_set_role: { args: { p_user_id: string; p_role: ProfileRole; p_reason: string }; returns: Profile };
  admin_generate_sessions: { args: { p_from: string; p_to: string }; returns: number };
  admin_set_session_status: { args: { p_session_id: string; p_status: SessionStatus }; returns: ClassSession };
  admin_create_horse: { args: { p_name: string; p_description: string }; returns: Horse };
  admin_set_horse_status: { args: { p_horse_id: string; p_status: HorseStatus; p_is_active: boolean }; returns: Horse };
  admin_cancel_booking: { args: { p_booking_id: string; p_reason: string; p_refund_credit: boolean }; returns: Booking };
  admin_mark_attendance: { args: { p_booking_id: string; p_status: AttendanceStatus; p_notes: string }; returns: Attendance };
  /** Phase 4.6 Objective A — postgres / service_role ONLY. Revoked from
   * anon AND authenticated; the browser can never call this. Fails closed
   * once any admin/staff profile exists (ADMIN_ALREADY_EXISTS). */
  bootstrap_first_admin: { args: { p_user_id: string }; returns: Profile };
  member_current_block_usage: { args: Record<string, never>; returns: MemberBlockUsage[] };
  member_booking_eligibility: { args: Record<string, never>; returns: MemberBookingEligibility[] };
  eligible_membership_plan: { args: Record<string, never>; returns: EligibleMembershipPlan[] };
  initiate_membership_purchase: { args: { p_plan_id: string }; returns: InitiateMembershipPurchaseResult[] };
  /** Phase 4.4 — called only from the razorpay-create-order Edge Function
   * (using the caller's own JWT, never service_role). Not a public API. */
  attach_gateway_order: {
    args: { p_payment_id: string; p_gateway_order_id: string; p_gateway_order_amount: number; p_gateway_order_currency: string };
    returns: Payment;
  };
  /** Phase 4.4 — service_role only (webhook / razorpay-verify-payment Edge
   * Functions). Revoked from anon/authenticated; never callable from the browser. */
  process_payment_webhook: {
    args: {
      p_event_id: string;
      p_event_type: string;
      p_gateway_order_id: string;
      p_gateway_payment_id: string;
      p_status: "success" | "failed";
      p_amount?: number | null;
      p_currency?: string | null;
      p_metadata?: Record<string, unknown>;
    };
    returns: Payment;
  };
}

/**
 * book_class() error shapes worth branching on in the UI, rather than just
 * showing the raw message. Supabase surfaces a raised exception's MESSAGE as
 * `error.message`, and any USING DETAIL/HINT as `error.details`/`error.hint`.
 */
export type BookClassErrorCode =
  | "Not authenticated"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_AVAILABLE"
  | "INVALID_SESSION_DATE"
  | "NO_ACTIVE_MEMBERSHIP"
  | "MEMBERSHIP_EXPIRED"
  | "NO_CREDITS_REMAINING"
  | "DUPLICATE_BOOKING"
  | "WEEKLY_LIMIT_REACHED"
  | "SESSION_FULL";

/** cancel_booking() error codes (Phase 4.5). */
export type CancelBookingErrorCode =
  | "BOOKING_NOT_FOUND"
  | "Not authorized to cancel this booking"
  | "BOOKING_NOT_CANCELLABLE";

/** Structured error codes raised by the Phase 4.6 admin RPCs
 * (0014_admin_operations.sql). Branch on `error.message`; `error.details`
 * carries the human-readable USING DETAIL text when present. The admin UI
 * maps these in src/admin/adminApi.js. */
export type AdminRpcErrorCode =
  | "NOT_AUTHORIZED"
  | "REASON_REQUIRED"
  | "INVALID_ROLE"
  | "USER_NOT_FOUND"
  | "LAST_ADMIN"
  | "INVALID_STATUS"
  | "INVALID_AMOUNT"
  | "MEMBERSHIP_NOT_FOUND"
  | "NAME_REQUIRED"
  | "HORSE_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "SESSION_HAS_BOOKINGS"
  | "BOOKING_NOT_FOUND"
  | "BOOKING_NOT_CANCELLABLE"
  | "BOOKING_NOT_ATTENDABLE"
  | "INVALID_DATE_RANGE"
  // bootstrap_first_admin() only (not browser-callable):
  | "ADMIN_ALREADY_EXISTS"
  | "AUTH_USER_NOT_FOUND"
  | "PROFILE_NOT_FOUND"
  | "USER_HAS_ACTIVITY";

/** Row shape returned by public.member_booking_eligibility() (Phase 4.5 —
 * supabase/proposals/0010_booking_security_and_rules.sql). The booking
 * page's sole source for the eligible date range / credits / block usage
 * — React performs no date-range or eligibility arithmetic of its own.
 * `min_bookable_date`/`max_bookable_date` are null when the member has no
 * active membership; `max_bookable_date` is already clamped server-side to
 * min(today + booking_window_days, membership.end_date). */
export interface MemberBookingEligibility {
  has_active_membership: boolean;
  membership_id: string | null;
  membership_start_date: string | null;
  membership_end_date: string | null;
  credits_remaining: number | null;
  min_bookable_date: string | null;
  max_bookable_date: string | null;
  block_class_limit: number | null;
  block_classes_used: number | null;
  block_classes_remaining: number | null;
  current_block_start: string | null;
  current_block_end: string | null;
}
