import { useState } from "react";
import { Card, SectionHeader, ActionButton, InlineError } from "../ui";
import { formatDate, todayISODate } from "../dashboardUtils";
import { supabase } from "../../lib/supabaseClient";

/**
 * Fields shown are exactly public.profiles' member-facing columns — nothing
 * invented. The inline "complete your profile" form is carried over
 * unchanged in behavior from the original dashboard: profile editing
 * already existed here, so it's restyled rather than rebuilt.
 */
export default function ProfileSummary({ user, profile, onSaved }) {
  return (
    <Card id="profile">
      <SectionHeader title="Profile" />

      <dl className="space-y-3">
        <Row label="Full Name" value={profile.full_name} />
        <Row label="Email" value={profile.email ?? user?.email} />
        <Row label="Phone" value={profile.phone} />
        <Row label="Date of Birth" value={formatDate(profile.date_of_birth)} />
      </dl>

      {(!profile.date_of_birth || !profile.phone) && <CompleteProfile profile={profile} onSaved={onSaved} />}
    </Card>
  );
}

function CompleteProfile({ profile, onSaved }) {
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [dob, setDob] = useState(profile.date_of_birth ?? "");
  const [status, setStatus] = useState("idle"); // idle | saving | error
  const [errorMessage, setErrorMessage] = useState("");

  const handleSave = async (e) => {
    e.preventDefault();
    setStatus("saving");
    const { error } = await supabase
      .from("profiles")
      .update({ phone: phone.trim() || null, date_of_birth: dob || null })
      .eq("id", profile.id);

    if (error) {
      setStatus("error");
      setErrorMessage(error.message);
      return;
    }
    setStatus("idle");
    onSaved();
  };

  return (
    <form onSubmit={handleSave} className="mt-6 space-y-4 rounded-[10px] border border-antique-gold/30 bg-soft-cream/50 p-5">
      <p className="font-sans text-xs tracking-[0.14em] text-racing-green uppercase">Complete Your Profile</p>

      {!profile.phone && (
        <div>
          <label htmlFor="dashboard-phone" className="font-sans text-xs tracking-[0.14em] text-charcoal/70 uppercase">
            Phone
          </label>
          <input
            id="dashboard-phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="mt-2 w-full rounded-[8px] border border-charcoal/15 bg-white px-4 py-3 font-sans text-sm text-charcoal outline-none focus:border-antique-gold"
          />
        </div>
      )}

      {!profile.date_of_birth && (
        <div>
          <label htmlFor="dashboard-dob" className="font-sans text-xs tracking-[0.14em] text-charcoal/70 uppercase">
            Date of Birth
          </label>
          <input
            id="dashboard-dob"
            type="date"
            value={dob}
            onChange={(e) => setDob(e.target.value)}
            max={todayISODate()}
            className="mt-2 w-full rounded-[8px] border border-charcoal/15 bg-white px-4 py-3 font-sans text-sm text-charcoal outline-none focus:border-antique-gold"
          />
        </div>
      )}

      <InlineError message={status === "error" ? errorMessage : null} />

      <ActionButton type="submit" variant="primary" loading={status === "saving"}>
        Save
      </ActionButton>
    </form>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-charcoal/5 pb-3 last:border-0 last:pb-0">
      <dt className="font-sans text-xs tracking-[0.14em] text-warm-grey uppercase">{label}</dt>
      <dd className="font-sans text-sm text-charcoal">{value || "—"}</dd>
    </div>
  );
}
