# CHR — Production runbook: staff-to-admin privilege-escalation fix (0028 + 0029)

**Status: prepared and reviewed. NOT applied.** Nothing here was run against production except read-only `SELECT`s (19 Oct 2026). No data, function or setting on the live database was changed, and nothing was committed or pushed.

Project `scmisanphmmtemfaqzqa`. Do this **before** the privacy rollout (`DEPLOYMENT_AND_VERIFICATION.md` §2 onward). It is two independent, tiny, reversible `CREATE OR REPLACE FUNCTION` statements.

---

## 1. What I found (live database, read-only)

| Fact | Evidence |
|---|---|
| The live trigger function is the **old, vulnerable** body: it lets an actor whose role is `staff` **or** `admin` change `role`/`status`. | `prosrc` matches `0028_..down.sql` logic exactly; fingerprint below |
| It is attached once: `trg_prevent_privilege_escalation`, BEFORE UPDATE, FOR EACH ROW, enabled. | `pg_trigger`: `tgenabled = 'O'` |
| Who can reach it: RLS lets a user update **only their own** profile row (policy "Members update own profile", check `id = auth.uid()`), and an admin any row ("Admin updates any profile", `is_admin()`). Table-level `UPDATE` on every column (incl. `role`, `status`) is granted to `authenticated`, so the trigger is the **only** thing stopping a role change by direct API call. | `pg_policy`, `information_schema` |
| **Today the live data is 1 active admin, 17 active members, 0 staff.** So no existing account can exploit this right now; a *member* is already blocked. The hole becomes live the moment any staff account exists. | `select role, status, count(*)` |
| The only function that writes `profiles.role` is `admin_set_role()`. It checks `is_admin()`, requires a reason, blocks demoting the last admin (`LAST_ADMIN`), and writes a `SET_ROLE` row to `audit_logs`. | `pg_proc` source, live |
| No website or app code updates `role` or `status`. The only client writes to `profiles` are name and phone (`AccountPage.jsx:80`, `profile-api.ts:75`). | repo search |
| `_int_in_range(jsonb,int,int)` is `IMMUTABLE`, SQL, **no** `search_path` set, owner `postgres`, ACL `postgres, service_role`. Its only caller is `admin_update_setting`. | `pg_proc`, `pg_depend` |
| Migration history table `supabase_migrations.schema_migrations` has **13 rows, last 10 Sep 2026** (proposals 0006–0015). Proposals 0016–0027 were applied by hand in the SQL Editor and never recorded. There is **no `supabase/migrations/` folder**. | live query; `ls supabase` |
| No long-running transactions at inspection time. | `pg_stat_activity` |

Fingerprints of the live bodies **before** the fix (CR characters removed, `md5(replace(prosrc, E'\r',''))`):
- `prevent_privilege_escalation`: `ab7ceeda8b3b7e1635681ce04b44816f` (385 characters)
- `_int_in_range`: `27dfa1ab7d9080c192fad3c03611b166` (125 characters)

## 2. Your ten requirements

