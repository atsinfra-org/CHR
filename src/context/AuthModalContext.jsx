import { createContext, useContext, useMemo, useState } from "react";

const AuthModalContext = createContext(null);

/**
 * Open/close state for the homepage Login / Register modal. The modal
 * itself (src/components/AuthModal) renders the existing Supabase auth
 * flows — this context only lets the navbar and CTAs open it.
 */
export function AuthModalProvider({ children }) {
  const [state, setState] = useState({ open: false, mode: "login" });

  const value = useMemo(
    () => ({
      isOpen: state.open,
      mode: state.mode,
      // Guarded to a string for the same reason as openEnquiry: passing
      // openAuth directly as onClick would hand it the click event.
      openAuth: (mode) => setState({ open: true, mode: mode === "register" ? "register" : mode === "reset" ? "reset" : "login" }),
      closeAuth: () => setState((s) => ({ ...s, open: false })),
    }),
    [state]
  );

  return <AuthModalContext.Provider value={value}>{children}</AuthModalContext.Provider>;
}

export function useAuthModal() {
  const ctx = useContext(AuthModalContext);
  if (!ctx) throw new Error("useAuthModal must be used within an AuthModalProvider");
  return ctx;
}
