-- ============================================================================
-- Phase 4.4 — Razorpay payment integration (server-side order creation,
-- payment/webhook signature verification, atomic activation).
-- Applied to production via Supabase MCP.
-- ============================================================================
-- Reuses the existing payments.status vocabulary ('created' -> 'success' |
-- 'failed') unchanged — no new status values were needed. Adds exactly two
-- new database objects plus one redefined function:
--
--   1. public.payment_webhook_events — idempotency ledger, one row per
--      Razorpay event id (webhook) or per synced verification call. A
--      unique constraint on event_id makes "process this event twice" a
--      structurally guaranteed no-op, not just an application-level check.
--
--   2. public.attach_gateway_order(payment_id, order_id, amount, currency)
--      — the ONLY way a Razorpay order id can be attached to a payment.
--      SECURITY DEFINER (payments has no member UPDATE policy — by design,
--      see 0003_riding_club_rls.sql), but checks user_id = auth.uid()
--      internally, exactly like initiate_membership_purchase(). Uses a
--      compare-and-swap UPDATE (... WHERE gateway_order_id IS NULL) so a
--      race between two concurrent order-creation requests (double-click,
--      two tabs) can't leave the payment attached to two different orders
--      — whichever request's UPDATE lands first wins, and every other
--      caller gets that same, now-canonical order id back.
--
--   3. public.process_payment_webhook(...) — redefined (new signature: adds
--      p_event_id, p_event_type, p_amount, p_currency) rather than reusing
--      0004's version verbatim, because it now also enforces idempotency
--      via payment_webhook_events AND cross-checks Razorpay's authoritative
--      amount/currency against the stored payment before ever marking it
--      successful (Phase 4.4 §17) — an amount/currency mismatch is flagged
--      (metadata + audit_logs) rather than activating anything. Still the
--      ONLY function that calls activate_membership(), still SECURITY
--      DEFINER, still revoked from anon/authenticated (Phase 4.3's fix is
--      preserved, not undone — only service_role, via the webhook/verify
--      Edge Functions, may call it).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) payment_webhook_events
-- ----------------------------------------------------------------------------
create table public.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  -- Razorpay's `X-Razorpay-Event-Id` header for a real webhook delivery, or
  -- a synthetic 'sync:<razorpay_payment_id>' id for the frontend's own
  -- post-Checkout verification call — both go through the same idempotency
  -- ledger, so whichever path reaches process_payment_webhook() first wins
  -- and the other is a guaranteed no-op, regardless of which arrives first.
  event_id text not null unique,
  event_type text not null,
  gateway_order_id text,
  gateway_payment_id text,
  payment_id uuid references public.payments (id),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.payment_webhook_events is
  'Idempotency ledger for Razorpay webhook deliveries and synced verification calls. Append-only; written only by process_payment_webhook().';

create index ix_payment_webhook_events_payment_id on public.payment_webhook_events (payment_id);

alter table public.payment_webhook_events enable row level security;

-- No member-facing policy at all — this is an internal reconciliation
-- record, not application data. Only staff/admin may inspect it; only the
-- SECURITY DEFINER function below (running as its owner) may write to it.
create policy "Staff/admin read webhook events" on public.payment_webhook_events
  for select to authenticated using (public.is_staff_or_admin());

-- ----------------------------------------------------------------------------
-- 2) attach_gateway_order — the only path that may set payments.gateway_order_id.
-- ----------------------------------------------------------------------------
create or replace function public.attach_gateway_order(
  p_payment_id uuid,
  p_gateway_order_id text,
  p_gateway_order_amount numeric,
  p_gateway_order_currency text
)
returns public.payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_payment public.payments;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_payment from public.payments where id = p_payment_id and user_id = v_user_id;
  if not found then
    raise exception 'PAYMENT_NOT_FOUND';
  end if;
  if v_payment.gateway <> 'razorpay' then
    raise exception 'WRONG_GATEWAY';
  end if;
  if v_payment.status <> 'created' then
    raise exception 'PAYMENT_NOT_PENDING';
  end if;
  -- The order the Edge Function just created at Razorpay must match the
  -- authoritative stored amount/currency — this function never lets a
  -- caller attach an order for a different amount than the payment
  -- actually records (Phase 4.4 §3/§17 applied at attach-time too, not
  -- just at final verification).
  if v_payment.amount <> p_gateway_order_amount or v_payment.currency <> p_gateway_order_currency then
    raise exception 'ORDER_AMOUNT_MISMATCH';
  end if;

  update public.payments
  set gateway_order_id = p_gateway_order_id
  where id = p_payment_id and gateway_order_id is null
  returning * into v_payment;

  if not found then
    -- Lost the race to a concurrent request (double-click / two tabs) —
    -- return the order that DID win, so every caller ends up pointed at
    -- the same canonical order regardless of which one they just created.
    select * into v_payment from public.payments where id = p_payment_id;
  end if;

  return v_payment;
