# Phase 4.2 — Member Dashboard Audit

Read-only inspection performed before writing any dashboard code, followed by the implementation plan actually carried out.

## 1. Existing member-facing UI (before this phase)

`/account` (phase 4.1) had exactly one authenticated view: [`AccountDashboard.jsx`](../../src/account/AccountDashboard.jsx), a single centered card showing `full_name`, `email`, `phone`, `date_of_birth`, `role`, `status`, an inline "complete your profile" form (phone/DOB), and a Sign Out button. No membership, credits, bookings, or activity of any kind — phase 4.1 was deliberately just the auth/profile foundation (see its own comment: *"Phase 4.1 is the auth/profile foundation, not a member management system"*).

There was no dashboard nav, no header beyond a static brand strip (`BrandHeader` in [`AccountApp.jsx`](../../src/account/AccountApp.jsx)), and no widgets/cards of any kind on the member side.

## 2. Existing routing

No router library — `src/main.jsx` branches on `window.location.pathname` (`/admin` → `AdminApp`, `/account` → `AccountApp`, else → the public site). `AccountApp` itself branches on `useAuth()`'s `status`: `AUTH_LOADING` → spinner text, `AUTHENTICATED` → `AccountDashboard`, else → `AccountLogin`. This routing structure is unchanged by this phase — the member dashboard stays at `/account`.

## 3. Existing reusable pieces

