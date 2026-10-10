/**
 * "Add to calendar": builds a small .ics file for one riding class.
 *
 * Class times are stored as an IST calendar date and wall-clock time.
 * Asia/Kolkata is UTC+5:30 all year, so the event is written in UTC ("Z")
 * times, which every calendar app converts to the viewer's own zone.
 */
const IST_OFFSET_MIN = 330;

const pad = (n) => String(n).padStart(2, "0");

function toUtcStamp(isoDate, hhmm) {
  const [y, mo, d] = isoDate.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MIN * 60000);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}00Z`;
}

const escapeText = (s) => String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

export function buildIcs({ uid, date, start, end, title, location, description, stamp = new Date() }) {
  const dtstamp = `${stamp.getUTCFullYear()}${pad(stamp.getUTCMonth() + 1)}${pad(stamp.getUTCDate())}T${pad(stamp.getUTCHours())}${pad(stamp.getUTCMinutes())}${pad(stamp.getUTCSeconds())}Z`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Colonel Horse Riding//Classes//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}@colonelhorseriding`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${toUtcStamp(date, start)}`,
    `DTEND:${toUtcStamp(date, end)}`,
    `SUMMARY:${escapeText(title)}`,
    location ? `LOCATION:${escapeText(location)}` : null,
    description ? `DESCRIPTION:${escapeText(description)}` : null,
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");
}

/** Hands the .ics text to the browser as a download. */
export function downloadIcs(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The calendar entry for one of the rider's bookings. */
export function bookingToIcs(booking) {
  const s = booking.class_sessions;
  return buildIcs({
    uid: booking.id,
    date: s.session_date,
    start: s.start_time,
    end: s.end_time,
    title: "Riding class — Colonel Horse Riding",
    location: "Colonel Horse Riding, Guwahati, Assam",
    description: "Wear long trousers or breeches, boots with a small heel and a riding helmet.",
  });
}
