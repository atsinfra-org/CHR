import { useState } from "react";
import { supabase } from "../lib/supabaseClient";
import AccountStateGuard from "./AccountStateGuard";
import { useMembershipStatus } from "./useMembershipStatus";
import { formatDate } from "./dashboardUtils";
import { ActionButton, Card, CardSkeleton, InlineError, PageHeader, SectionHeader, useToast } from "./ui";

/**
 * Customer account: profile (name, phone), password, and a membership
 * summary. Profile writes use the existing "Members update own profile" RLS
 * policy (role/status are protected by a database trigger); the password
 * change uses Supabase Auth for the current session.
 */
export default function AccountPage() {
  return (
    <AccountStateGuard active="profile">
      {({ user, profile, refreshProfile }) => <Account user={user} profile={profile} refreshProfile={refreshProfile} />}
    </AccountStateGuard>
  );
}

function Account({ user, profile, refreshProfile }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <PageHeader title="Account" description="Your details, password and membership." />
      <div className="space-y-6">
        <MembershipSummary userId={user.id} />
        <ProfileForm profile={profile} email={profile.email ?? user.email} onSaved={refreshProfile} />
        <PasswordForm />
      </div>
    </div>
  );
}

function MembershipSummary({ userId }) {
  const m = useMembershipStatus(userId);
  return (
    <Card>
      <SectionHeader title="Membership" action={<ActionButton href="/account" variant="ghost">Dashboard</ActionButton>} />
      {m.status === "loading" || m.status === "idle" ? (
        <CardSkeleton lines={2} />
      ) : m.status === "error" ? (
        <InlineError message={m.error} />
      ) : m.kind === "active" ? (
        <dl className="grid grid-cols-2 gap-4 font-sans text-sm sm:grid-cols-4">
          <Fact label="Plan" value={m.plan?.name ?? "—"} />
          <Fact label="Classes left" value={`${m.record.credits_remaining} of ${m.record.total_credits ?? m.plan?.class_credits ?? "—"}`} />
          <Fact label="Valid until" value={formatDate(m.record.end_date) ?? "—"} />
          <Fact label="Reschedules" value={`${m.record.reschedules_used ?? 0} / ${m.record.reschedules_allowed ?? 0} used`} />
        </dl>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-sans text-sm text-warm-grey">
            {m.kind === "lapsed" ? "Your last membership has ended." : "You don't have an active membership."}
          </p>
          <ActionButton href="/store" variant="primary">
            Go to Store
          </ActionButton>
        </div>
      )}
    </Card>
  );
}

function ProfileForm({ profile, email, onSaved }) {
  const { notify } = useToast();
  const [name, setName] = useState(profile.full_name ?? "");
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [state, setState] = useState({ busy: false, error: null });
  const dirty = name.trim() !== (profile.full_name ?? "") || phone.trim() !== (profile.phone ?? "");

  const save = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setState({ busy: false, error: "Please enter your name." });
      return;
    }
    setState({ busy: true, error: null });
    const { error } = await supabase
      .from("profiles")
      .update({ full_name: name.trim(), phone: phone.trim() || null })
      .eq("id", profile.id);
    if (error) {
      setState({ busy: false, error: "Couldn't save your details. Please try again." });
      return;
    }
    setState({ busy: false, error: null });
    notify("Profile updated", "success");
    onSaved();
  };

  return (
    <Card id="profile">
      <SectionHeader title="Profile" />
      <form onSubmit={save} className="space-y-4">
        <Input id="acct-name" label="Full name" value={name} onChange={setName} autoComplete="name" />
        <Input id="acct-email" label="Email" value={email} readOnly hint="Your sign-in email can't be changed here." />
        <Input id="acct-phone" label="Phone" value={phone} onChange={setPhone} type="tel" autoComplete="tel" />
        <InlineError message={state.error} />
        <ActionButton type="submit" variant="primary" loading={state.busy} disabled={!dirty}>
          Save changes
        </ActionButton>
      </form>
    </Card>
  );
}

function PasswordForm() {
  const { notify } = useToast();
  const [pw, setPw] = useState({ next: "", confirm: "" });
  const [state, setState] = useState({ busy: false, error: null });

  const save = async (e) => {
    e.preventDefault();
    if (pw.next.length < 6) return setState({ busy: false, error: "Use at least 6 characters." });
    if (pw.next !== pw.confirm) return setState({ busy: false, error: "The two passwords don't match." });
    setState({ busy: true, error: null });
    const { error } = await supabase.auth.updateUser({ password: pw.next });
    if (error) {
      setState({ busy: false, error: /same/i.test(error.message) ? "Choose a different password from your current one." : error.message });
      return;
    }
    setPw({ next: "", confirm: "" });
    setState({ busy: false, error: null });
    notify("Password changed", "success");
  };

  return (
    <Card>
      <SectionHeader title="Password" hint="Forgot it? Sign out and use “Forgot password?” on the login form." />
      <form onSubmit={save} className="space-y-4">
        <Input id="acct-pw" label="New password" type="password" value={pw.next} onChange={(v) => setPw((p) => ({ ...p, next: v }))} autoComplete="new-password" />
        <Input id="acct-pw2" label="Confirm new password" type="password" value={pw.confirm} onChange={(v) => setPw((p) => ({ ...p, confirm: v }))} autoComplete="new-password" />
        <InlineError message={state.error} />
        <ActionButton type="submit" variant="secondary" loading={state.busy} disabled={!pw.next}>
          Change password
        </ActionButton>
      </form>
    </Card>
  );
}

function Input({ id, label, onChange, hint, ...props }) {
  return (
    <div>
      <label htmlFor={id} className="font-sans text-xs tracking-[0.14em] text-charcoal/70 uppercase">
        {label}
      </label>
      <input
        id={id}
        onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        {...props}
        className="mt-2 w-full rounded-[8px] border border-charcoal/15 bg-white px-4 py-3 font-sans text-sm text-charcoal outline-none focus:border-antique-gold read-only:bg-soft-cream/50 read-only:text-warm-grey"
      />
      {hint && <p className="mt-1 font-sans text-xs text-warm-grey">{hint}</p>}
    </div>
  );
}

function Fact({ label, value }) {
  return (
    <div>
      <dt className="text-[11px] tracking-[0.14em] text-warm-grey uppercase">{label}</dt>
      <dd className="mt-0.5 text-charcoal">{value}</dd>
    </div>
  );
}