- **`AuthProvider`/`useAuth()`** ([`src/context/AuthProvider.jsx`](../../src/context/AuthProvider.jsx)) — single shared session + `public.profiles` subscription, fetched once per user id. Reused as-is for identity; no second profile query added anywhere in this phase.
- **Design system primitives**: [`GoldDivider`](../../src/components/ui/GoldDivider.jsx), [`HorseMark`](../../src/components/ui/HorseMark.jsx), [`Button`](../../src/components/ui/Button.jsx) (magnetic-hover CTA, not used here — its "always shows an arrow and always navigates" shape doesn't fit the disabled placeholder actions this phase needs). Color tokens (`racing-green`, `deep-forest`, `antique-gold`, `warm-ivory`, `soft-cream`, `charcoal`, `warm-grey`, `destructive`) and fonts (`font-serif` = Cormorant Garamond, `font-sans` = Manrope) come from `src/index.css`'s `@theme` block — reused throughout, no new tokens introduced.
- **UI conventions worth matching** (from `AdminOverview.jsx`, `AdminLayout.jsx`): bordered white cards on `warm-ivory` background, uppercase tracked-out labels for stat captions, a `destructive`-colored bordered box for inline errors, a mobile drawer built with `framer-motion` + `lucide-react`'s `Menu`/`X`. All three patterns are reused (error box → `SectionMessage.jsx`, drawer → `AccountHeader.jsx`, stat cards → `MembershipCard.jsx`).
- **`AccountLogin.jsx`**, **`AdminApp.jsx`**, **`AdminLayout.jsx`** — untouched. This phase does not modify admin routing/authorization or the login/registration flow.

## 4. Existing member-related queries

Only one: `AuthProvider.loadProfile()` — `supabase.from("profiles").select("*").eq("id", userId).maybeSingle()`. Nothing previously queried `memberships`, `bookings`, `credit_ledger`, `payments`, or `class_sessions` from the frontend anywhere in the app.

## 5. Database objects inspected (live project, confirmed via `mcp__supabase__list_tables`, matching the applied `supabase/proposals/0002-0004` files exactly)

| Table | Live rows at audit time | Relevant columns |
|---|---|---|
| `profiles` | 1 | `full_name, phone, email, date_of_birth, role, status` |
| `membership_plans` | 2 | `name, class_credits, validity_days, price, currency` |
| `memberships` | 0 | `user_id, plan_id, status, start_date, end_date, credits_remaining` |
| `payments` | 0 | `status, amount, paid_at` |
| `credit_ledger` | 0 | `user_id, membership_id, booking_id, amount, transaction_type, description, created_at` — append-only |
| `bookings` | 0 | `user_id, membership_id, session_id, horse_id, status` |
| `class_sessions` | 124 | `session_date, start_time, end_time, status` |
| `horses` | 3 | `name, is_active` |

**Correction (post-review):** no view or RPC originally exposed a pre-computed "current membership block usage" value — `book_class()` ([`0004_riding_club_functions.sql`](../../supabase/proposals/0004_riding_club_functions.sql)) computed the block index/count inline as a side effect of its own locking logic, not as a queryable object. The first version of this dashboard reproduced that arithmetic in a JS helper for display, which was correctly flagged as an unacceptable duplicated business rule. That has been removed — see [`0007_member_block_usage.sql`](../../supabase/proposals/0007_member_block_usage.sql), which adds `public.member_current_block_usage()` (the dashboard's sole source for block dates/usage) and moves the weekly-limit/block-length constants into `system_settings`, shared by both it and a redefined `book_class()`. The frontend now only formats the RPC's returned values.

Relevant RLS policies (`0003_riding_club_rls.sql`, confirmed applied): members can `select` only their own rows on `profiles`, `memberships`, `payments`, `credit_ledger`, `bookings`, and (via a join-based policy) `attendance`; `class_sessions` and active `horses` are readable by any authenticated user; there is no member `insert`/`update` policy on `bookings` at all (only `book_class()`/`cancel_booking()`, both `SECURITY DEFINER`, can write there) — consistent with this phase doing reads only.

**Production data note:** at audit time there is exactly one profile (the admin), and zero rows in `memberships`/`payments`/`bookings`/`credit_ledger`. Active/expired/booking-populated states could not be exercised against real data without seeding — see "Remaining work" in the final report. `supabase/proposals/0005_seed_dev_data.sql` was **not** run against production.

## 6. Files that needed modification

- [`src/account/AccountDashboard.jsx`](../../src/account/AccountDashboard.jsx) — rewritten from a single profile card into the dashboard orchestrator.
- [`src/account/AccountApp.jsx`](../../src/account/AccountApp.jsx) — the `AUTHENTICATED` branch now renders `AccountDashboard` directly (which owns its own header) instead of wrapping it in the old static `BrandHeader`, so there's exactly one header, not two.

## 7. Files created

- `src/account/useMemberDashboard.js` — the one data hook (membership + this block's usage + upcoming bookings + recent activity), each section with independent `status/error/retry`.
- `src/account/dashboardUtils.js` — pure formatting/date helpers, including the documented `currentBlock()` display mirror described above.
- `src/account/AccountHeader.jsx` — member-area header: brand, in-page nav anchors (Dashboard/My Membership/My Classes/Profile), sign out, mobile drawer.
- `src/account/dashboard/MembershipCard.jsx` — all four membership states (Active/None/Expired-or-cancelled-or-suspended/Pending payment).
- `src/account/dashboard/WeeklyProgress.jsx` — current block usage bar (active membership only).
- `src/account/dashboard/UpcomingClasses.jsx` — member's own future confirmed/held bookings.
- `src/account/dashboard/RecentActivity.jsx` — `credit_ledger` feed.
- `src/account/dashboard/ProfileSummary.jsx` — profile fields + the (unchanged, carried over) complete-profile form.
- `src/account/dashboard/PlaceholderButton.jsx` — the shared disabled "coming soon" action used for Book a Class / View Membership Plans / Renew Membership, per the brief's explicit instruction that these must not implement booking/purchase yet.
- `src/account/dashboard/SectionMessage.jsx` — shared loading/error/empty presentational bits so every card handles its own failure without one query error blanking the page.

## 8. Implementation plan followed

1. Identity stays on `useAuth()` — zero new profile queries.
2. One hook, `useMemberDashboard(userId)`, issues exactly four queries (membership+plan, this block's bookings, upcoming bookings, recent ledger entries), each independently retryable.
3. Membership state (`active`/`pending`/`lapsed`/`none`) is derived in JS from the returned rows using only `status`/`end_date` comparisons against today — no eligibility logic, purely "which of these four states am I displaying."
4. Weekly usage queries `bookings` filtered to the current membership + the current block's date range (computed via the documented mirror of `book_class()`'s arithmetic) — the count itself comes straight from Postgres, not from re-deriving it against already-fetched rows in JS.
5. Upcoming bookings and recent activity are both scoped server-side (`eq("user_id", ...)`, `gte(session_date, today)`), not fetched broadly and filtered client-side.
6. Every card renders its own loading/error/empty state independent of the others.
7. All "next step" actions this phase isn't allowed to implement (Book a Class, View Membership Plans, Renew Membership, Book Your First Class) render as visibly disabled buttons with "coming soon" microcopy rather than linking to a route that doesn't exist yet.
