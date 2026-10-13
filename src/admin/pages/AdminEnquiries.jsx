import { useMemo, useState } from "react";
import { RefreshCw, Inbox, Trash2, Mail, Phone, CalendarClock, Tag, User, CheckCircle2, Undo2 } from "lucide-react";
import { useEnquiries } from "../useEnquiries";
import {
  ActionButton,
  DetailDrawer,
  Empty,
  ErrorBox,
  Field,
  InlineError,
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
  const { rows, status, errorMessage, reload, remove, setStatusOf } = useEnquiries();
  const [tab, setTab] = useState("new"); // new | answered | all
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState(null);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const inTab = rows.filter((row) => tab === "all" || (row.status === "answered" ? "answered" : "new") === tab);
    if (!q) return inTab;
    return inTab.filter((row) =>
      [row.name, row.email, row.phone, row.topic].some((field) => field?.toLowerCase().includes(q))
    );
  }, [rows, query, tab]);

  const counts = useMemo(() => {
    const answered = rows.filter((r) => r.status === "answered").length;
    return { new: rows.length - answered, answered, all: rows.length };
  }, [rows]);

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

  const toggleAnswered = async () => {
    if (!selected) return;
    setMarking(true);
    setMarkError(null);
    const { error } = await setStatusOf(selected.id, selected.status === "answered" ? "new" : "answered");
    setMarking(false);
    if (error) setMarkError(error);
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

      <div className="mb-4 flex gap-2" role="tablist" aria-label="Enquiry status">
        {[
          ["new", "New"],
          ["answered", "Answered"],
          ["all", "All"],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`rounded-full border px-4 py-1.5 font-sans text-xs transition-colors ${
              tab === key ? "border-racing-green bg-racing-green text-warm-ivory" : "border-antique-gold/30 bg-white text-charcoal hover:border-antique-gold"
            }`}
          >
            {label} <span className="opacity-70">{loading ? "" : counts[key]}</span>
          </button>
        ))}
      </div>

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
                : tab === "new" && counts.new === 0
                  ? "Everything has been answered."
                  : "Try a different name, email or subject."
            }
          >
            {rows.length === 0 ? "No enquiries yet" : tab === "new" && counts.new === 0 && !query ? "No new enquiries" : "No enquiries match that search"}
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
                    <span className="flex items-center gap-2 truncate font-sans text-sm font-medium text-charcoal">
                      {row.name}
                      {row.status === "answered" ? (
                        <span className="font-sans text-[11px] font-normal text-racing-green">Answered</span>
                      ) : (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-antique-gold" aria-label="New" />
                      )}
                    </span>
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
        onClose={() => {
          setOpenId(null);
          setMarkError(null);
        }}
        title={selected?.name}
        subtitle={selected ? fmtDateTime(selected.created_at) : undefined}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <ActionButton
              variant={selected?.status === "answered" ? "secondary" : "primary"}
              icon={selected?.status === "answered" ? Undo2 : CheckCircle2}
              onClick={toggleAnswered}
              disabled={marking}
            >
              {marking ? "Saving…" : selected?.status === "answered" ? "Mark as new" : "Mark as answered"}
            </ActionButton>
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
            <Field label="Status" value={selected.status === "answered" ? `Answered${selected.handled_at ? " on " + fmtDateTime(selected.handled_at) : ""}` : "New"} />
            {markError && <InlineError message={markError} />}
          </dl>
        )}
      </DetailDrawer>
    </div>
  );
}
