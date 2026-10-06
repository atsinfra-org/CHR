/**
 * SUPERSEDED as of Phase 4.1 — kept only as a historical record of the
 * Phase 2 design proposal. The application now imports the real, corrected
 * types from src/lib/database.types.ts (fixed two staleness gaps found
 * during the Phase 4.1 audit: Profile.date_of_birth and
 * MembershipPlan.min_age/max_age were both missing here). Do not import
 * this file from application code.
 */

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
export type ProfileRole = "member" | "staff" | "admin";
export type ProfileStatus = "active" | "suspended";

export interface Profile {
  id: string; // uuid, == auth.users.id
  full_name: string | null;
  phone: string | null;
  email: string | null;
  avatar_url: string | null;
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

/** RPC call shapes, for reference when wiring the React app in Phase 4. */
export interface RpcSignatures {
  book_class: { args: { p_session_id: string }; returns: Booking };
  cancel_booking: { args: { p_booking_id: string; p_reason?: string }; returns: Booking };
  admin_adjust_credits: { args: { p_membership_id: string; p_amount: number; p_reason: string }; returns: CreditLedgerEntry };
  generate_sessions: { args: { p_from: string; p_to: string }; returns: number };
  available_sessions: { args: { p_date: string }; returns: ClassSessionAvailability[] };
}

/**
 * book_class() error shapes worth branching on in the UI, rather than just
 * showing the raw message. Supabase surfaces a raised exception's MESSAGE as
 * `error.message`, and any USING DETAIL/HINT as `error.details`/`error.hint`.
 *
 * WEEKLY_LIMIT_REACHED specifically: `error.hint` is the next-eligible date
 * as a plain "YYYY-MM-DD" string (parse that for logic/formatting), while
 * `error.details` is already the full human-readable sentence — e.g. "You
 * have reached the maximum of 3 classes for this 7-day period. You can book
 * another class from October 8, 2026." — safe to render as-is.
 */
export type BookClassErrorCode =
  | "Not authenticated"
  | "Session not found"
  | "Session is not open for booking"
  | "Session has already started or passed"
  | "No active membership"
  | "No class credits remaining"
  | "Already booked for this session"
  | "WEEKLY_LIMIT_REACHED"
  | "Session is full";
