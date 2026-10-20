# CHR — Deployment and Verification (DPDP work)

Updated 19 Oct 2026. **Nothing in this document has been run against production by the engineering work.** Database changes are *proposals* in `supabase/proposals/`, applied by hand in the Supabase SQL Editor (the project's convention). Do not use `supabase db push` and do not attempt to repair migration history: the live migration table records only 0002–0015, and 0016 onward were applied by hand.

Project: `scmisanphmmtemfaqzqa`. Website repo `F:\ATGC\CHR`; mobile repo `F:\ATGC\CHR-Mobile\CHR-mobile-app`.

---

## 0. What is live in production today (read-only checks, 19 Oct 2026)

| Item | State | Evidence |
|---|---|---|
| `0028` privilege-escalation fix | **Applied.** Do not repeat or revert. | live `prevent_privilege_escalation` source contains the admin-only check |
| `0029` search_path hardening | **Applied.** | `_int_in_range` has `search_path=public` |
| `0030` privacy foundation | **Applied.** 7 tables plus the privacy functions, RLS on, no write grants to `anon`/`authenticated` | catalog queries |
| `0031` account erasure | **Applied.** Switch `erasure_finalisation_enabled = false` | `privacy_config` |
| Privacy notice | v1.0 **draft, unpublished**; all club details empty | tables |
| Consent / requests | 0 consent events, 0 requests | row counts |
| Retention rules | 9 categories, **all unapproved**, no periods | `retention_rules` |
| `account-erasure` Edge Function | **Not deployed** | function list |
| `0032` privacy hardening | **Not applied** | `admin_verify_requester_identity` does not exist |
| Cron jobs | 6 active, **none** for retention or erasure | `cron.job` |
| Security advisor | no ERROR findings; leaked-password protection still off (WARN) | advisor run 19 Oct |

## 1. What this change adds

| Layer | Change | Needs |
|---|---|---|
| Database | `0032_privacy_hardening.sql` (+ `.down.sql`) | applied by hand, in the SQL Editor |
| Edge Function | `account-erasure` updated (scrub step; completion decided by the database) | **not deployed**; only for erasure verification, `ERASURE_VERIFICATION.md` |
| Website | admin identity-check and consent-history controls; paging parameters; safer admin error messages; `npm test` fixed; the existing privacy pages (`/privacy`, `/terms`, `/account-deletion`, `/account/privacy`, admin Privacy) | website deploy |
| Mobile | `app.json` blocks three unneeded permissions; one wording fix | new build and release |
| Docs / tests | `phase16_privacy_hardening.sql`, `adminApi.test.js`, extended Edge Function tests, this folder | none |

**New behaviour, in plain terms** (all additive; no existing row changes):
1. A request for a data copy or an erasure needs an **identity check** recorded by an admin other than the requester.
2. An erasure is only recorded as complete when the **database** sees the login disabled (previously it believed the caller).
3. At most one open request of each of *access, consent withdrawal, nomination, erasure* per member.
4. Admin lists can be paged; an admin can read one member's consent history (audited).
5. Retention: 15 categories, and an executor `admin_run_retention` that is a **dry run by default**, refuses unless the rule is approved and the switch `retention_cleanup_enabled` is `true` (off), and never touches payments, audit logs, privacy requests, consent evidence, profiles, memberships or bookings. **Nothing schedules it.**

## 2. Deployment checklist (in this order)

### A. Before anything
- [ ] Confirm a recent Supabase backup exists (Dashboard → Database → Backups).
- [ ] Review `0032_privacy_hardening.sql` once, top to bottom. It is one transaction and safe to run twice.
- [ ] Commit the website and mobile work **deliberately** (nothing was committed or pushed by the engineering work). The mobile repo has ~67 uncommitted changes including an Expo SDK 55 → 57 upgrade that is not part of this work.

### B. Database (SQL Editor)
1. Paste and run `supabase/proposals/0032_privacy_hardening.sql`.
2. **Verify** (expected results in comments):
   ```sql
   select (select count(*) from pg_proc where pronamespace='public'::regnamespace
             and proname in ('admin_verify_requester_identity','admin_member_consents','admin_run_retention','_login_disabled')) as new_functions,  -- 4
          (select count(*) from public.retention_rules) as rules,                                                                                 -- 15
          (select count(*) from public.retention_rules where status='approved') as approved,                                                      -- 0
          (select value from public.privacy_config where key='retention_cleanup_enabled') as cleanup_switch,                                       -- false
          (select value from public.privacy_config where key='erasure_finalisation_enabled') as erasure_switch,                                    -- false
          (select count(*) from pg_proc where pronamespace='public'::regnamespace
             and proname in ('admin_list_privacy_requests','admin_privacy_audit')) as list_functions;                                               -- 2 (no duplicates)
   ```
3. Confirm 0028 is untouched:
   ```sql
   select position('Only an admin may change role/status' in prosrc) > 0 as fixed
   from pg_proc where proname='prevent_privilege_escalation' and pronamespace='public'::regnamespace;   -- true
   ```
4. **Run the tests on a replica or staging copy, not on production:** `phase16_privacy_hardening.sql` (and re-run `phase13`, `phase14`, `phase15`). `phase16` refuses to run (`SKIPPED_FOR_SAFETY`) if the database holds old rows the retention executor would act on, so it cannot touch real data. `phase13b_production_safe_check.sql` is the production-safe check for the 0028 fix.

### C. Website (after B, not before)
- [ ] The updated admin screens call `admin_list_privacy_requests(..., p_offset)` and the new functions, so **apply the database step first**. If the website is deployed first, the admin Privacy → Requests tab shows an error until 0032 is applied. Member pages are unaffected.
- [ ] Push to `main`; the workflow (`.github/workflows/deploy.yml`) runs lint, typecheck, `npm test`, the build and deploys over SSH. Watch the run; do not assume success until it is green.
- [ ] Then, signed out: `/privacy`, `/terms`, `/account-deletion` load. Signed in as a test member: `/account/privacy` loads. Signed in as admin: Admin → Privacy loads, the Requests tab lists, and a request drawer shows **Requester identity** and **Consent history**.

### D. Club details and the notice (owner)
- [ ] Admin → Privacy → Notice & details: fill the eight required details (`BUSINESS_DECISIONS_REQUIRED.md` items 1 to 5, 13).
- [ ] Have counsel review the notice. Publish (the database requires the review confirmation and all details).
- [ ] Open `/privacy` signed out and check it.

### E. Mobile
- [ ] `npx tsc --noEmit`, `npx expo lint`, `node scripts/test-privacy.js` (27 checks).
- [ ] Build (EAS or your Gradle flow). `app.json` now blocks `SYSTEM_ALERT_WINDOW`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`. A temporary prebuild confirmed the generated manifest marks all three for removal; **inspect the merged manifest report of the real release build** before submitting.
- [ ] Test on a real Android phone (section 4). The release build is still signed with the debug key; decide on the upload key before Play.
- [ ] The mobile app only calls member functions that 0032 did not change, so it works before or after the database step.

### F. Erasure and retention stay OFF
- Do **not** deploy `account-erasure`, switch on `erasure_finalisation_enabled` or `retention_cleanup_enabled`, approve retention periods or schedule anything until `BUSINESS_DECISIONS_REQUIRED.md` items 4 to 9 and 14, decisions A to C, and `ERASURE_VERIFICATION.md` are complete.

## 3. Destructive or irreversible operations (none are run by this change)

| Operation | Why irreversible | Guarded by |
|---|---|---|
| Account erasure | blanks name, contact, date of birth; disables the login; deletes alert codes, notifications, schedules, referral code | switch (off), in-progress request, identity check, hold period, no blockers, admin only |
| `admin_run_retention(..., false)` | deletes rows past an approved period | approved rule, no legal hold, `retention_cleanup_enabled` (off), dry run by default, five categories only, audited |
| Publishing a notice | the published text is frozen (a new version replaces it) | review confirmation, all details present |

## 4. Manual test script (use test accounts only)

| # | As | Do | Expect |
|---|---|---|---|
| 1 | visitor | open `/privacy`, `/terms`, `/account-deletion` | pages load; draft banner until published |
| 2 | visitor | register on the website | before publishing: a plain link; after: a required tick-box naming the version |
| 3 | member | `/account/privacy` → switch phone alerts off | switches off; the phone's alert code disappears; re-registering is refused |
| 4 | member | switch it on again | works |
| 5 | member | Download my data | JSON of only their own records |
| 6 | member | send a correction request, then try a second identical access request | corrections appear under Your requests; a second open access request is refused with a plain message |
| 7 | admin | Admin → Privacy → Requests | sees it; assign; move to Being handled; complete with a note |
| 8 | admin | on an access request: try **Download copy** before the identity check | refused with the identity message; record the check, then it works |
| 9 | admin | open **Consent history** for a member | rows appear; the privacy audit shows "consent viewed" |
| 10 | admin | on an erasure request (test account) | **Check what would happen** says identity not checked until it is recorded |
| 11 | staff | open Admin → Privacy | not in the menu; `#privacy` redirects |
| 12 | member (app) | Profile → Privacy & data | same choices and requests as the website; Android back button returns correctly; TalkBack reads each control |
| 13 | any | pull the network cable on a privacy screen | a plain retry message, no crash |

## 5. Rollback

| Change | Rollback | Notes |
|---|---|---|
| 0032 | `0032_privacy_hardening.down.sql` (restores the exact 0030/0031 function bodies; verified identical on a replica; round trip re-apply verified) | keeps `identity_verified_*` columns (evidence) unless you drop them by hand. After a rollback an erasure needs no identity check and `admin_finish_erasure` trusts its caller again: do not leave it rolled back on a live system. |
| Website | revert the commit on `main` and push (the workflow redeploys; it restores `index.html` itself if a deploy fails) | |
| Mobile | ship the previous build; the database is compatible with both | |
| Edge Function | delete it from the dashboard or deploy the previous source | nothing has been deployed |

## 6. Test evidence (19 Oct 2026)

| Suite | Environment | Result |
|---|---|---|
| `phase13_privilege_escalation`, `phase9`–`phase12` | clean replica at production state (through 0031) + 0032 | **PASS** |
| `phase14_privacy_foundation`, `phase15_account_erasure` (updated for the identity gate) | same | **PASS** |
| `phase16_privacy_hardening` (new) | same | **PASS** |
| `0032` apply twice / down / re-apply | same | **PASS**; restored function bodies identical to the originals |
| `phase5`–`phase8` | same | **FAIL: pre-existing**, identical before and after 0032 (older tests encoding earlier-state expectations; not investigated, not modified) |
| Website `vitest` | local | **117 passed** (9 files) |
| Website `lint` / `tsc` / `build` | local | 0 errors (38 pre-existing warnings) / clean / OK |
| `account-erasure-function.test.cjs` | fake client, no network | **26 passed** |
| Mobile `expo lint`, `tsc --noEmit`, `scripts/test-privacy.js` | local | 0 errors, clean, **27 passed** |
| Android manifest after prebuild (temporary copy) | local | 3 permissions marked removed; package id preserved |

**Not tested:** any screen in a browser or on a phone; the live Edge Function; Supabase's soft-delete behaviour and `auth.identities` (`ERASURE_VERIFICATION.md`); 0032 against the live database (apply it, then run the verification queries above).

## 7. Monitoring after release
- Admin → Privacy → Consent & audit: events appear and contain no names or emails.
- `select * from privacy_requests where status in ('submitted','in_progress','awaiting_requester') order by submitted_at;` — requests are being answered. Overdue ones are flagged only if `response_target_days` is set.
- Supabase advisors: still no ERROR-level findings.
