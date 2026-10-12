-- Rollback for 0024. Wallet balances and referral history are deleted.
begin;
drop trigger if exists trg_reward_referrer on public.memberships;
drop trigger if exists trg_wallet_follow_order on public.orders;
drop function if exists public.create_order(jsonb, boolean);
drop function if exists public._reward_referrer();
drop function if exists public._wallet_follow_order();
drop function if exists public.claim_referral(text);
drop function if exists public.my_referral_code();
drop function if exists public.my_wallet_balance();
drop table if exists public.wallet_ledger;
drop table if exists public.referrals;
drop table if exists public.referral_codes;
alter table public.orders drop column if exists wallet_applied;
commit;
-- Then re-run the create_order block from 0019_membership_plan_lock.sql and its grants.