end;
$$;

revoke all on function public.attach_gateway_order(uuid, text, numeric, text) from public, anon;
grant execute on function public.attach_gateway_order(uuid, text, numeric, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 3) process_payment_webhook — redefined. Old signature dropped: it was
-- never actually callable end-to-end before this phase (no order-creation
-- flow existed yet to drive it), so there is no compatibility concern.
-- ----------------------------------------------------------------------------
drop function if exists public.process_payment_webhook(text, text, text, jsonb);

create function public.process_payment_webhook(
  p_event_id text,
  p_event_type text,
  p_gateway_order_id text,
  p_gateway_payment_id text,
  p_status text, -- internal vocabulary only: 'success' | 'failed'
  p_amount numeric default null,
  p_currency text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments;
  v_mismatch_detail text;
begin
  if p_status not in ('success', 'failed') then
    raise exception 'Invalid status %', p_status;
  end if;

  -- Idempotency: a duplicate event_id (retried webhook, or the frontend's
  -- own sync call racing the real webhook) is a guaranteed no-op — return
  -- whatever the payment's current state already is.
  begin
    insert into public.payment_webhook_events (event_id, event_type, gateway_order_id, gateway_payment_id, payload)
    values (p_event_id, p_event_type, p_gateway_order_id, p_gateway_payment_id, p_metadata);
  exception when unique_violation then
    select * into v_payment from public.payments where gateway_order_id = p_gateway_order_id;
    return v_payment;
  end;

  select * into v_payment from public.payments where gateway_order_id = p_gateway_order_id for update;
  if not found then
    raise exception 'UNKNOWN_GATEWAY_ORDER_ID';
  end if;

  -- Already finalized — idempotent no-op regardless of event-id bookkeeping
  -- (belt and braces: covers the case where an event's id genuinely
  -- differs but the payment was already resolved by another path).
  if v_payment.status in ('success', 'failed') then
    return v_payment;
  end if;

  if p_status = 'success' then
    if p_amount is null or p_currency is null then
      raise exception 'Amount/currency required to mark a payment successful';
    end if;

    if v_payment.amount <> p_amount or v_payment.currency <> p_currency then
      -- STOP. Do not activate, do not grant credits — flag for
      -- investigation instead (Phase 4.4 §17). The payment stays in
      -- 'created' so it's still visible as unresolved, not silently lost.
      v_mismatch_detail := format(
        'expected %s %s, got %s %s',
        v_payment.currency, v_payment.amount, p_currency, p_amount
      );

      update public.payments
      set gateway_payment_id = p_gateway_payment_id,
          metadata = metadata || p_metadata || jsonb_build_object('amount_mismatch', v_mismatch_detail)
      where id = v_payment.id
      returning * into v_payment;

      insert into public.audit_logs (table_name, record_id, action, new_values)
      values ('payments', v_payment.id, 'AMOUNT_MISMATCH_FLAGGED', jsonb_build_object('detail', v_mismatch_detail, 'event_id', p_event_id));

      return v_payment;
    end if;
  end if;

  update public.payments
  set gateway_payment_id = p_gateway_payment_id,
      status = p_status,
      paid_at = case when p_status = 'success' then now() else paid_at end,
      metadata = metadata || p_metadata
  where id = v_payment.id
  returning * into v_payment;

  if p_status = 'success' then
    perform public.activate_membership(v_payment.membership_id, v_payment.id);
  end if;

  return v_payment;
end;
$$;

-- Preserving Phase 4.3's fix, not undoing it: only service_role (the
-- webhook/verify Edge Functions) may call this.
revoke all on function public.process_payment_webhook(text, text, text, text, text, numeric, text, jsonb) from public, anon, authenticated;
