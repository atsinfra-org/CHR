# Phase 1 — Existing Architecture Audit

Colonel Horse Riding's Supabase usage, as it actually exists in the repository today. Sources: `supabase/schema.sql`, `src/lib/supabaseClient.js`, every `.from(`/`.rpc(`/`supabase.auth.` call in `src/` (grepped exhaustively — no other matches exist), `.env.example`. No `supabase/migrations/`, no `supabase/config.toml`, no generated TypeScript DB types, no Supabase CLI project exist in this repo — `supabase/schema.sql` is a single hand-authored, hand-applied SQL file.

## Summary

**There is no existing riding-club domain data at all.** The current Supabase footprint is exactly one table (`enquiries`, a marketing lead-capture form) plus Supabase Auth used only to gate a small internal admin panel. None of `profiles`, `memberships`, `payments`, `credit_ledger`, `horses`, `class_sessions`, `bookings`, `attendance`, `schedule_templates`, or `system_settings` exist yet, and nothing in the React app references them. This redesign is **greenfield for the booking/membership domain** — the only real migration concern is the one table that already exists and already (very likely) holds real visitor data.

---

## EXISTING TABLE: `public.enquiries`

**Purpose:** Public "Enquire Now" lead-capture form on the marketing site. A visitor submits name/age/email/phone plus which service they're asking about; staff review submissions in a small internal admin panel.

**Schema** (from `supabase/schema.sql`):
```sql
create table public.enquiries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  age smallint not null,
  email text not null,
  phone text not null,
  topic text  -- e.g. "Café", "Junior Riding", "Other: <free text>" — nullable
);
```
No foreign keys, no indexes beyond the primary key, no CHECK constraints.

**Used by:**
- `src/components/EnquiryModal/EnquiryModal.jsx` — public `INSERT` (name, age, email, phone, topic). Not authenticated; runs as `anon`.
- `src/admin/useEnquiries.js` — `SELECT * order by created_at desc`, `DELETE ... eq('id', id)`. Requires an authenticated Supabase session (used by `src/admin/pages/AdminOverview.jsx` and `src/admin/pages/AdminEnquiries.jsx`).

**Relationships:** None. Fully standalone — not linked to `auth.users` or anything else.

**RLS (currently applied, live):**
| Policy | For | To | Rule |
|---|---|---|---|
| "Anyone can submit an enquiry" | INSERT | `anon, authenticated` | `with check (true)` |
| "Authenticated users can read enquiries" | SELECT | `authenticated` | `using (true)` |
| "Authenticated users can delete enquiries" | DELETE | `authenticated` | `using (true)` |

**Problems:**
1. **Authorization is "any authenticated user," not "admin/staff."** There's no `role` concept yet — the SELECT/DELETE policies trust *any* signed-in Supabase user, not specifically staff/admin. This was flagged in the schema file's own comments at the time as something to tighten before relying on it in production (either disable public sign-up in Supabase Auth, or restrict by email). It was never revisited. This is the one real pre-existing security gap.
2. No indexes beyond the PK — acceptable at current scale (a lead-capture table), not a concern.
3. No `user_id` — enquiries aren't linked to an authenticated identity, which is correct for its purpose (anonymous visitors enquire without an account) and should **stay** that way; nothing here should be forced to route through the new `profiles`/`auth.users` model.

**Keep / Modify / Replace:** **KEEP as-is**, unrelated domain. The one recommended (not required) follow-up: once `profiles.role` exists from this redesign, tighten the SELECT/DELETE policies from "any authenticated user" to "staff or admin," which is a strict *improvement* using the new role system — not something the redesign needs to touch structurally.

**Migration required?** **No schema/data migration.** If the RLS tightening above is approved, that's a policy-only change (no data movement, no risk to existing rows). This table and its data are otherwise completely unaffected by everything below.

---

## Supabase Auth usage

- **No custom `profiles`/`users` table exists.** The app relies solely on `auth.users` via the Supabase JS SDK (`supabase.auth.signInWithPassword`, `supabase.auth.getSession`, `supabase.auth.onAuthStateChange`, `supabase.auth.signOut` — all in `src/admin/AdminLogin.jsx`, `src/admin/AdminApp.jsx`, `src/admin/AdminLayout.jsx`).
- **No public sign-up UI** — by design (`AdminLogin.jsx` explicitly states admin accounts are created directly in the Supabase dashboard). This is a real, working safeguard today, but it's a *process* safeguard, not a database one — nothing in the schema currently enforces who counts as "admin."
- **No password/credential duplication** anywhere in the app or database — auth is 100% delegated to Supabase Auth, exactly as it should be. Nothing to fix here.

## Storage

No Supabase Storage buckets are referenced anywhere in the codebase. Not in use.

## Database functions / triggers / views / RPCs

**None exist.** No `.rpc(` call appears anywhere in `src/`. No migrations directory with function definitions. Every write today is a direct client-side `.from(table).insert/update/delete()` — which is fine for the current single-table, no-concurrency-risk use case (a lead form), but is exactly the anti-pattern the new booking system must avoid (per the prompt's core requirement).

## TypeScript types

None generated or hand-written for the database. The codebase is JS-first (`allowJs: true`, `checkJs: false` in `tsconfig.app.json`); only the copied shadcn UI primitives (`coverflow-carousel.tsx`, `lib/utils.ts`) are `.ts(x)`. Any new DB-backed TypeScript types introduced by this redesign will be net-new, not a rewrite of existing types.

## React components/hooks that touch Supabase (exhaustive list)

| File | Table(s) | Operations |
|---|---|---|
| `src/lib/supabaseClient.js` | — | Client init (`createClient`), `supabaseConfigured` guard |
| `src/context/EnquiryModalContext.jsx` | — | No direct Supabase calls; holds modal open-state + `topic` |
| `src/components/EnquiryModal/EnquiryModal.jsx` | `enquiries` | `INSERT` |
| `src/admin/AdminApp.jsx` | `auth.users` (via SDK) | `auth.getSession`, `auth.onAuthStateChange` |
| `src/admin/AdminLogin.jsx` | `auth.users` (via SDK) | `auth.signInWithPassword` |
| `src/admin/AdminLayout.jsx` | `auth.users` (via SDK) | `auth.signOut` |
| `src/admin/useEnquiries.js` | `enquiries` | `SELECT`, `DELETE` |
| `src/admin/pages/AdminOverview.jsx` | `enquiries` (via hook) | stats derived client-side from the same rows |
| `src/admin/pages/AdminEnquiries.jsx` | `enquiries` (via hook) | table + search + delete |

Nothing here references `membership`, `payment`, `booking`, `horse`, `session`, or `credit` concepts as *data* — only as marketing copy strings in the "Subject" dropdown (`EnquiryModal.jsx`) and the "Wider Estate" teaser carousel (`FutureServices.jsx`), which are unrelated to the operational domain being designed here and out of scope for this redesign.

---

## Net assessment

There is no existing riding-club schema to reconcile against — this is not a case of "redesign a messy existing booking system," it's "design the booking system for the first time, without disturbing the one small thing that already works." The audit's only actionable finding is the `enquiries` RLS authorization gap, which the proposed design closes as a side effect of introducing `profiles.role`, not as a special-case fix.
