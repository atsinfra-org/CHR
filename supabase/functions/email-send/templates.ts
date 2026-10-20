// Email templates. Pure functions: (context from email_job_context(), link base) -> subject/html/text.
// Everything shown comes from database records; nothing is invented. Values that are not configured
// (address, GSTIN, phone, arrival info) are simply left out. Receipts are always "Payment receipt":
// no tax amounts, invoice numbers or "tax invoice" wording are produced anywhere.

export const BRAND = { green: "#1F3A2E", ivory: "#F6F3EA", gold: "#B08D57", gold2: "#C9A86A", ink: "#1F2A24", muted: "#5B6760" };
const CLUB = "Colonel Horse Riding Club";

type Json = Record<string, any>;
export type Rendered = { subject: string; html: string; text: string };

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function money(amount: unknown, currency = "INR"): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en", { style: "currency", currency }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

/** A timestamp in India time (the club's timezone). */
export function dateTimeIST(iso: unknown): string {
  const d = new Date(String(iso));
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(d) + " IST";
}

/** A calendar date ('YYYY-MM-DD') shown without any timezone shift or locale-dependent punctuation. */
export function dayLabel(ymd: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd ?? ""));
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const timeRange = (s: unknown, e: unknown) => `${s}–${e}`;

type Row = [label: string, value: string];

