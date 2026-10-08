import { useState } from "react";
import { Bell, RefreshCw } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import { ActionButton, Empty, ErrorBox, Loading, PageHeader } from "../ui";
import { fmtDateTime } from "../adminUtils";

/**
 * Operational events for staff/admin (registrations, purchases, bookings,
 * reschedules, attendance, store orders, payments). Rows are written only
 * by the server-side functions that cause the event — the browser never
 * inserts a notification. Read access is the "Staff/admin read admin
 * notifications" RLS policy.
 */
export default function AdminNotifications() {
  const [busy, setBusy] = useState(false);
  const feed = useAdminQuery(() =>
    supabase
      .from("notifications")
      .select("id, type, title, body, read_at, created_at")
      .eq("audience", "admin")
      .order("created_at", { ascending: false })
      .limit(200)
  );

  const unread = (feed.data ?? []).filter((n) => !n.read_at).length;

  const markAll = async () => {
    setBusy(true);
    await adminApi.markNotificationsRead(null);
    setBusy(false);
    feed.reload();
  };

  return (
    <div>
      <PageHeader
        route="notifications"
        actions={
          <>
            <ActionButton icon={RefreshCw} onClick={feed.reload}>
              Refresh
            </ActionButton>
            <ActionButton variant="primary" disabled={busy || unread === 0} onClick={markAll}>
              Mark all read{unread > 0 ? ` (${unread})` : ""}
            </ActionButton>
          </>
        }
      />

      {feed.status === "error" && <ErrorBox message={feed.error} onRetry={feed.reload} />}
      {feed.status === "loading" && <Loading>Loading notifications…</Loading>}
      {feed.status === "ready" &&
        ((feed.data ?? []).length === 0 ? (
          <Empty icon={Bell} detail="New registrations, purchases, bookings and attendance will show up here.">
            No notifications yet
          </Empty>
        ) : (
          <ul className="divide-y divide-charcoal/[0.06] rounded-[14px] border border-charcoal/10 bg-white">
            {feed.data.map((n) => (
              <li key={n.id} className="flex gap-3 px-5 py-3.5">
                <span className={`mt-2 h-2 w-2 shrink-0 rounded-full ${n.read_at ? "bg-charcoal/15" : "bg-antique-gold"}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="font-sans text-sm text-charcoal">{n.title}</p>
                  {n.body && <p className="mt-0.5 font-sans text-xs leading-relaxed text-warm-grey">{n.body}</p>}
                </div>
                <time className="shrink-0 font-sans text-[11px] text-warm-grey">{fmtDateTime(n.created_at)}</time>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
