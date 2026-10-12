import { useEffect, useState } from "react";
import { Check, Copy, Gift, MessageCircle, Wallet } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { inviteLink, inviteMessage, useWallet } from "../lib/referral";
import { formatINR } from "../store/cartMath";
import AccountStateGuard from "./AccountStateGuard";
import { Card, CardSkeleton, PageHeader } from "./ui";

const when = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

/** Wallet: the balance, the invite link, who has joined, and every credit and debit. */
export default function WalletPage() {
  return <AccountStateGuard active="wallet">{() => <Wallet_ />}</AccountStateGuard>;
}

function Wallet_() {
  const wallet = useWallet();
  const [rows, setRows] = useState(null);
  const [joined, setJoined] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!wallet.available) return;
    supabase.from("wallet_ledger").select("id, amount, kind, description, created_at").order("created_at", { ascending: false }).limit(30).then(({ data }) => setRows(data ?? []));
    supabase.from("referrals").select("id, status", { count: "exact" }).then(({ data }) => setJoined(data ?? []));
  }, [wallet.available]);

  if (wallet.status === "loading") return <div className="mx-auto max-w-4xl px-4 py-8 md:px-10 md:py-12"><CardSkeleton lines={4} /></div>;
  if (!wallet.available) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 md:px-10 md:py-12">
        <PageHeader title="Wallet" description="Your wallet isn't switched on yet. Please check back soon." />
      </div>
    );
  }

  const link = inviteLink(wallet.code);
  const rewarded = (joined ?? []).filter((r) => r.status === "rewarded").length;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // link stays visible for selecting
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 md:px-10 md:pt-12 md:pb-4">
      <PageHeader title="Wallet" description="Money you've earned by referring friends. It is taken off your next bill automatically." />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5 lg:items-start">
        <div className="space-y-6 lg:col-span-2">
          <section className="rounded-[22px] border border-[#1d4a37] bg-[linear-gradient(140deg,#0c261c_0%,#16402f_100%)] p-6 text-warm-ivory shadow-[0_24px_48px_-28px_rgba(8,28,21,0.6)]">
            <Wallet size={22} strokeWidth={1.5} className="text-champagne-gold" />
            <p className="mt-3 font-serif text-lg italic text-champagne-gold">Balance</p>
            <p className="font-serif text-[3rem] leading-none">{formatINR(wallet.balance)}</p>
            <p className="mt-3 font-sans text-sm text-warm-ivory/70">
              {joined === null ? "" : `${joined.length} friend${joined.length === 1 ? "" : "s"} joined · ${rewarded} reward${rewarded === 1 ? "" : "s"} earned`}
            </p>
          </section>

          <Card>
            <div className="flex items-center gap-2 text-racing-green">
              <Gift size={18} strokeWidth={1.6} />
              <h2 className="font-serif text-xl">Refer &amp; earn ₹500</h2>
            </div>
            <p className="mt-2 font-sans text-sm leading-relaxed text-warm-grey">When a friend buys their first membership with your link, ₹500 is added to your wallet.</p>
            <div className="mt-3 flex items-center gap-2 rounded-[12px] border border-antique-gold/30 bg-white p-1.5 pl-3.5">
              <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-charcoal">{link}</span>
              <button type="button" onClick={copy} className="flex h-10 shrink-0 items-center gap-1.5 rounded-[9px] bg-racing-green px-3.5 font-sans text-xs font-semibold tracking-[0.1em] text-warm-ivory uppercase hover:bg-deep-forest">
                {copied ? <Check size={14} strokeWidth={2.25} /> : <Copy size={14} strokeWidth={1.75} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <a href={`https://wa.me/?text=${encodeURIComponent(inviteMessage(wallet.code))}`} target="_blank" rel="noreferrer" className="mt-3 flex h-11 items-center justify-center gap-2 rounded-[12px] border border-racing-green/35 font-sans text-xs font-semibold tracking-[0.12em] text-racing-green uppercase hover:border-racing-green hover:bg-white">
              <MessageCircle size={16} strokeWidth={1.75} /> Share on WhatsApp
            </a>
          </Card>
        </div>

        <section className="lg:col-span-3">
          <h2 className="font-serif text-2xl text-charcoal">Activity</h2>
          {rows === null ? (
            <div className="mt-4"><CardSkeleton lines={3} /></div>
          ) : rows.length === 0 ? (
            <p className="mt-4 border-y border-charcoal/10 py-6 font-sans text-sm text-warm-grey">Nothing yet. Share your link to earn your first ₹500.</p>
          ) : (
            <ul className="mt-4 divide-y divide-charcoal/10 border-y border-charcoal/10">
              {rows.map((r) => (
                <li key={r.id} className="flex items-baseline justify-between gap-4 py-3.5">
                  <span className="font-sans text-sm text-charcoal">
                    {r.description}
                    <span className="block text-xs text-warm-grey">{when(r.created_at)}</span>
                  </span>
                  <span className={`shrink-0 font-serif text-xl tabular-nums ${r.amount > 0 ? "text-racing-green" : "text-charcoal"}`}>
                    {r.amount > 0 ? "+" : "−"}
                    {formatINR(Math.abs(r.amount))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