1. **0028 stops staff promoting themselves or other staff — confirmed.** The trigger now requires the *acting* user to be `admin` for any change to `role` or `status` (`v_actor_role is distinct from 'admin'`, which also rejects a missing actor). Staff cannot change another person's row anyway (RLS permits only their own), so that case is covered too. Proof on a database copy: without 0028 the staff self-promotion **succeeded**; with it, it fails with `Only an admin may change role/status`. Also proved for self-suspension and for staff calling `admin_set_role()` (`NOT_AUTHORIZED`).
2. **Legitimate admin workflows are intact — confirmed.** `admin_set_role()` (an admin, via the admin console) passes the trigger because `auth.uid()` is an admin; an admin's direct status edit still works; members' name/phone edits are untouched; no client code writes role/status. Tested both ways.
3. **0029's intent — verified.** It re-creates `_int_in_range` with an identical body and `set search_path = public` (clears the Supabase advisor warning `function_search_path_mutable`). The function uses only built-in operators, which are always visible, so behaviour is identical. Tested locally: `5`→true, `"5"` (a string)→false, `11` (out of range)→false, before and after. `CREATE OR REPLACE` keeps the owner and the ACL (checked: unchanged).
4. **Migration history and conventions.** Hand-applied in the Supabase SQL Editor, files in `supabase/proposals/` with a `.down.sql` each; the tracking table is not maintained after 10 Sep. **Do not run `supabase db push`, `db pull` or `migration repair`** — the CLI would see 13 recorded versions against a 20-odd-file proposals folder and could try to apply or mark the wrong things. Follow the existing convention.
5. **Compatible with the live schema — confirmed** read-only: the live function is the exact body that `0028…down.sql` restores; the trigger, policies, `profiles` columns (`role`/`status` with CHECK constraints), `admin_set_role()`, `audit_logs` columns, and the one caller of `_int_in_range` all match what the migrations assume. Neither migration touches a table, column, grant, policy or data.
6. **Backup, deployment, verification:** §3–§5.
7. **Queries that prove the hole is closed:** §5 (V1–V6), including a behavioural test that is safe on production.
8. **How to stop safely:** §3 (preconditions) and §6.
9. **Audit trail and last-admin safeguard preserved.** Neither migration touches `admin_set_role()` or `audit_logs`. Verified by test 8 (audit rows written) and test 9 (`LAST_ADMIN` fires with exactly one admin, which is today's state) in `phase13b`.
10. **Rollback does not weaken the fix permanently:** §6 — the rollback restores the old body *only as a short-lived measure*, with instructions to re-apply the fix immediately and a safer first choice.

## 3. Before you start (preconditions — stop if any is false)

**P0. Do not run `phase13_privilege_escalation.sql` on production.** It disables the escalation trigger on `profiles` (briefly, but that takes a lock that blocks sign-ups and profile edits) and inserts auth users. Use it on a staging copy. Use `phase13b_production_safe_check.sql` (§5 V6) on production instead: it never disables a trigger and always rolls back.

**P1. Backup.** Dashboard → Database → Backups: confirm a backup from the last 24 hours exists (or point-in-time recovery is on, if your plan has it). Note the time. The change below is function-only, so the backup is a safety net, not the rollback mechanism.

**P2. Snapshot the two functions** (the exact rollback source — more exact than `.down.sql`). In the SQL Editor run, then **copy the whole result into a file** `pre-0028-function-snapshot.sql` and keep it:
```sql
select pg_get_functiondef(p.oid) || ';' as ddl
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('prevent_privilege_escalation', '_int_in_range', 'admin_set_role');
```

**P3. Preconditions query.** Run and compare:
```sql
select
  (select count(*) from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'trg_prevent_privilege_escalation' and tgenabled = 'O') as trigger_enabled,
  (select md5(replace(prosrc, E'\r', '')) from pg_proc where proname = 'prevent_privilege_escalation' and pronamespace = 'public'::regnamespace) as escalation_fn_md5,
  (select md5(replace(prosrc, E'\r', '')) from pg_proc where proname = '_int_in_range' and pronamespace = 'public'::regnamespace) as range_fn_md5,
  (select count(*) from public.profiles where role = 'admin' and status = 'active') as active_admins,
  (select count(*) from public.profiles where role = 'staff') as staff_accounts,
  (select count(*) from public.profiles where role = 'member') as members,
  (select count(*) from pg_stat_activity where state <> 'idle' and xact_start < now() - interval '5 minutes' and pid <> pg_backend_pid()) as long_transactions;
```
Expected (as of 19 Oct 2026): `trigger_enabled = 1`; `escalation_fn_md5 = ab7ceeda8b3b7e1635681ce04b44816f`; `range_fn_md5 = 27dfa1ab7d9080c192fad3c03611b166`; `active_admins >= 1` (was 1); `staff_accounts = 0` (was 0); `long_transactions = 0`. **Write down the numbers for `active_admins`, `staff_accounts` and `members`** — you compare them afterwards.

**Stop (and do not apply) if:**
- `trigger_enabled` is not 1 → someone disabled the trigger; investigate first (that is already an incident).
- either md5 differs → the live function was changed after my inspection; read the live body, compare with the proposal, and have it reviewed before applying (`create or replace` would overwrite it).
- `active_admins = 0` → nobody can use `admin_set_role()`; resolve first.
- `staff_accounts > 0` → **do not stop, but treat it as urgent**: apply the fix, then review who those staff are and whether any `SET_ROLE` rows or unexplained admins exist (`select * from audit_logs where table_name = 'profiles' order by created_at desc limit 50;` — remember direct changes are **not** audited, see §7).
- `long_transactions > 0` → wait; the change itself does not lock tables, but do it in a quiet moment.

## 4. Deploy (two separate SQL Editor runs; two minutes)

1. Open `supabase/proposals/0028_privilege_escalation_fix.sql`, paste the **whole file** into the SQL Editor of project `scmisanphmmtemfaqzqa`, **Run**. Expected: "Success. No rows returned". It runs as one statement and takes effect immediately for new statements; no table lock, no downtime.
2. Run the V1–V5 checks (§5). Only if they pass, continue.
3. Paste `supabase/proposals/0029_search_path_hardening.sql`, **Run**. Same expectation. (Separate run on purpose: a problem in 0029 cannot affect 0028.)
4. Run V3 and V5 again.

Do not apply 0030 or 0031 in the same sitting unless you want to; they are independent.

## 5. Verification — queries and expected results

**V1. The fix is in place.**
```sql
select prosrc ~ 'distinct from ''admin''' as fixed, prosrc !~ '''staff'', ''admin''' as staff_exemption_gone
from pg_proc where proname = 'prevent_privilege_escalation' and pronamespace = 'public'::regnamespace;
```
Expected: `fixed = true`, `staff_exemption_gone = true`.

**V2. The trigger is still attached and enabled, once.**
```sql
select tgname, tgenabled from pg_trigger where tgrelid = 'public.profiles'::regclass and not tgisinternal order by 1;
```
Expected: exactly two rows: `trg_prevent_privilege_escalation | O` and `trg_profiles_updated_at | O`.

**V3. Hardening and grants unchanged.**
```sql
select proname, proconfig, proacl::text, prosecdef
from pg_proc where pronamespace = 'public'::regnamespace and proname in ('prevent_privilege_escalation', '_int_in_range', 'admin_set_role') order by 1;
```
Expected: `_int_in_range` → `{search_path=public}` (after step 3; `null` before), ACL `{postgres=X/postgres,service_role=X/postgres}`; `prevent_privilege_escalation` → `{search_path=public}`, ACL `{postgres=X/postgres,service_role=X/postgres}`, secdef true; `admin_set_role` → `{search_path=public}`, ACL includes `authenticated=X/postgres`.

**V4. Data untouched.**
```sql
select role, status, count(*) from public.profiles group by 1, 2 order by 1, 2;
```
Expected: the same numbers you wrote down in P3 (today: admin/active 1, member/active 17).

**V5. Supabase's own check.** Dashboard → Database → Advisors → Security: the `function_search_path_mutable` warning for `_int_in_range` is gone (after 0029); no new ERROR.

**V6. Behavioural proof, safe on production.** Run `supabase/tests/phase13b_production_safe_check.sql` in the SQL Editor (one script). It uses the real admin (read-only, never changed) and ONE throwaway auth user, makes no change to any trigger, and always ends in `ROLLBACK`.
- Expected on success: a notice `PHASE 13b PASSED: staff cannot self-promote / change status, admin paths, audit trail and last-admin guard intact.` and a final row `leftover_throwaway_users = 0`.
- If it reports `FAIL: … but statement succeeded (update public.profiles set role = 'admin' …)`, the fix is **not** in place (nothing is kept even then).
- It does create one auth user and the matching profile and in-app notifications **inside the transaction**; the rollback removes them, and nothing is sent outside the database. If you would rather not touch production at all, skip V6 and rely on V1–V5 (these prove the function text; V6 proves behaviour). I tested V6 on a local copy: **fails on the old function, passes on the new one**, and leaves 0 rows behind.

**V7. Real-app smoke test (as the admin, in the browser).** Sign in to the admin console; open the dashboard and the members list. Expected: loads as before. (Do not change anyone's role just to test; `admin_set_role` was proven in V6.)

**V8. After a few days:** `select * from audit_logs where table_name = 'profiles' order by created_at desc limit 20;` shows only `SET_ROLE` entries you recognise.

## 6. Stopping and rolling back safely

- **Before step 1:** any failed precondition → stop; nothing has changed.
- **0028 fails to run (syntax/permission error):** the statement is atomic; the old function remains. Nothing to undo.
- **V1–V4 or V6 fail after 0028:** first, **do not** reach for the rollback. A failed check means the live system differs from what I inspected; look at the failure message. The old behaviour is only restored if you choose to.
- **A legitimate admin action is blocked after 0028** (an admin cannot change a role/status they are entitled to): confirm the user really is `role = 'admin'` and `status = 'active'` in `profiles`; a suspended or non-admin account is correctly refused. Only if an admin workflow is genuinely broken, run `0028_privilege_escalation_fix.down.sql`, then **fix forward and re-apply 0028 the same day**.
- **Rollback of 0028 reopens the hole.** The exposure is nil only while there are **no staff accounts** (verify `staff_accounts = 0` first; today it is 0). Do not create a staff account while rolled back. Prefer restoring from the P2 snapshot (the exact pre-change function) over `.down.sql` if they differ.
- **Rollback of 0029** (`0029…down.sql`) only removes the `search_path` setting; no security impact beyond the advisor warning returning.
- **Never** weaken the guard as a "recovery": do not drop `trg_prevent_privilege_escalation`, do not grant `staff` the change right, and do not run the original `phase13` on production.
- **If every admin is locked out:** the SQL Editor has no signed-in user (`auth.uid()` is null), so the trigger blocks role changes there before and after 0028 alike; this is not caused by the fix. The documented recovery is `bootstrap_first_admin(uuid)`, which fails closed if any admin/staff exists. If one is needed, take the support route with the project owner rather than disabling the trigger casually; a one-transaction `alter table … disable trigger … ; update …; alter table … enable trigger …; ` is possible but must be reviewed first and re-verified with V2.

## 7. Related weakness this fix does not cover (recommend a follow-up, not part of 0028)

An **admin** can change a profile's role or status by a direct API update (policy "Admin updates any profile"), which **bypasses `admin_set_role()`'s audit row and its last-admin check** (an admin could demote the only admin directly). This is pre-existing and admin-only, so it is not an escalation path for staff or members; but it means "every role change is audited and the last admin is protected" is true only for changes made through the console. A separate, reviewed proposal could make the trigger accept role changes only from inside `admin_set_role()` (and `bootstrap_first_admin()`), and write the audit row from the trigger. I have **not** made that change: it alters admin workflows and needs its own test and your approval.

Also noted: `authenticated` has table-level `UPDATE` on all columns of `profiles` (including `role`, `status`, `email`, `id`); column-level restrictions would be defence in depth, again a separate proposal.

## 8. Checklist — what you must do

| # | Action | Expected result |
|---|---|---|
| 1 | Confirm a recent backup exists (P1) | A backup within 24 h, or PITR on |
| 2 | Run the P2 snapshot query; save the output to a file | 3 `CREATE OR REPLACE FUNCTION …;` statements saved |
| 3 | Run the P3 preconditions query; write down the numbers | `trigger_enabled 1`; md5s `ab7ceeda…` and `27dfa1ab…`; `active_admins ≥ 1`; `staff_accounts 0`; `long_transactions 0` — otherwise STOP (§3) |
| 4 | Paste and run `0028_privilege_escalation_fix.sql` | "Success. No rows returned" |
| 5 | Run V1 | `fixed = true`, `staff_exemption_gone = true` |
| 6 | Run V2 | two rows, both `O` |
| 7 | Run V4 | same counts as step 3 |
| 8 | (Optional, recommended) run `phase13b_production_safe_check.sql` (V6) | `PHASE 13b PASSED …` and `leftover_throwaway_users = 0` |
| 9 | Paste and run `0029_search_path_hardening.sql` | "Success. No rows returned" |
| 10 | Run V3 | `_int_in_range` → `{search_path=public}`, ACL unchanged |
| 11 | Check Advisors (V5); do the admin smoke test (V7) | warning gone; admin console works |
| 12 | Tell me the results (paste V1–V4 outputs). I'll review them before the privacy rollout starts | — |

Not done by me, and not to be done until you say so: committing the new files, applying any migration, the privacy rollout (0030, 0031, function deploy, website and app).
