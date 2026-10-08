import { useCallback, useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { Card, SectionHeader, CardSkeleton, ErrorState, EmptyState, ActionButton } from "../ui";

/** The member's own notifications (RLS: audience = 'user' and user_id = auth.uid()). */
export default function NotificationsCard({ userId }) {
  const [state, setState] = useState({ status: "idle", error: null, items: [] });

  const load = useCallback(async () => {
    if (!userId) return;
    setState((s) => ({ ...s, status: "loading", error: null }));
    const { data, error } = await supabase
      .from("notifications")
      .select("id, type, title, body, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(8);
    if (error) {
      setState({ status: "error", error: error.message, items: [] });
      return;
    }
    setState({ status: "ready", error: null, items: data ?? [] });
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const markAllRead = async () => {
    await supabase.rpc("mark_notifications_read", { p_ids: null });
    load();
  };

  const unread = state.items.filter((n) => !n.read_at).length;

  return (
    <Card id="notifications">
      <SectionHeader
        title="Notifications"
        action={
          unread > 0 ? (
            <ActionButton variant="ghost" onClick={markAllRead}>
              Mark all read
            </ActionButton>
          ) : null
        }
      />
      {state.status === "loading" || state.status === "idle" ? (
        <CardSkeleton lines={2} />
      ) : state.status === "error" ? (
        <ErrorState detail={state.error} onRetry={load} />
      ) : state.items.length === 0 ? (
        <EmptyState icon={Bell} title="Nothing new" detail="Booking, payment and attendance updates show up here." />
      ) : (
        <ul className="space-y-3">
          {state.items.map((n) => (
            <li key={n.id} className="flex gap-2.5">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read_at ? "bg-charcoal/15" : "bg-antique-gold"}`} aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-sans text-sm text-charcoal">{n.title}</p>
                {n.body && <p className="mt-0.5 font-sans text-xs leading-relaxed text-warm-grey">{n.body}</p>}
                <p className="mt-0.5 font-sans text-[11px] text-warm-grey/70">
                  {new Date(n.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
