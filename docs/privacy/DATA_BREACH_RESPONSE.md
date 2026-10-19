# CHR — Data Breach / Security Incident Response Checklist

Operational checklist. No statutory notification deadline is stated here — those must be confirmed against the current DPDP Rules and any applicable CERT-In reporting timeline by qualified counsel before being relied on (see `DPDP_IMPLEMENTATION_PLAN.md` Stage 2). This document was not exercised against a real incident; it has not been tested in practice.

## 1. Detection

- Sources: Supabase project logs/advisors (security + performance), Razorpay dashboard alerts, Resend delivery logs, Expo push error rates, a member/staff report, or an external disclosure.
- First responder: whoever receives the report escalates immediately to whoever holds Supabase project-owner access — do not attempt to "quietly fix" a suspected breach solo.

## 2. Containment

- If a credential (Supabase service-role key, Razorpay secret, Resend/Expo key) is suspected compromised: **rotate it immediately** in the relevant provider dashboard. This audit does not rotate secrets automatically — rotation is always a deliberate, owner-initiated action.
- If the exposure is a code-level access-control gap (like P1-01 in the Gap Register): apply the corresponding fix migration in a controlled deployment (see that migration's own rollback/verification notes) rather than an ad-hoc hotfix.
- If an account is actively being misused: suspend it (`profiles.status = 'suspended'`, via `admin_set_role`'s sibling update path or a direct admin action) rather than deleting it — preserve evidence.

## 3. Investigation

- Pull the relevant `audit_logs` rows for the affected time window (`performed_by`, `action`, `old_values`/`new_values`) — this is CHR's primary forensic trail for admin-level actions.
- Check `payment_webhook_events` for any unexpected event patterns if payments are implicated.
- Check Supabase's own project logs (auth logs, API logs) for the access pattern, if available for the relevant retention window.

## 4. Assessment of affected personal data

- Identify exactly which table(s)/column(s)/row(s) were exposed or altered, using the inventory in `DPDP_DATA_AUDIT.md` §2 to classify sensitivity (e.g. a `profiles` name/phone exposure is materially different from a `payments` amount/status exposure, which is different again from any suspicion touching Razorpay-held card data — which CHR's own database never holds).
- Determine approximate affected-user count from the relevant table, without exporting more data than needed for the assessment itself.

## 5. Preservation of evidence

- Do not delete or modify the implicated rows until the investigation (§3) is complete — this directly conflicts with any "just delete it" instinct and must be called out explicitly to whoever is responding.
- Export only the minimum needed for the record (e.g. the specific `audit_logs` rows, not a full table dump) and store it somewhere access-controlled, separate from the live database.

## 6. Internal escalation

- Business owner informed immediately on any confirmed exposure of personal data, regardless of scale.
- Legal counsel informed before any external communication is drafted (member notification, regulator notification) — content and timing both need review.

## 7. Required notifications

- **To affected individuals and/or the Data Protection Board**: timing and threshold are governed by the DPDP Rules' breach-notification provisions — **confirm the current commencement status and exact timeline from the official MeitY sources before committing to a number in any internal runbook.** This checklist deliberately does not state one.
- If the incident also involves a payment-system anomaly, Razorpay's own incident-reporting channel may need separate notification per CHR's merchant agreement — not reviewed in this audit.

## 8. Remediation

- Apply the specific fix (migration, config change, credential rotation) that closes the root cause — not just the symptom.
- Re-run the Supabase security advisor (`get_advisors`) after any database-level fix to confirm the finding clears.

## 9. Documentation

- Record: what happened, when detected, when contained, what data was affected (by category, not necessarily by listing every individual), what was done, and what notifications were sent and to whom, with timestamps.
- Add a dated entry to this project's own incident history (not yet a formalised log in this repository — consider creating `docs/privacy/incident-log/` the first time this checklist is actually used).

## 10. Post-incident review

- Does the Gap Register need a new entry for a root cause that wasn't previously tracked?
- Does this checklist itself need updating based on what was actually hard about following it during the real incident?

---

**This checklist is not, by itself, a complete breach-response program.** It assumes a human on call who already knows the system; it does not replace having a named, reachable person responsible for security incidents (see `DPDP_IMPLEMENTATION_PLAN.md` Stage 1.4, the grievance officer — a security-incident point of contact may be the same person or a different one; confirm with the business).
