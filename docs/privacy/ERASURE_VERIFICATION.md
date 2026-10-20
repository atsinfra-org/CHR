# Account erasure: test-account verification procedure

**Status: NOT YET RUN.** Account erasure is switched off in production (`erasure_finalisation_enabled = false`) and the `account-erasure` Edge Function is **not deployed**. This procedure is the gate before either is changed. Run it with a **throwaway test account that has no money, no bookings and no importance**. Never on a real member.

## What has and has not been verified

| Claim | Evidence | Status |
|---|---|---|
| The database step blanks the profile, removes alert codes, notifications, waitlist, weekly schedules and referral code, and keeps payments, orders, memberships, ledgers, bookings, attendance, consent records | `phase15_account_erasure.sql` on a replica | PASS (replica) |
| Erasure needs the switch, an in-progress request, a recorded identity check by another admin, a passed waiting period and no blockers | `phase15`, `phase16` on a replica | PASS (replica) |
| A request cannot be closed as finished unless the **database** sees the login disabled | `phase15` (a caller claiming "disabled" is ignored) | PASS (replica) |
| The Edge Function's call order, error handling and retry behaviour | `supabase/tests/account-erasure-function.test.cjs`, 26 checks with a fake client | PASS (mock) |
| Supabase actually blocks sign-in and password reset after the ban and soft delete | nothing yet | **NOT TESTED** |
| After the scrub, `auth.users` holds no real email or name | nothing yet | **NOT TESTED** |
| `auth.identities` (linked sign-in identities, for example Google) holds no copy of the person's email or name after a soft delete | nothing yet | **NOT TESTED, UNKNOWN** |

## Procedure

Use a staging copy of the project if you have one. If you use production, do steps 1 to 9 in one sitting and finish with step 10.

1. **Create the test account** on the website with an email you control (for example `you+erasetest@yourdomain`). Confirm it can sign in. Do **not** buy anything or book anything with it. If you want to test the Google case, make a second throwaway account with Google sign-in.
2. **Submit the request:** signed in as the test account, `/account/privacy` → Close my account → confirm.
3. **As an admin** (Admin → Privacy → Requests): open the request, move it to **Being handled**, and under **Requester identity** record the check (for example "Called back on the number on file"). The admin must not be the test account.
4. **Check what would happen** (the preflight button). Expect **no blockers** for a fresh account, and "identity checked".
5. **Deploy the function** (only now, never earlier):
   `npx supabase functions deploy account-erasure --project-ref scmisanphmmtemfaqzqa` (keep JWT verification on; do **not** pass `--no-verify-jwt`).
   Check: `curl -i -X POST https://scmisanphmmtemfaqzqa.supabase.co/functions/v1/account-erasure -d "{}"` returns **401**.
6. **Switch erasure on, temporarily** (Admin → Privacy → Notice & details → `erasure_finalisation_enabled` = true). While it is on, any open erasure request that is in progress and verified could be carried out, so make sure the test request is the **only** open erasure request first (Admin → Privacy → Requests → filter by type).
7. **Carry out the erasure** from the request drawer. Expect "completed".
8. **Verify in SQL** (Supabase SQL Editor; read-only queries; replace the id):
   ```sql
   -- the profile
   select full_name, email, phone, date_of_birth, status, erased_at from public.profiles where id = '<test user id>';
   -- expect: 'Deleted member', all null, 'suspended', erased_at set

   -- the login
   select email, phone, deleted_at, banned_until, raw_user_meta_data, raw_app_meta_data
   from auth.users where id = '<test user id>';
   -- expect: email = erased-<id>@erased.invalid, deleted_at set, banned_until far in the future,
   --         raw_user_meta_data = {} ; check raw_app_meta_data holds nothing identifying

   -- the linked identities (THE UNKNOWN)
   select provider, identity_data from auth.identities where user_id = '<test user id>';
   -- expect: no real email or name. If identity_data still contains the old email, name or picture,
   -- erasure is NOT complete: see "If identities keep personal data" below.
   ```
9. **Try to get back in:** sign in with the old email and password (must fail), and request a password reset to the old email (no email may arrive and no session may result). Try Google sign-in for the Google test account (must not log in as the old member).
10. **Switch erasure off again** and confirm: `select value from public.privacy_config where key = 'erasure_finalisation_enabled';` returns `false`. If you are not ready to keep the function, delete it from the dashboard.

Also check the function logs (Dashboard → Edge Functions → account-erasure → Logs): they must contain error codes only, no emails, names or ids of people.

## If identities keep personal data

Do **not** enable erasure for real members. Options, to be decided with the owner:

1. Extend the function to delete the person's `auth.identities` rows (the Auth admin API does not expose this directly; a reviewed `SECURITY DEFINER` function owned by `postgres` that deletes only that user's identity rows is one route, and it needs its own test).
2. Hard-delete the auth user **after** moving the profile away from the cascade (the 0031 header explains why a plain hard delete is unsafe: it cascades into memberships and wallet records).
3. Accept and document that provider identity data remains until the provider's own retention ends (needs legal review; not recommended without it).

Record the outcome here, with the date and who ran it, before any real erasure is enabled.

## Evidence log

| Date | Run by | Environment | Result |
|---|---|---|---|
| | | | |
