import { createContext, useContext, useMemo } from "react";

const AuthModalContext = createContext(null);

/**
 * The website's Login / Register buttons. There is no popup any more: every
 * sign-in is the same full-page screen (components/auth/AuthScreen), so these
 * buttons simply go there. /account shows it to anyone signed out and sends a
 * signed-in rider straight to their dashboard.
 */
export function AuthModalProvider({ children }) {
  const value = useMemo(
    () => ({
      // Guarded to a string for the same reason as openEnquiry: passing
      // openAuth directly as onClick would hand it the click event.
      openAuth: (mode) => window.location.assign(mode === "register" ? "/account?mode=register" : "/account"),
    }),
    []
  );

  return <AuthModalContext.Provider value={value}>{children}</AuthModalContext.Provider>;
}

export function useAuthModal() {
  const ctx = useContext(AuthModalContext);
  if (!ctx) throw new Error("useAuthModal must be used within an AuthModalProvider");
  return ctx;
}
