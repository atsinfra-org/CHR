# CHR — Supabase Security Audit

Method: live inspection via the Supabase MCP tools (`list_tables`, `get_advisors(type="security")` — both read-only) plus direct reading of every migration file in `supabase/proposals/`. No secret values are reproduced anywhere in this document, per the task's own constraint; where a secret's *presence* needed confirming, only its environment-variable name is named.

---

## 1. Row Level Security

**CONFIRMED**: all 26 live tables in `public` have `rls_enabled = true` (verified via `list_tables`). Zero tables were found with RLS disabled.

**CONFIRMED — the one real finding**: `profiles` RLS policy "Members update own profile" (`using (id = auth.uid()) with check (id = auth.uid())`) places no column restriction, and the compensating `prevent_privilege_escalation()` trigger currently accepts the actor being `staff` *or* `admin` before allowing a `role`/`status` change — meaning a `staff` account can self-promote to `admin` via a direct `PATCH`. See `DPDP_GAP_REGISTER.md` **P1-01** for full detail and the proposed (unapplied) fix.

**CONFIRMED, by sampling and reading function bodies** (not just by name): every `admin_*` RPC checked enforces its own authorization inside the function body — it does not rely on RLS or the frontend hiding a button. Method: for every distinct `admin_*` function name found anywhere in the migration history, the *latest* definition (by migration file number) was located and its first ~20 lines inspected for an `is_admin()`/`is_staff_or_admin()` call.

| Function | Latest definition | Internal check |
|---|---|---|
| `admin_adjust_credits` | `0014_admin_operations.sql` | `is_staff_or_admin()` |
| `admin_cancel_booking` | `0018_phase6_operations.sql` | present |
| `admin_dashboard_booking_series` | `0015_dashboard_aggregations.sql` | present |
| `admin_dashboard_membership_breakdown` | `0015_dashboard_aggregations.sql` | present |
| `admin_dashboard_metrics` | `0022_no_horses.sql` | present |
| `admin_dashboard_revenue_series` | `0015_dashboard_aggregations.sql` | present |
| `admin_excuse_booking` | `0027_recurring_weekly_bookings.sql` | present |
| `admin_generate_sessions` | `0014_admin_operations.sql` | present |
| `admin_mark_attendance` | `0017_store_credit_functions.sql` | present |
| `admin_save_template` | `0025_waitlist_limits_timetable_enquiries.sql` | present |
| `admin_session_roster` | `0022_no_horses.sql` | present |
| `admin_set_enquiry_status` | `0025_waitlist_limits_timetable_enquiries.sql` | present |
| `admin_set_order_status` | `0018_phase6_operations.sql` | present |
| `admin_set_product_price` | `0017_store_credit_functions.sql` | present |
| `admin_set_role` | `0014_admin_operations.sql` | `is_admin()` (strictest — correctly so, this is the role-grant RPC) |
| `admin_set_session_capacity` | `0022_no_horses.sql` | present |
| `admin_set_session_status` | `0014_admin_operations.sql` | present |
| `admin_store_metrics` | `0018_phase6_operations.sql` | present |
| `admin_update_plan` | `0018_phase6_operations.sql` | present |
| `admin_update_setting` | `0025_waitlist_limits_timetable_enquiries.sql` | present |

`admin_mark_order_paid` and `admin_create_horse`/`admin_set_horse_status` exist in old migration files but are **confirmed absent from the live function list** (cross-checked against the full advisor-reported function list) — consistent with project history (store-credit/Razorpay-only and no-horses phases removing them). Not a gap.

**CONFIRMED, by reading the function bodies directly** (not just grepping for a name): the following member-facing privileged functions correctly scope every operation to `auth.uid()` and do not trust client-supplied identity or price:

- `book_class`, `cancel_booking`, `reschedule_booking` — operate only on the caller's own bookings/membership.
- `attach_gateway_order` — looks up the payment by `id = p_payment_id and user_id = auth.uid()`; rejects if the payment isn't `created`-status or the gateway amount/currency doesn't match the stored, server-side amount.
- `register_push_device` / `unregister_push_device` — `user_id` is always `auth.uid()`, never client-supplied; token format is regex-validated; a 10-device cap per member is enforced.
- `my_wallet_balance`, `my_referral_code`, `claim_referral` — all scoped to `auth.uid()`; `claim_referral` additionally rejects self-referral and referral after a membership already exists.
- `create_order` — price for every line item is looked up server-side from `store_products`/`membership_plans`; the client can only supply `product_id` + `quantity`. Cart size and pending-order-count limits are enforced.

## 2. Privileged Database Functions

**CONFIRMED**: every `SECURITY DEFINER` function sampled sets `set search_path = public` (or, for `_int_in_range`, did not — see Gap Register P3-01, fix proposed).

**CONFIRMED, from the live security advisor**: 44 `SECURITY DEFINER` functions are currently executable by the `authenticated` role via PostgREST (`/rest/v1/rpc/<name>`) and 1 (`available_sessions`) by `anon` as well. This is expected for a PostgREST-RPC-based architecture — the question that matters is whether each function checks authorization *internally*, which §1 above confirms for every admin-level one. `available_sessions`'s `anon` grant is judged intentional and low-risk (see Gap Register P3-02); no other function is both `anon`-reachable and privileged.

