/**
 * "Remember me" = ask the BROWSER / password manager to save the sign-in, so
 * the user can pick it again after being logged out. It does not extend or
 * persist the app session, and the app never stores the password itself:
 * the value goes straight to the browser's Credential Management API (where
 * supported) and nowhere else. Browsers without it still offer their normal
 * save prompt because the login forms use standard username /
 * current-password fields.
 */
export async function rememberCredential({ email, password, name }) {
  try {
    if (typeof window !== "undefined" && typeof window.PasswordCredential === "function" && navigator.credentials?.store) {
      await navigator.credentials.store(new window.PasswordCredential({ id: email, password, name: name || email }));
    }
  } catch {
    /* the browser declined or doesn't support it — nothing else to do */
  }
}