function safeBase(base: string | null | undefined): string | null {
  if (!base) return null;
  try {
    const u = new URL(base);
    return u.protocol === "https:" ? u.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

function layout(o: { title: string; intro: string; rows?: Row[]; items?: { name: string; qty: number; price: string }[]; total?: Row; notes?: string[]; cta?: { label: string; url: string } | null; business: Json; preheader: string }): Rendered["html"] {
  const rows = (o.rows ?? []).filter(([, v]) => v !== "" && v != null);
  const rowsHtml = rows
    .map(([l, v]) => `<tr><td style="padding:8px 0;color:${BRAND.muted};font-size:14px;width:42%;vertical-align:top">${esc(l)}</td><td style="padding:8px 0;color:${BRAND.ink};font-size:15px;font-weight:600;vertical-align:top">${esc(v)}</td></tr>`)
    .join("");
  const itemsHtml = o.items?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E3DDCB;margin-top:12px">` +
      o.items.map((i) => `<tr><td style="padding:8px 0;color:${BRAND.ink};font-size:14px;border-bottom:1px solid #EEE9D9">${esc(i.name)} <span style="color:${BRAND.muted}">× ${i.qty}</span></td><td align="right" style="padding:8px 0;color:${BRAND.ink};font-size:14px;border-bottom:1px solid #EEE9D9;white-space:nowrap">${esc(i.price)}</td></tr>`).join("") +
      (o.total ? `<tr><td style="padding:10px 0;color:${BRAND.ink};font-size:15px;font-weight:700">${esc(o.total[0])}</td><td align="right" style="padding:10px 0;color:${BRAND.green};font-size:16px;font-weight:700;white-space:nowrap">${esc(o.total[1])}</td></tr>` : "") +
      `</table>`
    : "";
  const notes = (o.notes ?? []).filter(Boolean).map((n) => `<p style="margin:14px 0 0;color:${BRAND.ink};font-size:14px;line-height:1.55">${esc(n)}</p>`).join("");
  const cta = o.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px"><tr><td style="background:${BRAND.green};border-radius:6px"><a href="${esc(o.cta.url)}" style="display:inline-block;padding:12px 22px;color:#FFFFFF;font-size:15px;font-weight:700;text-decoration:none">${esc(o.cta.label)}</a></td></tr></table>`
    : "";
  const b = o.business;
  const foot = [b.name || CLUB, b.address, b.contact_email, b.contact_phone, b.gstin ? `GSTIN ${b.gstin}` : ""].filter(Boolean).map(esc).join(" · ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:${BRAND.ivory}">
<div style="display:none;max-height:0;overflow:hidden;color:${BRAND.ivory}">${esc(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.ivory}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:10px;overflow:hidden;font-family:Georgia,'Times New Roman',serif">
<tr><td style="background:${BRAND.green};padding:20px 28px;border-bottom:3px solid ${BRAND.gold}"><div style="color:${BRAND.gold2};font-size:12px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif">Colonel Horse Riding Club</div></td></tr>
<tr><td style="padding:28px;font-family:Arial,Helvetica,sans-serif">
<h1 style="margin:0 0 10px;color:${BRAND.green};font-size:22px;line-height:1.3;font-family:Georgia,'Times New Roman',serif">${esc(o.title)}</h1>
<p style="margin:0 0 16px;color:${BRAND.ink};font-size:15px;line-height:1.55">${esc(o.intro)}</p>
${rowsHtml ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E3DDCB">${rowsHtml}</table>` : ""}
${itemsHtml}${notes}${cta}
</td></tr>
<tr><td style="padding:16px 28px;background:#FAF8F1;color:${BRAND.muted};font-size:12px;line-height:1.5;font-family:Arial,Helvetica,sans-serif">${foot}<br>This is a transactional message about your account activity. It is not marketing.</td></tr>
</table></td></tr></table></body></html>`;
}

function plain(o: { title: string; intro: string; rows?: Row[]; items?: { name: string; qty: number; price: string }[]; total?: Row; notes?: string[]; cta?: { label: string; url: string } | null; business: Json }): string {
  const lines = [o.title, "", o.intro, ""];
  for (const [l, v] of o.rows ?? []) if (v) lines.push(`${l}: ${v}`);
  if (o.items?.length) {
    lines.push("");
    for (const i of o.items) lines.push(`- ${i.name} x ${i.qty}  ${i.price}`);
    if (o.total) lines.push(`${o.total[0]}: ${o.total[1]}`);
  }
  for (const n of o.notes ?? []) if (n) lines.push("", n);
  if (o.cta) lines.push("", `${o.cta.label}: ${o.cta.url}`);
  const b = o.business;
  lines.push("", "--", [b.name || CLUB, b.address, b.contact_email, b.contact_phone, b.gstin ? `GSTIN ${b.gstin}` : ""].filter(Boolean).join(" | "),
    "This is a transactional message about your account activity. It is not marketing.");
  return lines.join("\n");
}

/**
 * ctx    the object returned by email_job_context() with ok = true.
 * base   optional https URL of the member site (EMAIL_LINK_BASE_URL). Without it there are no buttons.
 */
export function renderEmail(ctx: Json, linkBase?: string | null): Rendered {
  const base = safeBase(linkBase);
  const name = ctx.member_name || "there";
  const hi = `Hi ${name},`;
  const business = ctx.business ?? {};
  const link = (path: string, label: string) => (base ? { label, url: base + path } : null);
  let subject: string;
  let spec: Parameters<typeof layout>[0];

  switch (ctx.template) {
    case "payment_received": {
      const r = ctx.receipt;
      subject = `Payment received — ${CLUB}`;
      spec = {
        title: "Payment received", preheader: `We received ${money(r.amount, r.currency)}.`, business,
        intro: `${hi} thank you. We have received your payment. This is your payment receipt.`,
        rows: [
          ["Receipt number", r.receipt_number], ["Amount paid", money(r.amount, r.currency)], ["Currency", r.currency],
          ["Paid on", dateTimeIST(r.paid_at)], ["Payment reference", r.payment_reference ?? ""], ["Order reference", r.order_reference],
          ["Status", "Paid"],
        ],
        items: (r.items ?? []).map((i: Json) => ({ name: i.name, qty: i.quantity, price: money(Number(i.unit_price) * Number(i.quantity), r.currency) })),
        total: ["Total", money(r.amount, r.currency)],
        notes: ["Payment receipt — not a tax invoice."],
        cta: link("/orders", "View your orders"),
      };
      break;
    }
    case "membership_activated": {
      const m = ctx.membership;
      subject = "Your CHR membership is active";
      spec = {
        title: "Your membership is active", preheader: `${m.name}: ${m.credits} classes.`, business,
        intro: `${hi} your membership is now active and your classes are ready to book.`,
        rows: [
          ["Membership", m.name], ["Classes included", String(m.credits ?? "")], ["Starts", dayLabel(m.start_date)], ["Valid until", dayLabel(m.end_date)],
          ["Reschedules allowed", m.reschedules_allowed == null ? "" : String(m.reschedules_allowed)],
        ],
        notes: ["To book your first class, open your CHR account, choose Book a class, then pick a day and time that suits you."],
        cta: link("/account", "Open your dashboard"),
      };
      break;
    }
    case "booking_confirmed": {
      const b = ctx.booking;
      subject = "Your riding class is confirmed";
      spec = {
        title: "Your class is confirmed", preheader: `${dayLabel(b.date)}, ${timeRange(b.start_time, b.end_time)}.`, business,
        intro: `${hi} your riding class is booked.`,
        rows: [["Date", dayLabel(b.date)], ["Time", timeRange(b.start_time, b.end_time)], ["Booking reference", b.reference], ["Status", label(b.status)]],
        notes: [b.arrival_info],
        cta: link("/account/classes", "View your booking"),
      };
      break;
    }
    case "reschedule_confirmed": {
      const b = ctx.booking;
      subject = "Your riding class has been rescheduled";
      spec = {
        title: "Your class has been rescheduled", preheader: `Now ${dayLabel(b.date)}, ${timeRange(b.start_time, b.end_time)}.`, business,
        intro: `${hi} your class has been moved. No class credit was used.`,
        rows: [
          ["Previous class", `${dayLabel(b.original.date)}, ${timeRange(b.original.start_time, b.original.end_time)}`],
          ["New class", `${dayLabel(b.date)}, ${timeRange(b.start_time, b.end_time)}`],
          ["Booking reference", b.reference], ["Status", label(b.status)],
        ],
        notes: [b.arrival_info],
        cta: link("/account/classes", "View your booking"),
      };
      break;
    }
    case "order_confirmation": {
      const o = ctx.order;
      const paid = o.payment_status === "success";
      subject = "Your CHR order confirmation";
      spec = {
        title: "Your order", preheader: `Order ${o.reference}.`, business,
        intro: paid ? `${hi} thank you for your order. Payment has been received.` : `${hi} we have your order. Payment has not been confirmed yet.`,
        rows: [["Order reference", o.reference], ["Payment status", paymentLabel(o.payment_status)], ["Order status", label(o.status)]],
        items: (o.items ?? []).map((i: Json) => ({ name: i.name, qty: i.quantity, price: money(Number(i.unit_price) * Number(i.quantity), o.currency) })),
        total: ["Total", money(o.total, o.currency)],
        notes: [o.has_in_store ? o.collection_info || "Shop items are collected at the club. We will tell you when your order is ready." : ""],
        cta: link("/orders", "View your order"),
      };
      break;
    }
    case "payment_pending": {
      const p = ctx.payment;
      subject = `Payment verification in progress — ${CLUB}`;
      spec = {
        title: "We are confirming your payment", preheader: "Please do not pay again.", business,
        intro: `${hi} we have not yet had a final answer from the payment provider for your payment. This can take a little while.`,
        rows: [["Amount", money(p.amount, p.currency)], ["Order reference", p.order_reference ?? ""], ["Status", "Verification in progress"]],
        notes: [
          "Please do not pay again. If your payment went through, your order or membership will be confirmed automatically and we will email you. If it did not, nothing is charged.",
          "If your bank shows a charge and you have heard nothing after a day, contact the club with the details above.",
        ],
        cta: link("/orders", "Check your order status"),
      };
      break;
    }
    case "welcome": {
      subject = `Welcome to ${CLUB}`;
      spec = {
        title: "Welcome to the club", preheader: "Your account is ready.", business,
        intro: `Hi ${ctx.welcome?.display_name || "there"}, welcome to ${CLUB}. Your account is ready.`,
        rows: [],
        notes: ["Sign in to choose a membership and book your first class."],
        cta: link("/account", "Open your account"),
      };
      break;
    }
    default:
      throw new Error("UNKNOWN_TEMPLATE");
  }
  return { subject, html: layout(spec), text: plain(spec) };
}

const label = (s: unknown) => String(s ?? "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const paymentLabel = (s: unknown) => (s === "success" ? "Paid" : s === "failed" ? "Failed" : s === "expired" ? "Expired" : "Awaiting confirmation");
