import { parseNotice, splitMarks } from "../lib/privacyLogic";

/** A line of notice text; any "[not yet provided]" mark is highlighted so a gap is never overlooked. */
function Line({ text }) {
  return (
    <>
      {splitMarks(text).map((p, i) =>
        p.mark ? (
          <mark key={i} className="rounded bg-warning/15 px-1 text-warning">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  );
}

/** Renders the notice's text as headings, lists and paragraphs (data in, elements out — never raw HTML). */
export default function NoticeBody({ body }) {
  const blocks = parseNotice(body);
  return (
    <div className="font-sans text-[15px] leading-relaxed text-charcoal/90">
      {blocks.map((b, i) =>
        b.type === "h2" ? (
          <h2 key={i} className="mt-9 mb-2 font-serif text-xl text-charcoal first:mt-0">
            {b.text}
          </h2>
        ) : b.type === "ul" ? (
          <ul key={i} className="my-3 list-disc space-y-1.5 pl-5 marker:text-antique-gold">
            {b.items.map((it, j) => (
              <li key={j}>
                <Line text={it} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i} className="my-3">
            <Line text={b.text} />
          </p>
        )
      )}
    </div>
  );
}
