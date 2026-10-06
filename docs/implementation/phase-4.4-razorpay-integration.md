# Phase 4.4 — Razorpay Payment Integration

## Architecture

```
MembershipPurchase.jsx
  → initiate_membership_purchase()          [Phase 4.3, unchanged]
  → RazorpayPaymentFlow.jsx
      → POST /functions/v1/razorpay-create-order   (user JWT, no service key)
          → validates payment ownership + state via RLS
          → creates the Razorpay Order server-side (amount from the DB, never the client)
          → attach_gateway_order()  [new, compare-and-swap, idempotent]
      → Razorpay Checkout (server-created order_id only)
      → POST /functions/v1/razorpay-verify-payment  (user JWT, service key used only for the final RPC)
          → re-verifies HMAC signature against the SERVER-STORED order id
          → re-fetches the payment from Razorpay's API (must be 'captured')
          → process_payment_webhook()  [service_role only]
Razorpay servers
  → POST /functions/v1/razorpay-webhook           (no Supabase JWT — X-Razorpay-Signature only)
      → verifies HMAC over the RAW body
      → process_payment_webhook()  [service_role only, same function as above]
```

`process_payment_webhook()` is the **single** place a membership is ever activated. Both the synchronous verify call and the async webhook funnel into it, and it is idempotent (`payment_webhook_events.event_id` unique constraint + a payment-already-finalized check), so whichever path reaches it first wins and the other is a guaranteed no-op — this is what makes the flow safe against a closed browser tab, a dead network right after payment, or Razorpay retrying a webhook delivery.

## Required setup (cannot be done by Claude — needs your Razorpay account)

Three secrets must be set on the Supabase project (Edge Function secrets, **not** `.env`/Vite vars — nothing here reaches the browser):

```
supabase secrets set RAZORPAY_KEY_ID=rzp_test_xxxxx
supabase secrets set RAZORPAY_KEY_SECRET=xxxxx
supabase secrets set RAZORPAY_WEBHOOK_SECRET=xxxxx
```

(or via Supabase Dashboard → Project Settings → Edge Functions → Secrets). Use **Test Mode** keys first — see `RAZORPAY_KEY_ID`/`KEY_SECRET` from Razorpay Dashboard → Settings → API Keys.

Then, in Razorpay Dashboard → Settings → Webhooks, add a webhook pointing at:

```
https://scmisanphmmtemfaqzqa.supabase.co/functions/v1/razorpay-webhook
```

subscribed to exactly two events: `payment.captured` and `payment.failed`. The **Webhook Secret** you set there is `RAZORPAY_WEBHOOK_SECRET` above.

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are automatically available to every Edge Function — nothing to configure for those.

## Why Claude didn't/couldn't do this part

Setting Edge Function secrets and configuring the Razorpay Dashboard both require credentials only you hold (your Razorpay account, and write access to this Supabase project's secrets — no MCP tool exposes secret-setting, by design). Pasting a live payment secret into this chat would also defeat the point of keeping it out of any channel that isn't the two places it belongs (Razorpay Dashboard, Supabase secrets).

## What was tested without real Razorpay credentials

Everything on the database side was exercised directly and thoroughly (see the Phase 4.4 final report) — order attachment, amount-mismatch rejection, successful activation with correct 30-day validity and 8 credits, idempotency under a replayed event and under two different event ids for the same payment, and permission-denied for an ordinary member calling `process_payment_webhook()` directly. All of this ran inside rolled-back transactions; production has zero test rows.

What could **not** be tested without your own Razorpay Test Mode credentials: an actual Checkout session, a real webhook delivery, and Razorpay's own signature over a real payload. Once the three secrets and the webhook are configured, a ₹12,000 and a ₹16,000 test-mode purchase (Razorpay's test card `4111 1111 1111 1111`, any future expiry/CVV) are the two things worth running end-to-end before going live.
