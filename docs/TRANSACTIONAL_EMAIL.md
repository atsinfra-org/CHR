# Transactional email, receipts and payment recovery

Status (20 Oct 2026): **migration 0033 applied, the three functions deployed, Vault switched on.** Emails now send for new payments, memberships and bookings. A live end-to-end send to a real inbox has **not** yet been observed: see "Activation record" at the end.

## How it works

| Step | Where |
|---|---|
| The business function (`fulfill_order`, `book_class`, `reschedule_booking`) writes the member's in-app notification **inside its own transaction**. That row is the authoritative event; if the operation rolls back, so does the row. | existing functions, unchanged |
| An `AFTER INSERT` trigger turns `payment_success`, `membership_activated`, `booking_confirmed`, `reschedule_confirmed` into one `email_outbox` job. The job's `dedupe_key` comes from the business record (order / membership / booking id) and is `UNIQUE`, so a duplicate webhook, the app's sync verify, the reconcile job or a retry cannot create a second email. For `payment_success` it also issues the receipt (one per payment, `UNIQUE`). | `0033_transactional_email.sql` |
| After the transaction commits, `pg_net` calls `email-send` (plus a 5-minute sweep). It claims jobs with `FOR UPDATE SKIP LOCKED`, reads the content from the database (`email_job_context`), sends through Resend with `Idempotency-Key = job id`, and records the outcome. | `functions/email-send` |
| Transient failures (429, 5xx, network) back off 4, 8, 16, 32 minutes, then stop (`max_attempts` = 5). Permanent failures (bad address, rejected) stop at once. Both are visible to staff. | `complete_email_job` |
| Resend's delivery events (delivered / delayed / bounced / complained) update `delivery_status`. "Sent" only means the provider accepted it. | `functions/email-webhook` |
| Every 10 minutes, `payment-reconcile` asks Razorpay about open payments. A **captured** payment goes through the existing `process_payment_webhook` (idempotent). A payment still unconfirmed after 30 minutes gets **one** "still verifying" email. Failed attempts and lookup errors change nothing. | `functions/payment-reconcile` |

Email state is separate from the in-app notification and from push. No payment, credit, membership or booking function is ever called by the email code, so a retry cannot repeat them.

Emails: payment received (with receipt), membership active, class confirmed, class rescheduled, order confirmation (only for orders containing shop items), payment verification in progress.

Receipts are always **"Payment receipt — not a tax invoice."** No tax amounts or invoice numbers are generated. A GSTIN is printed only if `receipt_gstin` is filled in.

## Activation (all manual, in this order)

1. **Resend**: create the account, add and verify your sending domain (SPF and DKIM DNS records). Create an API key.
2. **Function secrets** (Supabase → Edge Functions → Secrets). None go in the mobile app or any `EXPO_PUBLIC_` variable:
   - `RESEND_API_KEY`
   - `EMAIL_FROM`, for example `Colonel Horse Riding <receipts@yourdomain.com>` (must be on the verified domain; there is no default)
   - `EMAIL_FUNCTION_SECRET`, a long random value
   - `EMAIL_REPLY_TO` (optional), `EMAIL_LINK_BASE_URL` (optional, https, the member site; without it emails have no buttons)
   - `RESEND_WEBHOOK_SECRET`, from step 5
   - `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` are already set for the payment functions.
