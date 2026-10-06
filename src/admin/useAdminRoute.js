import { useEffect, useState } from "react";

// Every admin section is a hash route. `members` also accepts a
// `members/<uuid>` sub-path for the member detail view — readRoute() splits
// that into { route: "members", param: "<uuid>" }.
export const VALID_ROUTES = [
  "overview",
  "members",
  "horses",
  "sessions",
  "bookings",
  "attendance",
  "payments",
  "credits",
  "enquiries",
  "audit",
  "roles",
];
const DEFAULT = "overview";

function readRoute() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [route, param] = raw.split("/");
  return {
    route: VALID_ROUTES.includes(route) ? route : DEFAULT,
    param: param || null,
  };
}

/**
 * Hash routing for the admin surface — no router dependency. Returns the
 * current section plus an optional path parameter (used only by the member
 * detail view: `#members/<uuid>`).
 */
export function useAdminRoute() {
  const [state, setState] = useState(readRoute);

  useEffect(() => {
    const onHashChange = () => setState(readRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return state;
}
