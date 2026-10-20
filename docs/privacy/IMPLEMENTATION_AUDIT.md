# CHR — DPDP Implementation Audit (19 Oct 2026)

Scope: the website (`F:\ATGC\CHR`), the mobile app (`F:\ATGC\CHR-Mobile\CHR-mobile-app`), the Supabase project `scmisanphmmtemfaqzqa` (read-only inspection), and the SQL, Edge Function and unit tests. The earlier reports were treated as notes, not proof; every status below comes from something inspected or run in this audit.

Status key: **PASS** implemented and verified · **PARTIAL** implemented, not fully verified · **BLOCKED** needs a decision, dependency or outside action · **FAIL** verification failed · **NOT TESTED** no adequate verification.

**Technical implementation is not proof of legal compliance.** Items needing counsel are in `BUSINESS_DECISIONS_REQUIRED.md`.

---

## 1. How the state was determined

| Question | How it was answered |
|---|---|
| Which migrations are applied in production? | The migration table records only 0002–0015 (0016 onward were applied by hand, the project's convention), so the **actual objects** were checked read-only: tables, functions, trigger source, cron jobs, settings. Result: **0028, 0029, 0030, 0031 applied; 0032 not.** |
| Do 0028 and 0029 remain intact? | Live trigger source contains the admin-only check; `_int_in_range` has `search_path=public`. Re-asserted by `phase16` check 8 (a staff or member self-promotion is refused). |
| What is uncommitted? | Website: privacy pages, admin screens, migrations 0030–0031, tests, docs, the Edge Function. Mobile: 67 uncommitted changes (including an Expo SDK 55→57 upgrade that is **not** part of this work); its remote is configured (`github.com/ColonelHorseRiding/CHR-mobile-app`) but the remote branch `origin/main` no longer exists (git reports it as gone; the remote may be empty, renamed or deleted, not checked) and it has one local commit. Nothing was committed, reverted or discarded. |
| Do features work or are they placeholders? | Database behaviour was exercised on a clean replica in the exact production state; UI behaviour was checked by unit tests and builds only. |

## 2. Feature status

| Area | Status | Evidence and gaps |
|---|---|---|
| Privacy notice: versioned, frozen once published, hash stored, club details filled in at publish | **PASS** (mechanism) | `phase14`. The notice itself is a **draft, unpublished**, and cannot be published until eight club details are supplied: **BLOCKED** on decisions 1 to 5, 13. No placeholder is ever shown as a valid contact. |
| Consent records: user-bound, purpose and notice version, server time, source, append-only, admin-reviewable | **PASS** | `phase14`: another user cannot read, write or rewrite them; update and delete are refused; admin review works. 0 consent events exist in production. |
| Consent withdrawal (phone alerts) | **PASS** | `phase14`: withdrawal removes the phone's alert code and registration is then refused; re-allowing works. Essential account, booking, payment and security messages are unaffected (they are not governed by this purpose). |
| Marketing consent | **PASS** (inactive by design) | purpose exists but cannot be consented to; no code sends marketing (**BLOCKED** on decision 10 if the club ever wants it). |
| Existing members | **PASS** (design) | no records invented; a non-blocking banner after publication. Whether the law needs more: **LEGAL_REVIEW_REQUIRED** (decision 11). |
| Privacy requests: submit, own-status, history, admin handling, audit, cancel | **PASS** | `phase14`, `phase16`. Users cannot see or act on others' requests. |
| Duplicate requests | **PASS (new, 0032)** | one open request per type for access, consent withdrawal, nomination and erasure, enforced by a unique index. Found missing in this audit. |
| Identity verification before a data copy or an erasure | **PASS (new, 0032)** | found missing in this audit; now required, by an admin other than the requester, recorded and audited. The club's actual method: decision A. |
| Deadlines and escalation | **PARTIAL** | configurable target and an "overdue" flag; **no automatic escalation or notification**; the Rules' outer limit is not enforced (decision 14). |
| Account erasure: database step | **PASS** (replica) | `phase15`, `phase16`: guards in order, blockers, retry safe, atomic, audited, records kept. |
| Account erasure: completion honesty | **PASS (fixed, 0032)** | `admin_finish_erasure` trusted its caller; it now reads the login state itself. |
| Account erasure: Edge Function | **PARTIAL**, not deployed | 26 mock-client checks pass (order, scrub, retry, no data leakage in errors). Real Supabase soft-delete and `auth.identities` behaviour: **NOT TESTED** (`ERASURE_VERIFICATION.md`). Erasure is **BLOCKED** and switched off. |
| Retention framework | **PASS** (mechanism) / **BLOCKED** (activation) | 15 categories; executor with dry-run default, approved-rule, legal-hold and switch guards; five low-risk categories only; audited; rerunnable. All rules unapproved, switch off, nothing scheduled. Previously preview-only: executor and 6 categories added in this audit. |
| Admin console: privacy requests, notice, details, consent summary, audit, retention | **PARTIAL** | permissions enforced in the database (every function checks `is_admin()`; staff refused, tested). UI covered by unit tests and a clean build; **not exercised in a browser**. Added: identity check, consent history, paging parameters. The audit list and request list have an offset in the API; the screens still load a first page of 200 / 100. |
| Website member pages (`/account/privacy`, `/privacy`, `/terms`, `/account-deletion`, registration notice) | **PARTIAL** | unit tests and a clean build; **not clicked through in a browser here.** |
| Mobile privacy screens (notice, choices, requests, close account) | **PARTIAL** | lint, typecheck and 27 script checks pass; **NOT TESTED on a device or emulator** (back button, TalkBack, touch targets, offline). |
| Mobile permissions | **PARTIAL** | `SYSTEM_ALERT_WINDOW` and external-storage permissions blocked in `app.json`; a temporary prebuild confirmed they are marked removed. The real release build's merged manifest is not inspected. NFC and `READ_BASIC_PHONE_STATE` untouched (unverified sources). |
| Google Play Data safety | **PARTIAL** | checklist exists and is now consistent with the code; four answers need outside confirmation; **not submitted** (decision 16). |
| Secrets in clients | **PASS** | website bundle scan (no server-secret names); the mobile client refuses a service-role key at startup; only the public anon key is used. |

## 3. Security findings

Fixed in this change:
1. **Erasure completion could be falsely recorded.** Any admin could call `admin_finish_erasure(id, true)` and close an erasure without the login being disabled. Now verified against `auth.users`. (0032)
2. **No identity check before a data copy or erasure.** (0032)
3. **Unlimited duplicate open requests** (support load and a way to bury a real request). (0032)
4. **Raw database error text could appear in the admin console** (a constraint message can quote a member's data). Unknown errors are now generic; only the application's own codes are shown.
5. **`npm test` exited with a failure** because Vitest collected a standalone Node test, which would also have blocked the deploy workflow. Vitest is now limited to `src/`.
6. **Retention could only be previewed**, and covered 9 of the 15 policy categories. (0032)
7. **The Edge Function left the sign-in email and profile metadata in the auth record** after the soft delete. It now replaces the email with a placeholder, clears the metadata and bans the login first (mock-tested only).

Open (not fixed here):
- **`auth.identities` may keep a copy of the person's email and name** after a soft delete: unknown until the test-account procedure is run. Erasure stays off until then.
- **Leaked-password protection is off** (Supabase advisor WARN, 19 Oct). One click in the dashboard.
- **A Firebase service-account private key sits inside the mobile project folder** (`colonelhorseriding-chr-firebase-adminsdk-*.json`). It is untracked and git-ignored and was never committed (checked), but it is the kind of file that gets bundled or shared by accident. Move it out of the project folder; consider rotating it if the folder was ever shared or zipped.
- **The mobile repo's remote branch is gone and it has 67 uncommitted changes**, including a major Expo upgrade. Check the remote, commit and back it up.
- **Audit-log snapshots keep pre-erasure names and phones by design** (evidence): decision 9.
- **Phases 5 to 8 SQL tests fail** on the replica, identically before and after this work (stale expectations). They were not modified.
- 69 `SECURITY DEFINER` functions are callable by signed-in users (advisor WARN). Each checks its caller inside the function; the privacy functions were tested for refusal of members, staff and visitors. Three are deliberately public to visitors (`current_privacy_notice`, `public_privacy_config`, `available_sessions`).

## 4. Tests

| Suite | Result |
|---|---|
| SQL `phase9`–`phase16` on a clean replica at production state + 0032 | **PASS** (8 of 8) |
| SQL `phase5`–`phase8` | **FAIL, pre-existing** (4 of 4; same errors before and after) |
| 0032 apply twice; down; re-apply; restored bodies compared with 0030/0031 | **PASS** |
| Website `vitest` | **PASS**, 117 tests in 9 files |
| Website lint / typecheck / build | 0 errors (38 warnings, pre-existing) / clean / OK |
| `account-erasure-function.test.cjs` | **PASS**, 26 checks (fake client) |
| Mobile lint / typecheck / `scripts/test-privacy.js` | 0 errors / clean / **27 passed** |
| Browser or device testing; live Edge Function; 0032 on the live database | **NOT TESTED** |

A bug in 0032 itself (an ambiguous column in the retention preview) was caught by `phase14` during development and fixed before this report.

## 5. Safe to deploy, and not

| Safe after review | Not until the owner decides and verifies |
|---|---|
| `0032` (additive; one transaction; rollback script verified), applied **before** the website | Publishing the privacy notice (club details, counsel review) |
| Website deploy (after 0032) | Deploying `account-erasure` or switching on `erasure_finalisation_enabled` |
| Mobile build with the permission change (after device testing) | Approving retention periods, switching on `retention_cleanup_enabled`, scheduling any cleanup |
| | Marketing, parental-consent mechanism, Google Play submission |