3. **Deploy** `email-send`, `payment-reconcile` and `email-webhook` with `--no-verify-jwt` (the same way as `razorpay-webhook`).
4. **Apply** `0033_transactional_email.sql`. It needs 0030 (it uses `_privacy_cfg`), **not** 0032; it was tested both with and without 0032. Run `tests/phase17_transactional_email.sql` on a replica or staging copy first (it rolls back, but it is not for production).
5. **Resend webhook**: point it at `https://<project-ref>.supabase.co/functions/v1/email-webhook`, tick delivered, delivery delayed, bounced, complained, failed, suppressed. Copy its signing secret into `RESEND_WEBHOOK_SECRET`.
6. **Club details** (SQL on `system_settings`; there is no admin form for these keys yet): `receipt_contact_email`, `receipt_contact_phone`, `receipt_gstin` (only if the club has one), `email_arrival_info`, `email_collection_info`. Name and address come from the privacy settings `legal_entity_name` and `registered_address`. Blank values are simply left out.
7. **Switch on** (SQL editor, once):
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/email-send', 'email_send_url');
   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/payment-reconcile', 'payment_reconcile_url');
   select vault.create_secret('<same value as EMAIL_FUNCTION_SECRET>', 'email_send_secret');
   ```
   Jobs created before this stay queued and go out once it is on. To switch off, delete those three Vault rows.
8. **Verify on staging with a Razorpay test payment**: pay once, check one payment email and one membership email arrive, the receipt shows in the app, and Admin → Emails shows "Sent" then "Delivered". Replay the Razorpay webhook and confirm nothing new is created.

## Things to know

- The recipient is the account's address in `profiles.email`, read at send time. It is never taken from the app. Erased accounts (placeholder `*.invalid`) are skipped and the masked hint in the log is cleared.
- Receipts are issued from the moment 0033 is applied. Payments made earlier have no receipt (the app shows none rather than inventing one). Back-filling old payments would assign receipt numbers retroactively, which is a business decision; it is not done here.
- No email is sent for a failed payment or for `payment_needs_refund`; those keep their in-app notices only.
- All emails are transactional. Nothing here subscribes anyone to marketing.
- **Resend 409.** Resend uses HTTP 409 for two opposite things. `concurrent_idempotent_requests` (the first request with this key is still running) is retried later. `invalid_idempotent_request` (the same key was already used with a *different* body within 24 hours) can never succeed on retry, so the job stops as `failed` with the category "idempotency_conflict" and Admin → Emails says "Possibly already sent: check with the member before retrying". It can mean the first attempt was accepted but its reply was lost, so it is never recorded as sent. An unrecognised 409 stays retryable and is bounded by `max_attempts`. A staff retry reuses the same key, so within 24 hours of the first attempt it will hit the same conflict: check the member's inbox first. Quota errors (429 `daily_quota_exceeded` / `monthly_quota_exceeded`) back off like other 429s and are labelled "sending limit reached".
- Rollback: `0033_transactional_email.down.sql` (deletes the outbox and receipts; export receipts first if any were sent).


## Activation record (20 Oct 2026)

| Step | Result | How it was checked |
|---|---|---|
| 0033 on production | **Applied**, clean slate beforehand (no partial state) | `supabase db query --linked -f` of the exact file (no migration-history rows added, history still has 13 rows); afterwards 2 tables, 17 functions, 3 triggers, RLS on, no client grants on the outbox, 2 receipt policies, 2 cron jobs, 5 settings, empty outbox |
| Rehearsal | phase 17, apply twice, down, re-apply | replica at the production state (0030 and 0031 present, 0032 absent) |
| Functions | `email-send`, `email-webhook`, `payment-reconcile` deployed with `--no-verify-jwt` (each checks its own secret or signature) | function list; the five existing functions have unchanged code hashes |
| Auth of the functions | no or wrong secret: 401 on both; forged or replayed signature: 400 on the webhook (a 500 would mean the secret is missing) | live HTTP calls |
| Webhook algorithm | matches the published Svix reference vector; rejects altered body and stale timestamp | offline |
| `EMAIL_FROM` | `Colonel Horse Riding Club <contact@colonelhorseriding.com>` (on the verified domain) | digest match against candidate values; the value itself is not a credential |
| Shared secret | `EMAIL_FUNCTION_SECRET` was **replaced** with a newly generated value because function secrets are write-only and could not be copied into the Vault; Vault `email_send_secret` holds the same value | SHA-256 of both sides equal |
| Vault | `email_send_url`, `payment_reconcile_url`, `email_send_secret` exist, no duplicates | catalog query |
| Database to functions | HTTP 200 from `email-send` and from `payment-reconcile` through `pg_net` using the Vault secret | `net._http_response` |

**Not yet observed:** a real email leaving Resend, and a Resend delivery event arriving at `email-webhook` and updating `delivery_status`. Both need one real event. See the next section.

### First live test (use an account you own and Razorpay test mode)
1. Make a membership or class purchase with your own account in Razorpay **test mode**, or book a class.
2. In the SQL editor: `select template, status, delivery_status, attempts, last_error_category, created_at from public.email_outbox order by created_at desc limit 10;`
3. Expect `status = sent` within about a minute, then `delivery_status` moving from `accepted` to `delivered` once Resend's event arrives. Check the inbox (and spam).
4. Replay the Razorpay webhook for the same payment: no new outbox row, no second email.
To switch email off at any time: `delete from vault.secrets where name in ('email_send_url','payment_reconcile_url','email_send_secret');` (jobs stay queued and send when it is back on).

### Open settings
- `EMAIL_LINK_BASE_URL` is not set, so emails have no buttons. `EMAIL_REPLY_TO` is not set.
- The club name and address on receipts come from the privacy settings `legal_entity_name` and `registered_address`, which are still empty, so receipts currently omit them. The `receipt_*` and `email_*` settings are also blank.

## Duplicate-payment protection: what is proven, and how to replay safely

A payment can reach the database several times: Razorpay's webhook and its retry, the app's verify call, and the
recovery job. The guarantee is that the second and later deliveries change nothing.

**Layers, from the outside in** (any one of the inner ones is enough to keep the outcome single):
1. `razorpay-webhook` checks the signature over the raw body and passes Razorpay's delivery id on as the idempotency key.
2. `process_payment_webhook` records each event id once (`payment_webhook_events`) and returns early if the payment is already `success` or `failed`.
3. `fulfill_order` returns early unless the order is still `pending`.
4. Unique keys: one membership per order line, one receipt per payment, one email job per `dedupe_key`.

| Test | What it proves | Run it |
|---|---|---|
| `phase17_transactional_email.sql` | one membership, credits once, one receipt, one `payment_received`, one `membership_activated`, one in-app notice of each kind, after the same event twice, a `sync:` event and a `reconcile:` event | replica only |
| `phase18_duplicate_payment_protection.sql` | all of the above **plus** one payment record that is not rewritten, a whole-state snapshot unchanged after 14 duplicate deliveries, no receipt number consumed, replays after the emails were sent, a late `failed` event, a different amount, a rolled-back delivery that Razorpay's retry then completes | replica only |
| `duplicate-payment-concurrency.sh` | the same payment delivered by 4 to 6 sessions released within about a millisecond, 20 orders: every order ends with exactly one of everything, no session errors | disposable local clone only (it refuses a hosted database or one that has members) |
| `razorpay-webhook-function.test.cjs` | signature checked over the raw body, refusals reach no database call, the idempotency key is stable across retries, only `payment.captured` is acted on | `node supabase/tests/razorpay-webhook-function.test.cjs` |

Each was also run against deliberately broken copies (a guard removed) to confirm it fails when it should. Note that
phase 17 alone does **not** notice a missing layer 1 or 2, because layers 3 and 4 hide the damage; phase 18 does.

**Known gap, not fixed here:** if the customer pays a second time against an order that is already paid (a different
gateway payment id), the second payment is ignored silently. No membership, credit, receipt or email is duplicated, but
nothing flags it for a refund. The closed-order case (`PAYMENT_FOR_CLOSED_ORDER`) already does this; the same alert
would be worth adding for a second capture on a paid order.

### Replaying the original Razorpay webhook, safely
Never replay it against production, and never use Razorpay's "resend" button (it sends to the configured production
endpoint). Instead:
1. **Isolate.** Use a disposable local database (a clone of the schema) or a separate staging project, plus the function
   running locally (`supabase functions serve razorpay-webhook`) or deployed to staging, with its **own made-up**
   `RAZORPAY_WEBHOOK_SECRET`. Do not copy the production secret, keys or payment ids anywhere.
2. **Build the fixture.** Create a test member and an unpaid membership order there, and set the payment's
   `gateway_order_id` to a made-up value such as `order_REPLAY1`. Use a made-up payment id and the order's real amount in paise.
3. **Reuse only the SHAPE** of the original event (copy the JSON from the Razorpay dashboard's event log, then replace the
   ids, amount and any customer fields with fixture values). Save it to a file.
4. **Sign the exact bytes** with your test secret and post the same bytes with `--data-binary` (no re-formatting, which would break the signature):
   ```
   SIG=$(node -e 'const c=require("crypto"),fs=require("fs");process.stdout.write(c.createHmac("sha256",process.env.TEST_SECRET).update(fs.readFileSync("event.json")).digest("hex"))')
   curl -sS -X POST "$STAGING_URL/functions/v1/razorpay-webhook" -H "X-Razorpay-Signature: $SIG" -H "x-razorpay-event-id: evt_replay_1" --data-binary @event.json
   ```
   Send it the same way several times with the same event id, then with new event ids, then at the same moment from two terminals.
5. **Check the counts** in the isolated database (one payment, one membership, one credit grant, one receipt, one email of each kind) with the queries at the top of `phase18_duplicate_payment_protection.sql`.
6. If a live-style test through Razorpay itself is wanted, point a **second** Razorpay test-mode webhook at the staging function (with the staging secret) and make a **new** test payment against staging. Do not reuse the production payment.

## Resend template for the membership email (optional, OFF by default)

By default every email, including `membership_activated`, is built by `supabase/functions/email-send/templates.ts` and sent
to Resend as raw HTML and plain text. Nothing uses a Resend template unless you switch it on. The published Resend
template **Membership Confirmation** (id `f394ace4-e556-4438-a4ec-102bb7851989`, alias `membership-confirmation`) can
be used for `membership_activated` **only**. Payment receipts, class confirmations, reschedules, shop orders and the
"still verifying" email always stay on the existing rendering.

### How the template is called
`POST https://api.resend.com/emails` with the same `from`, `to`, `reply_to`, subject and `Idempotency-Key` (the job id) as
today, and a `template` object **instead of** `html` and `text` (Resend rejects both together):
```
{ "from": "...", "to": ["<member>"], "reply_to": "...", "subject": "Your CHR membership is active",
  "template": { "id": "f394ace4-e556-4438-a4ec-102bb7851989", "variables": { "PLAN_NAME": "Gold Membership", ... } } }
```
The code is `supabase/functions/email-send/resend-template.ts` (pure, unit-tested) and a small branch in `index.ts`.
The payload shape follows Resend's Send Email reference. Only a **published** template can be sent, and only its most
recently published version.

