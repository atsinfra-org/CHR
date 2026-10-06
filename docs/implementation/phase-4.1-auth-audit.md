# Phase 4.1 — Authentication Audit

Read-only inspection. Nothing in the application was modified while producing this document.

## 1. How authentication currently works

There is exactly **one** authenticated surface in the entire application: `/admin`. There is no public login, no registration, and no member-facing account area of any kind — the marketing site (`src/App.jsx`) has zero auth-related code, and grepping the whole `src/` tree for `profiles`, `role`, `signUp`, `register` turns up nothing but unrelated false positives (`role="dialog"` on the enquiry modal, `gsap.registerPlugin`, etc.).

`/admin` is reached via a raw `window.location.pathname` check in `src/main.jsx` (no router library is installed) and works like this:

```
main.jsx: pathname starts with "/admin" -> render <AdminApp />
AdminApp.jsx:
  useEffect -> supabase.auth.getSession() + supabase.auth.onAuthStateChange()
  session === undefined  -> "Checking session…" (loading)
  session === null       -> render <AdminLogin />
  session is truthy      -> render <AdminLayout>...</AdminLayout>   <-- no role check at all
```

`AdminLogin.jsx` calls `supabase.auth.signInWithPassword({ email, password })` directly — no hardcoded email/password check of any kind. Sign-out (`AdminLayout.jsx`) calls `supabase.auth.signOut()` directly.

## 2. Is Supabase Auth already in use?

Yes, exclusively — there's no parallel/custom auth system, no locally-stored password, nothing to migrate away from. `src/lib/supabaseClient.js` creates one client from `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (both present in `.env.local`; no service-role key anywhere in the repo or env). This is the single Supabase client already in use everywhere (`EnquiryModal`, the admin pages) — Phase 4.1 should import this same client, not create a second one.

## 3. How the current admin login works / how "admin" is determined

**This is the central finding.** `AdminApp.jsx` line 48 (`if (!session)`) is the *entire* authorization check. There is no email hardcoding (`email === "harshit@gobt.in"` appears nowhere), but there is an equivalent problem: **any authenticated Supabase session is treated as admin.** The gate checks *"is anyone logged in,"* not *"is this profile role=admin."* `public.profiles.role` — the column the new database was specifically built around — is never read by the frontend anywhere.

In practice this has been silently contained so far because the only account able to sign in at all is the one true admin account, and the applied RLS (`0003`) already stops a non-admin session from actually reading `enquiries` data at the database level. But the *frontend* would currently render the full admin shell (sidebar, layout, "Overview"/"Enquiries" nav) for **any** successfully authenticated user, member or otherwise — it just wouldn't have any real data to show, and would need to before something like Phase 4.2's member accounts exist. This is exactly the gap the phase 4.1 brief describes and needs to close.

## 4. Existing auth-related files (exhaustive)

| File | Role |
|---|---|
| `src/lib/supabaseClient.js` | The one Supabase client (`supabase`, `supabaseConfigured`) |
| `src/admin/AdminApp.jsx` | Session check (not role check) + routes to `AdminLogin` or `AdminLayout` |
| `src/admin/AdminLogin.jsx` | Email/password form → `signInWithPassword` |
| `src/admin/AdminLayout.jsx` | Sidebar/topbar shell; reads `session.user.email` for display; `signOut` button |
| `src/admin/useAdminRoute.js` | Unrelated to auth — hash-based sub-navigation (`#overview`/`#enquiries`) within the already-authenticated admin shell |
| `src/admin/useEnquiries.js` | Not auth per se, but depends on the caller already being authenticated+admin (RLS-gated) |
| `src/main.jsx` | Pathname branch: `/admin` → `<AdminApp />`, everything else → `<App />` |

**No signup/register page, no member login, no member dashboard, no route-guard component, no auth context/provider exist anywhere.** Section 5 of the brief ("verify the existing registration flow") and the Test B/C/D/E/F plan (which requires creating and logging into a normal member account through the app) both presuppose a member-facing auth surface that has to be *built*, not merely *integrated* — there is nothing to integrate into on the member side.

