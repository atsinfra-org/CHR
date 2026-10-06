import { useMemo, useState } from "react";
import { RefreshCw, BookMarked, XCircle } from "lucide-react";
import { supabase } from "../../lib/supabaseClient";
import { adminApi } from "../adminApi";
import { useAdminQuery } from "../useAdminQuery";
import {
  ActionButton,
  DetailDrawer,
  Empty,
  ErrorBox,
  Field,
  InlineError,
  Loading,
  PageHeader,
  SelectField,
  StatusPill,
  TableShell,
  Toolbar,
} from "../ui";
import { addDays, fmtDate, fmtDateTime, fmtTime, istToday, titleCase } from "../adminUtils";

const STATUS_FILTERS = ["all", "confirmed", "completed", "no_show", "cancelled", "held", "expired"];

/**
 * Bookings register (§37). Read is scoped by "Staff/admin read all
 * bookings". The only mutation is an operator cancellation via
 * admin_cancel_booking() — the operator explicitly decides whether a credit
 * is returned, independent of the member cancellation-cutoff policy, and the
 * action is audited.
 *
 * Every figure on this page describes the SELECTED DATE RANGE (the query is
 * bounded by session date), not all bookings ever — the summary line says so
 * rather than presenting range counts as global totals (§62).
 *
 * Booking detail and cancellation share the universal DetailDrawer. The
 * previous hand-rolled modal closed via a click on a non-interactive
 * backdrop and had no Escape handling, scroll lock or dialog semantics;
 * the shared drawer provides all of those.
 */
export default function AdminBookings() {
  const [from, setFrom] = useState(addDays(istToday(), -7));
  const [to, setTo] = useState(addDays(istToday(), 14));
  const [statusFilter, setStatusFilter] = useState("all");
  const [openId, setOpenId] = useState(null);

  const { data, status, error, reload } = useAdminQuery(
    () =>
      supabase
        .from("bookings")
        .select(
          "id, status, booked_at, cancelled_at, cancellation_reason, " +
            "member:profiles!bookings_user_id_fkey(full_name, email), " +
            "session:class_sessions!inner(session_date, start_time, end_time)"
        )
        .gte("session.session_date", from)
        .lte("session.session_date", to),
    [from, to]
  );

  const all = useMemo(
    () =>
      [...(data ?? [])].sort((a, b) => {
        const da = `${a.session?.session_date ?? ""}T${a.session?.start_time ?? ""}`;
        const db = `${b.session?.session_date ?? ""}T${b.session?.start_time ?? ""}`;
        return da < db ? -1 : da > db ? 1 : 0;
      }),
    [data]
  );

  const rows = useMemo(
    () => (statusFilter === "all" ? all : all.filter((b) => b.status === statusFilter)),
    [all, statusFilter]
  );

  // Counts across the whole selected range, before the status filter.
  const summary = useMemo(() => {
    const by = (s) => all.filter((b) => b.status === s).length;
    return { total: all.length, confirmed: by("confirmed"), cancelled: by("cancelled") };
  }, [all]);

  const selected = openId ? all.find((b) => b.id === openId) : null;
  const rangeValid = from <= to;

  return (
    <div>
      <PageHeader
        route="bookings"
        actions={
          <ActionButton icon={RefreshCw} onClick={reload}>
            Refresh
          </ActionButton>
        }
      />

      <Toolbar>
        <div className="flex flex-wrap items-end gap-3">
          <DateInput label="From" value={from} onChange={setFrom} />
          <DateInput label="To" value={to} onChange={setTo} />
          <SelectField
            label="Status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="w-full sm:w-44"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "All statuses" : titleCase(s)}
              </option>
            ))}
          </SelectField>
        </div>
      </Toolbar>

      {!rangeValid && (
        <div className="mb-4 max-w-md">
          <InlineError message="The start date is after the end date." />
        </div>
      )}

      {status === "ready" && summary.total > 0 && (
        <p className="mb-4 font-sans text-xs text-warm-grey">
          <span className="font-medium text-charcoal">{summary.total}</span>{" "}
          {summary.total === 1 ? "booking" : "bookings"} between {fmtDate(from)} and {fmtDate(to)}
          {" · "}
          {summary.confirmed} confirmed · {summary.cancelled} cancelled
          {statusFilter !== "all" && ` · ${rows.length} shown`}
        </p>
      )}

      {status === "error" && <ErrorBox message={error} onRetry={reload} />}
      {status === "loading" && <Loading>Loading bookings…</Loading>}
      {status === "ready" &&
        (rows.length === 0 ? (
          <Empty
            icon={BookMarked}
            detail={
              all.length === 0
                ? "There are no bookings in the selected date range."
                : "No bookings match the selected status."
            }
          >
            {all.length === 0 ? "No bookings for this period" : `No ${titleCase(statusFilter)} bookings`}
          </Empty>
        ) : (
          <TableShell head={["Session", "Member", "Status", "Booked", ""]} minWidth="760px">
            {rows.map((b) => (
              <tr key={b.id} className="border-b border-charcoal/[0.06] align-top last:border-0 hover:bg-soft-cream/40">
                <td className="px-4 py-3.5">
                  <span className="block whitespace-nowrap font-sans text-sm font-medium text-charcoal">
                    {fmtDate(b.session?.session_date)}
                  </span>
                  <span className="mt-0.5 block whitespace-nowrap font-sans text-xs text-warm-grey">
                    {b.session ? `${fmtTime(b.session.start_time)} – ${fmtTime(b.session.end_time)}` : "—"}
                  </span>
                </td>
                <td className="px-4 py-3.5">
                  <span className="block font-sans text-sm text-charcoal">
                    {b.member?.full_name || b.member?.email || "—"}
                  </span>
                  {b.member?.full_name && b.member?.email && (
                    <span className="mt-0.5 block font-sans text-xs text-warm-grey">{b.member.email}</span>
                  )}
                </td>
                <td className="px-4 py-3.5">
                  <StatusPill value={b.status} />
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 font-sans text-xs text-warm-grey">
                  {fmtDateTime(b.booked_at)}
                </td>
                <td className="px-4 py-3.5 text-right">
                  <ActionButton variant="ghost" className="px-0 py-0 underline underline-offset-4" onClick={() => setOpenId(b.id)}>
                    View
                  </ActionButton>
                </td>
              </tr>
            ))}
          </TableShell>
        ))}

      <BookingDrawer
        booking={selected}
        onClose={() => setOpenId(null)}
        onCancelled={() => {
          setOpenId(null);
          reload();
        }}
      />
    </div>
  );
}