### Variables (what the template must register, and where each value comes from)
| Variable | Required | Real source |
|---|---|---|
| `MEMBER_NAME` | no (becomes "there") | the member's profile name |
| `PLAN_NAME` | **yes** | the membership's plan name |
| `CLASS_CREDITS` | **yes** | the membership's total classes |
| `START_DATE` | **yes** | membership start, for example "Tue, 20 Oct 2026" |
| `END_DATE` | **yes** | membership end |
| `RESCHEDULES_ALLOWED` | no | the plan's reschedule allowance (left out if unknown) |
| `DASHBOARD_URL` | no | `EMAIL_LINK_BASE_URL` + `/account` (left out without an https base) |
| `CLUB_NAME` | no | the privacy setting `legal_entity_name`, else "Colonel Horse Riding Club" |
| `CLUB_ADDRESS`, `CLUB_CONTACT_EMAIL`, `CLUB_CONTACT_PHONE` | no | privacy and receipt settings (left out if blank) |

Rules this follows (Resend): keys use ASCII letters, digits and underscore only, at most 50 characters; the names
`FIRST_NAME`, `LAST_NAME`, `EMAIL`, `UNSUBSCRIBE_URL`, `contact` and `this` are reserved. Declare all of them as type
**string**. Values are HTML-escaped by the code before they are sent, because a member types their own name.
If a **required** value is missing in the database, the template is not used and the standard email is sent. Optional
values that are blank are omitted, so **give every optional variable a fallback value in Resend**, or a missing one makes
Resend refuse the send (the standard email is then sent instead).

