/** Minimal line-art equestrian mark used inside image placeholders. */
export default function HorseMark({ className = "" }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M38 92c0-10 2-18 8-24 2-8 1-16-4-22-4-5-5-10-2-15 4 2 8 5 10 9 5-2 11-2 16 1 6-8 15-11 23-9-3 6-8 10-14 12 5 5 8 12 8 20v6c0 8 3 14 9 18" />
      <path d="M70 32c3-6 9-10 16-11-1 6-4 11-9 14" />
      <circle cx="63" cy="30" r="1.4" fill="currentColor" stroke="none" />
      <path d="M40 92h10M76 92h10" />
      <path d="M45 92l-2 10M55 92l1 10M78 92l-2 10M87 92l2 10" />
    </svg>
  );
}
