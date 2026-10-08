/**
 * Which product categories the customer store currently shows, in tab order.
 *
 * Café is switched OFF for now but kept intact for later: its products,
 * prices and the "café" order flow all still exist, and staff can still
 * manage the menu under Admin → Orders → "Tack & café prices". To bring it
 * back: add "cafe" here AND re-list the café products (Admin → Orders, tick
 * "Listed" on each, or run the re-enable statement at the bottom of
 * supabase/proposals/0020_hide_cafe.sql).
 */
export const STORE_CATEGORIES = ["membership", "tack"];