### Why the dashboard shows "No variables"
Resend variables are written with **triple braces**, `{{{PLAN_NAME}}}`, and are created in the editor (type `{{`, or
choose **Variable**), which shows them as chips and registers them. Text typed as `{{name}}` is just text: Resend's
documentation does not say double-brace placeholders are substituted, the dashboard registers nothing, and a member
would receive the literal words "Hi {{name}}". So a template whose preview shows `{{name}}` and "No variables" is **not
ready**, and sending variables to it proves nothing. This was not tested against Resend (that needs an API call with a
key and a send); it is the documented behaviour.

### Checking the template (read-only, sends nothing)
```
RESEND_API_KEY=<a temporary full-access key> node supabase/tools/inspect-resend-template.cjs
node supabase/tools/inspect-resend-template.cjs --file saved-template.json     # no key needed
```
It prints the registered variables, the `{{{triple}}}` placeholders and any plain `{{double}}` text in the body, and says
READY or lists the problems. When ready it prints the exact value for `EMAIL_MEMBERSHIP_TEMPLATE_VARIABLES`. A
sending-only key may be refused by the template endpoint (Resend does not say): use a temporary full-access key and
delete it afterwards. The key is read from the environment, never printed and never written to disk.

### Safe activation (nothing changes until the last step)
1. **Fix the template in Resend.** Replace each plain `{{name}}` with a real variable using the names above (type `{{`,
   choose Variable, name it, give optional ones a fallback), then **Publish** again. Edits that are not re-published are not sent.