## 5. Existing routes

Only two, both driven by raw `pathname`, no router library:
- `/` (anything not `/admin`) → `App.jsx`, the public marketing site.
- `/admin` → `AdminApp.jsx`.

No `/login`, `/register`, `/account`, `/dashboard`, or similar.

## 6. User/session state management

None exists as a reusable abstraction. `AdminApp.jsx` owns its own local `useState` + `useEffect` around `supabase.auth`, scoped entirely to itself — nothing shareable, nothing exported. If a member-facing surface were added today with the current pattern, it would have to duplicate this exact `getSession`/`onAuthStateChange` boilerplate a second time, running a second independent subscription. Section 4 of the brief explicitly anticipates this and asks for "a small reusable AuthProvider/useAuth solution" — that's a real, justified gap, not a nice-to-have.

## 7. TypeScript / database types

- `tsconfig.app.json` has `allowJs: true, checkJs: false` — the codebase is JS-first; only a handful of shadcn-copied primitives (`coverflow-carousel.tsx`, `lib/utils.ts`) are actual `.ts(x)`. No existing convention forces a full TypeScript rewrite of app code, and Phase 4.1 shouldn't invent one.
- `docs/database-redesign/database.types.draft.ts` exists and is mostly accurate, but **is stale in one concrete way**: its `Profile` interface is missing `date_of_birth`, which *is* a real column on the live, applied `public.profiles` table (confirmed against `supabase/proposals/0002_riding_club_core.sql`, which the user has run and cross-verified). This needs fixing before anything depends on it.
- No Supabase CLI–generated types exist (`npx supabase gen types ...` has never been run against this project).

## 8. Environment variables

Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, both in `.env.local` (git-ignored) with a matching `.env.example` template. No service-role key, no DB password, nothing privileged in the frontend's reach — already correct, nothing to fix here.

## 9. Problems / inconsistencies discovered

1. **The real one:** `/admin`'s authorization is "authenticated," not "authenticated AND `profile.role === 'admin'`." Must be fixed.
2. `database.types.draft.ts` is missing `date_of_birth`.
3. No shared auth state — `AdminApp` would duplicate its session-management boilerplate the moment any second authenticated surface is added (which this phase adds).
4. No member-facing login/registration/dashboard exists at all — needed to make this phase's own test plan (Test B through F) executable through the real application rather than only via raw API calls.
5. `handle_new_user()` (the DB trigger, already applied) only backfills `full_name` from signup metadata into the new profile row — it does not pick up `phone` or `date_of_birth`. If a registration form collects those, they must be set via a follow-up self-`UPDATE` on the caller's own profile row after signup (which the applied RLS already permits: "Members update own profile," `role`/`status` changes separately blocked by the `prevent_privilege_escalation` trigger regardless).

## 10. Recommended minimal changes

- Add **one** shared `AuthProvider`/`useAuth()` (plain `.jsx`, matching the codebase's existing context convention — `src/context/EnquiryModalContext.jsx` is the precedent) wrapping session + profile state, with an explicit `AUTH_LOADING | AUTHENTICATED | UNAUTHENTICATED` status.
- Fix `AdminApp.jsx`'s gate to check `profile?.role === 'admin'` via that provider, instead of "any session." Preserve `AdminLogin.jsx`/`AdminLayout.jsx` UI as-is — only the *authorization decision* changes, not the visual design.
- Add a new, minimal, clearly-separate member surface at `/account` (same unlinked-by-URL pattern already used for `/admin`) — login/registration toggle + a read-only profile display, nothing more. This is the smallest surface that makes the phase's own required tests (member login, refresh, logout, privilege-escalation attempt, profile isolation) actually runnable end-to-end, without building any booking/membership/payment UI.
- Correct the missing `date_of_birth` field in the DB types, and move them from `docs/database-redesign/` (a proposal artifact) into `src/lib/` so the application can actually import them.
- Do **not** touch RLS, the `prevent_privilege_escalation()` trigger, or any database object — this phase is frontend-only integration against what's already applied.
