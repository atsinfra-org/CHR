import { useMemo, useState } from "react";
import { RefreshCw, Inbox, Trash2, Mail, Phone, CalendarClock, Tag, User } from "lucide-react";
import { useEnquiries } from "../useEnquiries";
import {
  ActionButton,
  DetailDrawer,
  Empty,
  ErrorBox,
  Field,
  Loading,
  PageHeader,
  SearchField,
  StatCard,
  StatGrid,
  Toolbar,
} from "../ui";
import { fmtDateTime, withinLastDays } from "../adminUtils";
import { relativeTime } from "../../account/dashboardUtils";

/**
 * Enquiries inbox (admin-only — "Admin reads enquiries" / "Admin deletes
 * enquiries" RLS). Laid out as a lightweight inbox with a detail drawer
 * rather than a dense table, which suits a lead list better than a
 * seven-column grid (§41/§66).
 *
 * The enquiries table has NO status column, so §41's New / Open / Responded
 * / Closed tabs and the Open / Pending / Resolved KPIs cannot be built from
 * real data — they are omitted rather than invented (§19). Likewise no
 * response-rate metric: nothing records a response.
 *
 * useEnquiries() fetches every row with no limit, so unlike the paged admin
 * screens these counts are genuine totals rather than a loaded window.
 */
export default function AdminEnquiries() {
  const { rows, status, errorMessage, reload, remove } = useEnquiries();
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      [row.name, row.email, row.phone, row.topic].some((field) => field?.toLowerCase().includes(q))
    );
  }, [rows, query]);

  // Derived from the complete dataset, so this is a real figure rather than
  // a statement about a loaded page.
  const lastSevenDays = useMemo(() => rows.filter((r) => withinLastDays(r.created_at, 7)).length, [rows]);

  const selected = openId ? rows.find((r) => r.id === openId) : null;

  const handleDelete = async () => {
    if (!selected) return;
    setDeleting(true);
    const { error } = await remove(selected.id);
    setDeleting(false);
    if (!error) setOpenId(null);
  };

  const loading = status === "loading";

  return (
    <div>
      <PageHeader
        route="enquiries"
        actions={
          <ActionButton icon={RefreshCw} onClick={reload}>
            Refresh
          </ActionButton>
        }
      />

      <StatGrid className="mb-7">
        <StatCard
          icon={Inbox}
          label="Total Enquiries"
          value={loading ? null : rows.length}
          hint="All time"
          loading={loading}
        />
        <StatCard
          icon={CalendarClock}
          label="Last 7 Days"
          value={loading ? null : lastSevenDays}
          hint="Received this week"
          loading={loading}
        />
      </StatGrid>

      <Toolbar>
        <SearchField
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, email, phone or subject…"
          className="w-full sm:w-80"
        />
        <p className="font-sans text-xs text-warm-grey">
          {status === "ready"
            ? `${filtered.length}${filtered.length !== rows.length ? ` of ${rows.length}` : ""} ${
                rows.length === 1 ? "enquiry" : "enquiries"
              }`
            : ""}
        </p>
      </Toolbar>

      {status === "error" && <ErrorBox message={errorMessage} onRetry={reload} />}
      {loading && <Loading>Loading enquiries…</Loading>}

      {status === "ready" &&
        (filtered.length === 0 ? (
          <Empty
            icon={Inbox}
            detail={
              rows.length === 0
                ? "Enquiries submitted from the public site will arrive here."
                : "Try a different name, email or subject."
            }
          >
            {rows.length === 0 ? "No enquiries yet" : "No enquiries match that search"}
          </Empty>
        ) : (
          <ul className="divide-y divide-charcoal/[0.06] overflow-hidden rounded-[20px] border border-antique-gold/20 bg-white shadow-[0_1px_2px_rgba(27,27,24,0.04),0_12px_32px_-18px_rgba(8,28,21,0.13)]">
            {filtered.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(row.id)}
                  className="flex w-full items-start justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-soft-cream/50"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-sans text-sm font-medium text-charcoal">{row.name}</span>
                    <span className="mt-0.5 block truncate font-sans text-xs text-warm-grey">{row.email}</span>
                    {row.topic && (
                      <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-antique-gold/30 px-2.5 py-0.5 font-sans text-[11px] text-racing-green">
                        <Tag size={11} strokeWidth={1.75} />
                        {row.topic}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 whitespace-nowrap font-sans text-xs text-warm-grey">
                    {relativeTime(row.created_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ))}

      <DetailDrawer
        open={Boolean(selected)}
        onClose={() => setOpenId(null)}
        title={selected?.name}
        subtitle={selected ? fmtDateTime(selected.created_at) : undefined}
        footer={
          <div className="flex justify-end">
            <ActionButton variant="danger" icon={Trash2} onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete enquiry"}
            </ActionButton>
          </div>
        }
      >
        {selected && (
          <dl className="space-y-5">
            <Field label="Name" value={selected.name} />
            <Field
              label="Email"
              value={
                <a href={`mailto:${selected.email}`} className="inline-flex items-center gap-2 text-racing-green underline underline-offset-4">
                  <Mail size={14} strokeWidth={1.75} />
                  {selected.email}
                </a>
              }
            />
            <Field
              label="Phone"
              value={
                <a href={`tel:${selected.phone}`} className="inline-flex items-center gap-2 text-racing-green underline underline-offset-4">
                  <Phone size={14} strokeWidth={1.75} />
                  {selected.phone}
                </a>
              }
            />
            <Field label="Age" value={<span className="inline-flex items-center gap-2"><User size={14} strokeWidth={1.75} className="text-warm-grey" />{selected.age}</span>} />
            <Field label="Subject" value={selected.topic || "—"} />
            <Field label="Submitted" value={fmtDateTime(selected.created_at)} />
          </dl>
        )}
      </DetailDrawer>
    </div>
  );
}