2. **Run the inspect tool.** Proceed only when it says READY and shows no plain-text placeholders.
3. **Test the look without involving the app:** in Resend, use the template's own *Send test email* to an address you own.
   Check it with a member name containing an apostrophe and an ampersand (for example `Siobhan O'Brien & Sons`): it must read
   correctly with no `&#39;` or `&amp;` showing and no `{{` anywhere. If it shows `&#39;`, Resend escapes too and the code's
   escaping needs to be switched off before going further (a one-line change, with its test).
4. **Set `EMAIL_MEMBERSHIP_TEMPLATE_VARIABLES`** (Supabase → Edge Functions → Secrets) to the value the tool printed.
   Still nothing changes: the template is off until the flag below.
5. **Deploy** `email-send` (`--no-verify-jwt`, same as before). Still off.
6. **Switch on** with `EMAIL_MEMBERSHIP_TEMPLATE_ENABLED=true`. Do it when no email jobs are waiting to retry (Admin → Emails, or
   `select status, count(*) from email_outbox group by status;`): a job that already tried once with the standard email
   and is retried with the template would meet Resend's idempotency rule and stop as "possibly already sent".
7. **Watch the first real `membership_activated`** (your own account in Razorpay test mode): check the inbox, that
   Admin → Emails shows Sent then Delivered, and that the function log has no "Resend rejected the template request".
8. **Switch off** at any time by deleting `EMAIL_MEMBERSHIP_TEMPLATE_ENABLED` or setting it to anything other than `true`.
   New jobs use the standard email immediately; nothing else needs undoing.

### If Resend rejects the template request
A definitive rejection (400, 404 or 422) means nothing was sent, so the function immediately sends the standard email with its
own idempotency key (`<job id>:standard`). The member still gets a confirmation, and the function log records
`email-send: Resend rejected the template request` with the status and Resend's short error name (never the address). It
shows as a normal "Sent" in Admin → Emails, so **check the log after activating**. A timeout, 429 or 5xx is not a rejection:
the same template request is retried later with the same key, exactly as any email. Quota errors, domain or key problems
(401/403) and the 409 idempotency cases behave as described under "Resend 409" above.