**UNVERIFIED**: input validation was spot-checked (several `admin_update_setting` call sites use a shared `_int_in_range()` validator; `create_order` validates quantity bounds and cart size) but not exhaustively reviewed function-by-function. No obvious gap was found in the functions actually read for this audit.

## 3. Storage Security

**CONFIRMED — not applicable**: no Supabase Storage bucket is referenced anywhere in `src/` or `supabase/`. `profiles.avatar_url` is a live column with zero upload/read code path anywhere in the frontend. No bucket-visibility or signed-URL review was needed because no bucket exists.

## 4. Admin Access

**CONFIRMED**: `profile.role` is never trusted as a self-sufficient authority — every privileged database function re-derives the caller's role server-side via `is_admin()`/`is_staff_or_admin()` (both of which query `profiles` fresh using `auth.uid()`, not a cached JWT claim). The frontend (`src/admin/AdminApp.jsx`, not re-read in this pass but confirmed present from prior project history) additionally gates routes/UI, but that gating is cosmetic layered on top of the real, server-side enforcement — exactly the right order of trust.

**The one real exception** is **P1-01** (staff self-promotion) — see above and the Gap Register. This is the single most important finding of this entire audit.

## 5. Secrets and Client Configuration

**CONFIRMED**: `src/lib/supabaseClient.js` and every other client file read only `import.meta.env.VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — both Supabase's intentionally-public values. No service-role key, Razorpay key secret, Resend API key, Expo access token, or push-send shared secret appears anywhere under `src/`.

**CONFIRMED**: every Edge Function reads its secrets from `Deno.env.get(...)` — `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `EXPO_ACCESS_TOKEN`, `PUSH_SEND_SECRET` — none are hardcoded in source.

**CONFIRMED**: the Razorpay webhook (`supabase/functions/razorpay-webhook/index.ts`) verifies `X-Razorpay-Signature` via HMAC-SHA256 computed over the **raw** request body, compared with a timing-safe equality check, before trusting any payload content.

**PARTIALLY VERIFIED**: Edge Function error logs (`console.error(...)`) were spot-checked and print short `.message` strings rather than full secret-bearing objects in every case read — but not every log statement's full argument list was traced line-by-line. No secret or obviously-sensitive payload was found in the ones read.

## 6. Auth-level finding

**CONFIRMED**: Supabase Auth's "leaked password protection" (HaveIBeenPwned check) is currently disabled. See Gap Register P2-05. This is a one-click Dashboard setting, not a migration, and was not toggled by this audit.

## 7. Database-advisor raw summary (for reference)

- `rls_enabled_no_policy` (INFO, ×1): `push_deliveries` — verified correct-by-design (service-role-only table).
- `function_search_path_mutable` (WARN, ×1): `_int_in_range` — fix proposed, not applied.
- `anon_security_definer_function_executable` (WARN, ×1): `available_sessions` — verified intentional, low-risk.
- `authenticated_security_definer_function_executable` (WARN, ×44): expected for this architecture; every admin-level one independently verified authorized (§1).
- `auth_leaked_password_protection` (WARN, ×1): Dashboard setting, recommended, not applied.

No `ERROR`-level advisor findings exist at the time of this audit.


---

## Update 2026-10-19

1. **Privilege escalation (P1-01) re-verified live and reproduced on a copy.** The live `prevent_privilege_escalation()` still lets `staff` change a profile's role/status. On a database without 0028 the repaired regression test fails ("statement succeeded"); with 0028 all six checks pass (including `admin_set_role()` working and ordinary profile edits working). **Apply 0028 and 0029.** Interim mitigation until applied: treat every staff account as potentially an admin; review who holds staff.
2. **Cascade foreign keys (G-02).** Deleting an auth user cascades to `profiles`, `memberships`, `wallet_ledger`, `referrals`, `referral_codes`. Never delete users by hand; the erasure workflow soft-deletes the login instead.
3. **New objects reviewed (0030, 0031):** every new table has RLS enabled with no direct member write policies; all functions are `SECURITY DEFINER` with `set search_path = public`; admin functions check `is_admin()` and member functions use `auth.uid()` only; consent and notice-version tables are protected by triggers (append-only / frozen once published). `anon` can call only `public_privacy_config` and `current_privacy_notice`. Verified by `phase14` and `phase15`.
4. **Edge Function `account-erasure`**: requires a signed-in admin JWT (JWT verification left on); the service-role key is read from the function's environment and used only for the soft login-disable; database errors are mapped to fixed codes (no raw text returned). Not deployed; deployed behaviour unverified.
5. **Client bundles**: website `dist` and the mobile JS bundle contain only public keys (anon / publishable). Pattern hits for "service_role"/"sb_secret_" were library text, inspected and confirmed harmless.
6. Not done: leaked-password protection is still a dashboard toggle for the owner; no penetration test; no review of the Supabase project's network, backup or region settings.
