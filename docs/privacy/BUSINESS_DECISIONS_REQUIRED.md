# CHR — Business and Legal Decisions Required

Updated 19 Oct 2026. Everything the engineering work could safely build is built. What follows is what **only the club's owner, its accountant or qualified Indian legal counsel can supply or decide**. Nothing here has been guessed, and no placeholder is published as if it were real. **Technical implementation is not proof of legal compliance**; the items marked `LEGAL_REVIEW_REQUIRED` need counsel.

Labels: **BUSINESS_DECISION_REQUIRED** (the club decides) · **LEGAL_REVIEW_REQUIRED** (counsel must confirm) · **ACTION** (a task, no judgement needed) · **VERIFY** (a technical fact that needs a test or a vendor answer).

Where a decision is entered in the product it is entered in **Admin → Privacy** ("Notice & details" and "Retention" tabs). Until it is entered, the related feature stays off or shows an honest "not yet provided" state.

Each item has the same five parts: **why it matters · what is needed · affected feature · the technical default today · the consequence of leaving it open.**

---

## The 16 decisions

### 1. Exact legal entity name and registered address — BUSINESS_DECISION_REQUIRED
- **Why:** the notice must say who decides why and how members' data is used (the "data fiduciary"). A trading name may not be the legal entity.
- **Needed:** the exact registered name and postal address.
- **Affects:** privacy notice, website footer, app notice screen. Setting keys `legal_entity_name`, `registered_address`.
- **Default:** unset. The notice shows "[not yet provided]" for a missing required value and **the database refuses to publish** until both are filled in.
- **If left open:** the notice can never be published; registration shows only a plain link; no consent can be recorded for the essential service.

### 2. Official privacy contact email (and phone) — BUSINESS_DECISION_REQUIRED
- **Why:** members need a monitored place to send privacy questions and requests.
- **Needed:** a monitored inbox; optionally a phone number.
- **Affects:** notice, account-deletion page, Settings keys `privacy_contact_email`, `privacy_contact_phone`.
- **Default:** unset; the email is required for publishing, the phone is optional (an unset phone line is left out, never shown empty).
- **If left open:** same as 1.

### 3. Grievance officer / designated contact — BUSINESS_DECISION_REQUIRED, LEGAL_REVIEW_REQUIRED
- **Why:** the Rules (G.S.R. 846(E), 13 Nov 2025) require a published contact for questions about processing (Rule 9) and a published grievance process (Rule 14(3)). Whether CHR needs a Data Protection Officer in the strict sense (a Significant Data Fiduciary matter) is a legal question; a named contact is needed either way. *Rule numbers are as summarised in earlier work and not re-read from the Gazette in this task: counsel to confirm.*
- **Needed:** a real, reachable person or role: name, email, optionally phone and designation.
- **Affects:** notice ("Who to contact with a complaint"). Keys `grievance_officer_name`, `grievance_officer_email`, `grievance_officer_phone`, `dpo_designation`.
- **Default:** name and email are required to publish; phone and designation optional.
- **If left open:** the notice cannot be published.

### 4. Retention periods for each category — BUSINESS_DECISION_REQUIRED, LEGAL_REVIEW_REQUIRED
- **Why:** personal data should not be kept indefinitely without a purpose; some records must be kept by law (tax and accounting) and the Rules are summarised as requiring at least one year's retention of processing logs (Rule 8(3); Rule 6(1)(e)), even after an erasure request: **counsel to confirm**.
- **Needed:** for each of the **15 categories** in Admin → Privacy → Retention, a number of days and the reason. **Ask the accountant for the statutory minimum for payment and order records.**

  | Category | The question |
  |---|---|
  | payments_orders | Statutory minimum for tax and accounting, then the club's own maximum. |
  | payment_webhook_events | Only needed for idempotency; likely far shorter than payment records. Holds copies of customer details as the provider sent them. |
  | audit_logs | Long, for accountability. Note: keeps before/after copies of changed records. |
  | attendance_notes | Should free-text staff notes exist, and for how long? Staff guidance on what belongs there. |
  | notifications, push_devices_disabled, push_deliveries | Delivery and notice content; low sensitivity. |
  | enquiries | Contact-form submissions from non-members (answered ones only are ever removed by a timer). |
  | privacy_requests, consent_events | Evidence of how requests were handled and what members agreed to; normally kept. |
  | member_profiles | Closed accounts' skeleton rows and long-inactive members. |
  | auth_records | Sign-in records held by Supabase Auth. |
  | memberships_credits, bookings_attendance | Financial and dispute record; class history. |
  | uploaded_documents | None are collected today (no storage buckets; no avatars set). |