function DateInput({ label, value, onChange }) {
  return (
    <label className="block">
      <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        className="mt-1.5 block rounded-[12px] border border-antique-gold/25 bg-white px-3 py-2.5 font-sans text-sm text-charcoal outline-none transition-colors focus:border-antique-gold"
      />
    </label>
  );
}

function BookingDrawer({ booking, onClose, onCancelled }) {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [refund, setRefund] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const cancellable = booking && (booking.status === "confirmed" || booking.status === "held");

  const close = () => {
    setCancelling(false);
    setReason("");
    setRefund(true);
    setError(null);
    onClose();
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!reason.trim()) {
      setError("A reason is required.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: e2 } = await adminApi.cancelBooking(booking.id, reason.trim(), refund);
    setBusy(false);
    if (e2) {
      setError(e2);
      return;
    }
    setCancelling(false);
    setReason("");
    setRefund(true);
    onCancelled();
  };

  return (
    <DetailDrawer
      open={Boolean(booking)}
      onClose={close}
      title={booking?.member?.full_name || booking?.member?.email || "Booking"}
      subtitle={booking ? `${fmtDate(booking.session?.session_date)} · ${fmtTime(booking.session?.start_time)}` : undefined}
      footer={
        cancellable && !cancelling ? (
          <div className="flex justify-end">
            <ActionButton variant="danger" icon={XCircle} onClick={() => setCancelling(true)}>
              Cancel booking
            </ActionButton>
          </div>
        ) : null
      }
    >
      {booking && (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5">
            <Field label="Status" value={<StatusPill value={booking.status} />} />
            <Field label="Session date" value={fmtDate(booking.session?.session_date)} />
            <Field
              label="Time"
              value={booking.session ? `${fmtTime(booking.session.start_time)} – ${fmtTime(booking.session.end_time)}` : "—"}
            />
            <Field label="Booked" value={fmtDateTime(booking.booked_at)} />
            <Field label="Member" value={booking.member?.full_name || "—"} className="col-span-2" />
            <Field label="Email" value={booking.member?.email || "—"} className="col-span-2" />
            {booking.cancelled_at && <Field label="Cancelled" value={fmtDateTime(booking.cancelled_at)} className="col-span-2" />}
            {booking.cancellation_reason && (
              <Field label="Cancellation reason" value={booking.cancellation_reason} className="col-span-2" />
            )}
          </dl>

          {cancelling && (
            <form onSubmit={submit} className="mt-7 rounded-[18px] border border-destructive/25 bg-destructive/[0.03] p-5">
              <p className="font-sans text-sm text-charcoal">Cancel this booking</p>
              <p className="mt-1 font-sans text-xs leading-relaxed text-warm-grey">
                Recorded in the audit log. The refund choice below overrides the member cancellation cutoff.
              </p>

              <label className="mt-4 block">
                <span className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">Reason</span>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="mt-1.5 block w-full rounded-[12px] border border-antique-gold/25 bg-white px-3 py-2.5 font-sans text-sm text-charcoal outline-none transition-colors focus:border-antique-gold"
                />
              </label>

              <label className="mt-3 flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={refund}
                  onChange={(e) => setRefund(e.target.checked)}
                  className="h-4 w-4 accent-racing-green"
                />
                <span className="font-sans text-sm text-charcoal">Return 1 credit to the member</span>
              </label>

              {error && (
                <div className="mt-4">
                  <InlineError message={error} />
                </div>
              )}

              <div className="mt-5 flex flex-wrap justify-end gap-2.5">
                <ActionButton variant="ghost" onClick={() => setCancelling(false)}>
                  Keep booking
                </ActionButton>
                <ActionButton type="submit" variant="danger" disabled={busy}>
                  {busy ? "Cancelling…" : "Confirm cancellation"}
                </ActionButton>
              </div>
            </form>
          )}
        </>
      )}
    </DetailDrawer>
  );
}