### What is verified and what is not
Verified by automated tests with a fake Resend (no email sent): the payload and id, the variable mapping and escaping,
required and optional data, every email type other than `membership_activated` staying on the standard rendering, the
fallback, retry and idempotency behaviour, the default-off behaviour, and the diagnostic tool. **Not verified**, because it
needs a real send or a Resend API key: that Resend accepts exactly these variable names once the template is fixed, whether
it accepts a variable the template did not register, whether it escapes values itself, that an alias really works as `template.id` (Resend's Send Email reference says it does; the code defaults to the id),
and whether it generates a plain-text version for a template send.

## Welcome email for new accounts (optional, OFF until you switch it on)

> **Never re-run migration 0033 after 0034.** 0033 recreates `email_job_context()` without the `welcome` branch, so every welcome job would be skipped as `unknown_template`. If 0033 ever has to be re-run, re-run 0034 immediately afterwards (it is safe to run twice).

A short personalised welcome is sent **once**, to a genuinely new account, through the same outbox, idempotency, retry,
delivery tracking and Admin → Emails screen as every other email. The published Resend template **CHR Welcome Email**
(`069feb9c-1406-49d0-ac7a-7a9f46f4c90d`) can be used for it; without the template the same job sends the standard
HTML/text welcome from `templates.ts`. There is no second sender.

### Purpose and the two variables
The template receives **exactly** two variables, named in lower case as published:
```
{ "name": "<display name>", "dashboard_url": "https://colonelhorseriding.com" }
```
`name` is the profile's own name (`profiles.full_name`): control characters removed, spaces collapsed, at most 100
characters, HTML-escaped; if the profile has no name it is **`Rider`**. The email address is never used as a name.
`dashboard_url` is fixed. Nothing else is sent. Sender, reply-to, subject, `Idempotency-Key` (the job id) and the fallback
on a definitive rejection (400/404/422 → standard welcome under `<job id>:standard`) are the shared ones.

### Settings
| Setting | Where | Default | Meaning |
|---|---|---|---|
| `EMAIL_WELCOME_TEMPLATE_ENABLED` | function secret | `false` (unset) | Only the exact text `true` uses the template. Anything else sends the standard welcome. |
| `RESEND_WELCOME_TEMPLATE_ID` | function secret | unset | `069feb9c-1406-49d0-ac7a-7a9f46f4c90d` (or an alias). **No built-in default**: unset or malformed means the template is not used. |
| `welcome_email_start` | `system_settings` row created by 0034 | blank | Blank = **no welcome email is queued at all**. An explicit timestamp **with a zone** (`2026-10-21T09:30:00Z`, `...+05:30`, `...-04:00`) = welcome accounts created at or after it. Blank, date-only, no offset, impossible dates, `now`, `epoch`, `tomorrow`, `infinity`, text or numbers all keep it OFF. |

Recommended values once you have reviewed it: `RESEND_WELCOME_TEMPLATE_ID=069feb9c-1406-49d0-ac7a-7a9f46f4c90d` and
`EMAIL_WELCOME_TEMPLATE_ENABLED=false`. Neither the id nor the flag is a secret you must hide, but set them under
Supabase → Edge Functions → Secrets like the others. Resend's API key is the existing `RESEND_API_KEY`.

### How a new registration is detected
The authoritative moment is in the database, not the app. Registration (web **and** mobile, email/password **and** Google)
creates a row in `auth.users`; the existing `handle_new_user()` trigger turns it into the profile. 0034 adds two triggers on
`auth.users` that queue the welcome when the address first becomes **confirmed**:

| Event | Result |
|---|---|
| Google sign-in creates the account (confirmed on insert) | one welcome |
| Email sign-up with confirmation switched off (confirmed on insert) | one welcome |
| Email sign-up with confirmation on: nothing at sign-up (the address is unproven) | none yet |
| …the member clicks the confirmation link (`email_confirmed_at` goes from empty to set) | one welcome |
| Login, session refresh, repeated OAuth callback, Google login by an existing user, password reset, email change, profile edit or sync, any later update | none |
| Anyone whose account was created before `welcome_email_start` (including people who confirm late) | none |

It does **not** hook the profile INSERT, because a profile can be written again by sync/backfill; and it does not use
anything the browser sends, so there is no client-side sending and no secret in the app.

### How duplicates are prevented
1. `email_outbox.dedupe_key` is UNIQUE and is `welcome:<user id>`: a replayed confirmation or a second trigger cannot make a second job.
2. The triggers fire only on the empty → confirmed transition (or an insert already confirmed), so ordinary updates never reach the queue.
3. A retry re-sends the **same** job with the same `Idempotency-Key`, so Resend also refuses a second message.
4. Every step swallows its own errors, so a problem here can never block sign-up.

### No back-fill
0034 does not insert any job. `welcome_email_start` is blank when it is applied, and when you set it only accounts created
from that moment on qualify. To switch on:
```
update public.system_settings set value = to_jsonb(to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), updated_at = now() where key = 'welcome_email_start';
```
To switch off: set the value back to `""`. Jobs already queued still send.

### Testing safely (nothing here touches production or sends mail)
* `node supabase/tests/transactional-email-functions.test.cjs`: adapter, handler (fake Resend), variables, fallbacks, flag/id handling, membership and other emails unchanged, the diagnostic tool.
* `supabase/tests/welcome-migration-lifecycle.sh` (local replica only): apply twice, constraint drift fails loudly, rollback keeps history, reapply.
* `supabase/tests/phase19_welcome_email.sql` on a **local replica** with 0016–0034 applied (it inserts into `auth.users`, rolls back, uses `@example.org` users): new email sign-up, new Google, existing login, replays, profile sync, no back-fill, bad setting, privileges. The replica's stub `auth.users` needs an `email_confirmed_at timestamptz` column (Supabase has it).
* Check the Resend template without sending: `RESEND_API_KEY=<temporary full-access key> node supabase/tools/inspect-resend-template.cjs --welcome 069feb9c-1406-49d0-ac7a-7a9f46f4c90d`, or save the response and use `--file saved.json --welcome`. It must say READY. **Not yet verified**: the template is published as `name` and `dashboard_url`; the membership template turned out to hold plain `{{name}}` text with no registered variables, so run this tool first, and in Resend use *Send test email* with a name like `Siobhan O'Brien & Sons` to confirm it is not double-escaped (`&#39;`).

### Enabling after review (in this order; each step is safe on its own)
1. Apply `0034_welcome_email.sql` in the SQL Editor. It stops with a clear error (and changes nothing) if `email_outbox` carries an unexpected CHECK on `template` or `related_type`. Still nothing is queued. `0034_welcome_email.down.sql` reverses it and **keeps every welcome row** (if any exist, `email_outbox` keeps allowing `welcome` / `user`; unsent welcome jobs become `skipped`).
2. Run the inspect tool (above) until READY; send a Resend test email to an address you own.
3. Set `RESEND_WELCOME_TEMPLATE_ID` and leave `EMAIL_WELCOME_TEMPLATE_ENABLED` unset/`false`; deploy `email-send` (`--no-verify-jwt`). Welcomes (once switched on) would use the standard HTML/text version.
4. Set `welcome_email_start` (above). Register a throw-away account you own; confirm Admin → Emails shows one *Welcome email* job, Sent, then Delivered.
5. Set `EMAIL_WELCOME_TEMPLATE_ENABLED=true`. Register another throw-away account; check the inbox, and the function log for "Resend rejected the template request". To go back: remove the flag; to stop welcomes altogether: blank `welcome_email_start`.

### Things to know
* Confirmation behaviour is whatever the Supabase project already does; this feature only follows it. If **Confirm email** is on, the welcome arrives after the member confirms; if it is off, at sign-up.
* A welcome job is skipped (not failed) when the account has since been erased.
* Admin → Emails lists it as *Welcome email*, related to the user.
* Existing members are never emailed because this was introduced. Anyone who signed up before `welcome_email_start` stays unwelcomed.