- **Affects:** Admin → Privacy → Retention; the cleanup executor `admin_run_retention`.
- **Default:** every rule **unapproved**, no number set. **Nothing is deleted anywhere.** Even once approved, the executor acts on five low-risk categories only (notifications, switched-off phone-alert codes, delivery logs, **answered** enquiries, staff attendance notes) and **only while `retention_cleanup_enabled = true`** (off). Payments, audit logs, privacy requests, consent evidence, profiles, memberships and bookings are **never** deleted by a timer; they need a reviewed manual decision. No cron job is scheduled.
- **If left open:** data is kept indefinitely (the notice's "How long we keep it" cannot be written). This is the safe default but not a policy.

### 5. Policy for members under 18, and parental consent — LEGAL_REVIEW_REQUIRED + BUSINESS_DECISION_REQUIRED
- **Why:** the Rules are summarised as requiring verifiable parental consent before processing a child's data (Rule 10), with exemptions (Rule 12; Fourth Schedule). CHR collects a date of birth and may have under-18 riders. **No parental-consent mechanism exists** and none should be improvised.
- **Needed:** legal view on exemptions; business choice: may under-18s register themselves? Must a parent hold the account? What verification is reasonable?
- **Affects:** registration, notice ("Children" section, key `children_policy_text`), Admin overview (counts under-18s by date of birth only).
- **Default:** none. Production currently shows **0** members under 18 by date of birth (checked 19 Oct 2026; 18 profiles).
- **If left open:** the notice cannot be published (the children text is required); any under-18 registration is unmanaged.

### 6. Active memberships when erasure is requested — BUSINESS_DECISION_REQUIRED
- **Why:** closing an account must not silently confiscate paid value.
- **Needed:** cancel and refund? run to expiry first? forfeit on request?
- **Affects:** account erasure (`_erasure_blockers`: `active_membership`).
- **Default:** erasure is **refused** while an active membership with an unexpired period exists. The workflow never cancels, refunds or forfeits anything.
- **If left open:** such members cannot be erased until the club settles each case by hand.

### 7. Unused membership credits and wallet balance — BUSINESS_DECISION_REQUIRED
- **Why:** same as 6; a referral-wallet balance is also value.
- **Needed:** pay out, forfeit with notice, or require use first.
- **Affects:** erasure blockers `active_membership`, `wallet_balance`.
- **Default:** blocked, as 6. (Expired memberships have their credits lapsed by the daily job.)
- **If left open:** as 6.

### 8. Future and recurring bookings on erasure — BUSINESS_DECISION_REQUIRED
- **Why:** cancelling classes without notice harms the member and the club.
- **Needed:** cancel (credit returned or not, under the existing cancellation setting) or wait until they are ridden.
- **Affects:** erasure blocker `future_bookings`; the weekly schedule is removed only when nothing is outstanding.
- **Default:** blocked.
- **If left open:** as 6.

### 9. Treatment of payment and accounting records — BUSINESS_DECISION_REQUIRED, LEGAL_REVIEW_REQUIRED
- **Why:** payments, orders and ledgers are kept for tax, accounting and disputes; whether and how they stay linked to a person after erasure is a legal and accounting question.
- **Needed:** statutory minimum (accountant), the club's own maximum, and whether to keep a name on records after erasure.
- **Affects:** erasure (these records are **kept**, linked by id, not name), retention rules `payments_orders`, `payment_webhook_events`, `memberships_credits`.
- **Default:** kept indefinitely; never deleted by any automation; the profile row stays (name and contact blanked) so every ledger keeps its link. Audit-log snapshots keep pre-erasure names by design (an open decision: they are evidence; redaction risks the log's integrity).
- **If left open:** records grow without a documented period.

### 10. Whether and how marketing communications will be used — BUSINESS_DECISION_REQUIRED
- **Why:** optional marketing must be a separate, optional purpose with its own wording, never bundled with registration or a purchase.
- **Needed:** yes/no; channels; wording; who sends.
- **Affects:** consent purpose `marketing_communications`.
- **Default:** the purpose exists but is **inactive** (not offered, cannot be consented to). **No marketing message is sent by any code today.** Withdrawing phone-alert consent never affects essential account, booking, payment or security messages.
- **If left open:** no marketing can be sent. This is correct.

### 11. Consent and notice strategy for existing members — LEGAL_REVIEW_REQUIRED
- **Why:** existing members have no recorded consent and must **not** be recorded as having consented.
- **Needed:** counsel's view on whether the law needs more than a notice from the start date; what to do on a material notice change (re-acknowledge?).
- **Affects:** member banner (website and app), `my_consents`, notice versioning.
- **Default:** once a notice is published, existing members see a **non-blocking** "please read our notice" banner. A member can acknowledge it (recorded once, against that exact version, with the server's time) or dismiss it for the current browser session; if dismissed it can return in a later session until they acknowledge it. It never blocks booking, payment or sign-in. No fake records are created; the optional phone-alert choice stays as the member left it. A new notice version prompts again.
- **If left open:** members who never acknowledge have no recorded acknowledgement. That is the honest state, not a defect.

### 12. Processor contracts and data-processing arrangements — ACTION + LEGAL_REVIEW_REQUIRED
- **Why:** each provider processes members' data for the club.
- **Needed:** someone reads the current terms or data-processing agreement of each provider below and confirms the points. **No provider has been called compliant anywhere in this work.**
- **Affects:** notice ("Who receives your data"), Play Data safety answers.
- **Default:** none.
- **If left open:** the notice's provider list may not match reality.

### 13. Third-party service providers and data locations — ACTION + LEGAL_REVIEW_REQUIRED
- **Why:** the notice must say who receives data and where it is processed; Rule 15 on cross-border transfer needs a legal view.
- **Needed:** per provider, confirm what they receive and where.

  | Provider | Receives | To confirm |
  |---|---|---|
  | Supabase | everything in the database; sign-in data | project region; their terms; sub-processors (key `data_location_statement`) |
  | Razorpay | amount, order and payment references; name/email as prefilled at checkout; card/UPI/bank details entered directly with Razorpay | their terms and retention; refunds and disputes |
  | Resend | enquiry name, age, email, phone, topic, in an email to staff | their retention of email content; region |
  | Expo (+ Google FCM) | a phone-alert code, notification title and text | retention; terms |
  | Google | only for Google sign-in: email, name, profile picture link | OAuth scopes actually requested |
  | Hosting | website traffic logs; no member database | region, logging, retention. **Production currently serves from Netlify; an EC2 instance is being set up** — confirm which will be live |
- **Default:** none; the notice's data-location text is required to publish.
- **If left open:** the notice cannot be published.

### 14. Account-erasure waiting period, response target and escalation — BUSINESS_DECISION_REQUIRED, LEGAL_REVIEW_REQUIRED
- **Why:** a waiting period interacts with the one-year retention point in item 4; response times need an owner.
- **Needed:** days to wait after an erasure request (`erasure_hold_days`); the club's own target in days for answering requests (`response_target_days`); who is told when a request is overdue.
- **Affects:** erasure, request due dates and the "overdue" flag in Admin.
- **Default:** both unset. No deadline is invented. Overdue requests are **flagged** in Admin; **no automatic escalation or email exists**. The 90-day outer limit the Rules are summarised as setting (Rule 14(3)) is **not enforced** in code.
- **If left open:** requests have no due date; erasure has no waiting period (after the switch is on).

### 15. Official notice and account-deletion URLs — ACTION
- **Why:** Google Play needs a public privacy policy URL and an account-deletion web link.
- **Needed:** confirm the final addresses.
- **Affects:** Play Console, app links, website footer.
- **Default:** the website has public pages `/privacy`, `/terms` and `/account-deletion` **in the working tree; they are not live in production until the website is deployed**. `/privacy` shows a clearly marked draft until a notice is published. The Instagram and Facebook footer links still point to `#` (addresses not supplied).
- **If left open:** Play submission cannot name valid URLs.

### 16. Google Play Data safety answers needing confirmation — BUSINESS_DECISION_REQUIRED
- **Why:** the declaration must match what the app actually does, the notice and the Console's deletion description.
- **Needed:** see `GOOGLE_PLAY_DATA_SAFETY.md` §6: Razorpay SDK data practices, Firebase identifiers, `READ_BASIC_PHONE_STATE` and NFC sources, how Google classifies the club's payments, the target audience (Families policy), and the production signing key.
- **Affects:** Play Console submission.
- **Default:** prepared draft, **not submitted**.
- **If left open:** do not submit.

---

## Added by the 19 Oct 2026 audit (new decisions)

### A. How is a requester's identity checked? — BUSINESS_DECISION_REQUIRED
- **Why:** an erasure is destructive and a data copy is a disclosure; both now **require** an administrator to record an identity check first (0032), made by a different admin from the requester.
- **Needed:** the club's actual method (call-back to the number on file, email confirmation from the address on file, in person) and who is authorised to do it. Staff need guidance to record only *how* they checked, never ID numbers.
- **Default:** the four methods in the admin screen (phone call-back, email confirmation, in person, other). Without a recorded check, erasure and admin data exports are refused.
- **If left open:** admins cannot produce data copies or carry out erasure.

### B. Turning on automatic retention cleanup — BUSINESS_DECISION_REQUIRED
- **Why:** deletion is irreversible.
- **Needed:** approved periods (item 4), then an operator runs `admin_run_retention(<category>)` as a **dry run first**, reviews the count, and only then `p_dry_run => false` after setting `retention_cleanup_enabled = true`. Deciding whether to schedule it at all.
- **Default:** switch off; nothing scheduled; the Admin page can only count.
- **If left open:** nothing is cleaned up.

### C. Verify Supabase's soft delete and identity records — VERIFY
- **Why:** the Edge Function replaces the sign-in email with a placeholder, clears the sign-in metadata and bans the login before the soft delete, but whether Supabase keeps copies of the person's details in `auth.identities` after a soft delete is **not confirmed**.
- **Needed:** run the test-account procedure in `ERASURE_VERIFICATION.md`.
- **Default:** erasure is switched off and the Edge Function is **not deployed**.
- **If left open:** do not enable erasure.

### D. Members' own mobile review — ACTION
- **Why:** the app's privacy screens, back-button behaviour and screen-reader labels have **not been tested on a device**.
- **Needed:** a pass on a real Android phone before release (`DEPLOYMENT_AND_VERIFICATION.md` §9).

---

## Security actions (status as of 19 Oct 2026)

| Action | Status |
|---|---|
| `0028_privilege_escalation_fix.sql` (staff could promote themselves to admin) | **Applied and verified in production** (live trigger source checked read-only, 19 Oct 2026). Do not repeat or revert. |
| `0029_search_path_hardening.sql` | **Applied and verified.** |
| Leaked-password protection | **ACTION, still open**: Supabase Dashboard → Authentication → Policies. The security advisor run on 19 Oct 2026 still reports it off. |
| Do not delete users from the Supabase dashboard | Deleting a login cascades into the profile and, for a member with no payments or bookings, silently deletes their membership and wallet records. Use the erasure workflow once enabled. |
