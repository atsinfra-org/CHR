import { Loader2 } from "lucide-react";

/**
 * "Sign in with Google". Google's own mark in its own colours on a white
 * button with plain dark lettering, as their sign-in branding asks; pass one
 * of their wordings ("Sign in with Google", "Sign up with Google") as the
 * children. Height and corners come from the caller so it sits level with
 * the form it is in.
 */
export default function GoogleButton({ children, busy = false, disabled = false, onClick, className = "" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      className={`flex w-full items-center justify-center gap-3 border border-[#c9c4b6] bg-white font-sans text-[14px] font-medium text-[#1f1f1f] transition-colors duration-200 hover:border-[#8f8a7c] hover:bg-[#fdfcf9] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-antique-gold disabled:cursor-not-allowed disabled:opacity-70 ${className}`}
    >
      {busy ? <Loader2 size={17} className="animate-spin text-[#6b746e]" aria-hidden="true" /> : <GoogleMark />}
      {busy ? "Opening Google…" : children}
    </button>
  );
}

/** The rule with "or" in it that separates Google from the email form. */
export function OrRule({ className = "" }) {
  return (
    <div className={`flex items-center gap-3 ${className}`} role="separator" aria-label="or">
      <span className="h-px flex-1 bg-[#dcd8cc]" />
      <span className="font-sans text-[12px] text-[#6b746e]">or</span>
      <span className="h-px flex-1 bg-[#dcd8cc]" />
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" className="shrink-0" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
