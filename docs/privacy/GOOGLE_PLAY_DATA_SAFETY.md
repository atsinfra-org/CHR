# CHR — Google Play Data Safety Declaration (prepared draft)

**Status: PREPARED, NOT SUBMITTED.** Nothing has been entered in Play Console. This is based on what the app was found to do (code, dependencies, the built APK's permissions) on 19 Oct 2026. DPDP compliance does not by itself satisfy Play policy, and the reverse is also true. Items marked **VERIFY** need a check you or Google must make before submitting. Do not declare "no data collected": that would be false.

App: Colonel Horse Riding Club, package `com.colonelhorseridingclub.app`, version 2.0.0 (build 2).

---

## 1. Facts this declaration rests on

| Fact | Evidence | Status |
|---|---|---|
| No analytics, advertising, crash-reporting or attribution SDK is in the app | `package.json` has none; searched for the usual names | Verified |
| Firebase Cloud Messaging is present (for phone alerts) | `google-services.json`, FCM permission in the built APK, `expo-notifications` | Verified |
| Phone alerts need a push token that is stored on the club's server against the member | `push_devices` table; `register_push_device()` | Verified |
| All server traffic is HTTPS to Supabase | `EXPO_PUBLIC_SUPABASE_URL` is `https://…` | Verified |
| The app edits only the member's name and phone; email comes from sign-in | `profile-api.ts` | Verified |
| The app does not read contacts, location, camera, microphone, photos, calendar, SMS or call logs | no such library or permission use found | Verified (see §4 for permissions Android lists anyway) |
| Card, UPI and bank details are entered inside Razorpay's own window and never reach the club's servers | `razorpay.ts`, backend design | Verified for the club's side |
| Members can ask for account deletion inside the app and on the web | `/profile/privacy`; `/account-deletion` | Built, **not yet live** (needs migrations 0030–0031) |

## 2. Data types to declare

"Collected" = leaves the device to the club's servers or a provider the app uses. "Shared" in Play's sense excludes transfers to a **service provider processing on the club's behalf**; the payment SDK is treated separately below. **VERIFY** each against Play's current definitions before submitting.

| Play category → type | Collected | Shared | Required or optional | Purpose | Notes |
|---|---|---|---|---|---|
| Personal info → **Name** | Yes | No (processor: Supabase) | Required | Account management; App functionality | |
| Personal info → **Email address** | Yes | No | Required | Account management; App functionality | |
| Personal info → **Phone number** | Yes | No | **Optional** | Account management | The app lets the member add it; not required |
| Personal info → **User IDs** | Yes | No | Required | Account management; App functionality | Account id |
| Financial info → **Purchase history** | Yes | No | Required | App functionality | Orders and memberships bought |
| Financial info → **Payment info** | **VERIFY** | **VERIFY — likely Yes (Razorpay)** | Required to pay | App functionality | Razorpay's SDK collects payment details in its own window. Declare it, and read Razorpay's Play guidance. |
| App activity → **Other user-generated content / App interactions** | Yes | No | Required | App functionality | Bookings, attendance, cancellations, weekly schedules |
| Device or other IDs → **Device or other IDs** | Yes | No (processor: Expo/Firebase) | Optional (only if phone alerts are on) | App functionality (notifications) | Expo push token; FCM may create its own installation id — **VERIFY** |
| Messages → **Other in-app messages** | Yes | No | Required | App functionality | In-app notification centre content |

Not collected by the app: location, contacts, photos/videos, audio, files, calendar, health and fitness, web browsing, crash logs/diagnostics (Google Play's own vitals are automatic and are not declared by the developer).

## 3. Security and deletion answers

| Question | Answer | Basis |
|---|---|---|
| Is data encrypted in transit? | **Yes** | HTTPS to Supabase. **VERIFY** that certificate pinning is not required by your policy. |
| Can users request that data be deleted? | **Yes** | In-app: Profile → Privacy & data → Close my account. Web: `/account-deletion`. Provide that URL in Play Console's "Data deletion" section. Needs migrations 0030–0031 live and erasure switched on (`BUSINESS_DECISIONS_REQUIRED.md` §5). |
| Which data is deleted / which is kept? | Identifying profile details, alert codes, notifications, schedules and referral code are removed; payments, orders, memberships, credits, bookings, attendance, audit and consent records are kept without identifying details where possible | Be accurate in the Console's deletion description: it is **not** "all data". |
| Does the app follow the Families policy? | **VERIFY / likely no** | Members may include children (`BUSINESS_DECISIONS_REQUIRED.md` §4). Decide the target audience in Play Console; do not choose "children" without legal advice. |

## 4. Permissions found in the release build (aapt2 on the 18 Oct 2026 APK)

| Permission | Likely source | Needed? | Recommendation |
|---|---|---|---|
| INTERNET, ACCESS_NETWORK_STATE | core | Yes | keep |
| POST_NOTIFICATIONS, VIBRATE, WAKE_LOCK, RECEIVE_BOOT_COMPLETED, `com.google.android.c2dm.permission.RECEIVE` | notifications / FCM | Yes (phone alerts) | keep |
| Launcher badge permissions (about 18 vendor-specific entries) | `expo-notifications` | Not used | harmless; declared by the library |
| **SYSTEM_ALERT_WINDOW** | React Native template | **No** | **Blocked in `app.json` (19 Oct 2026).** A temporary prebuild marked it removed in the generated manifest. **Confirm in the real release build's merged-manifest report.** |
| **NFC** | Razorpay SDK (card tap) | Probably not | **VERIFY** with Razorpay; block if unused |
| READ_BASIC_PHONE_STATE | an SDK | **VERIFY** which | check the merged manifest report; remove if unneeded |
| READ/WRITE_EXTERNAL_STORAGE (to Android 12) | Expo's default list; no code uses file, photo or media APIs (checked by search) | No | **Blocked in `app.json` (19 Oct 2026)**, same confirmation as above |
| `…BIND_GET_INSTALL_REFERRER_SERVICE` | Play install referrer (a library) | No | harmless; declared by a library |

How to see where each permission comes from: build, then open `android/app/build/outputs/logs/manifest-merger-release-report.txt`. The change is made: `expo.android.blockedPermissions` in `app.json` lists `SYSTEM_ALERT_WINDOW`, `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE`. It affects the **next** build only; the APKs already in `release/` still carry the old permissions. NFC and `READ_BASIC_PHONE_STATE` are **not** touched: their sources are unverified (section 6), and removing a permission a payment SDK needs could break checkout.

## 5. Policy points to check before submission

1. **Privacy policy URL.** Use `https://<your-site>/privacy`, and only once the notice is **published** (a draft is not a policy). Play requires the policy link in the Console and in the app (the app links to it from sign-up and Profile).
2. **Payments.** The app sells riding classes, memberships and shop items that are consumed in person, through Razorpay. Google's payments policy separates physical goods and in-person services from digital goods; confirm this classification with the current Play policy text. (**VERIFY**)
3. **Account deletion.** Play requires in-app deletion initiation *and* a web link. Both are built (`/account-deletion` is a public page, in the website working tree and **not live until the website is deployed**). Erasure itself is **switched off and its Edge Function is not deployed**, so the in-app button **creates a request that an administrator handles**; it does not delete anything by itself. Describe it that way in the Console, and do not submit until erasure has been verified (`ERASURE_VERIFICATION.md`) and enabled, or the declaration would promise something that cannot happen yet.
4. **Third-party SDKs.** Razorpay, Firebase (FCM), Expo modules. Each SDK's own data practices must be reflected; check each vendor's Play data-safety guidance. No vendor has been called compliant here.
5. **Signing.** The release build is signed with the debug key. Play needs a proper upload key; decide and set up signing before submission. Do not lose or overwrite an existing keystore.
6. **Target API and testing track.** Not assessed here.

## 6. What I could not verify from the repository

- The exact data Razorpay's SDK collects on a device, and its Play data-safety stance.
- Whether Firebase creates a separate installation identifier that must be listed.
- The source of `READ_BASIC_PHONE_STATE` and the legacy storage permissions.
- How Google classifies the club's payments under its policy today.

Do not submit until these four are checked.
