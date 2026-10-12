import { useEffect, useState } from "react";

const STORAGE_KEY = "csf-cart-v1";

/** Fired on this window whenever CartProvider saves the cart. */
export const CART_CHANGED_EVENT = "csf-cart-changed";

function readCount() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return 0;
    return parsed.reduce((sum, i) => sum + (Number.isInteger(i?.quantity) && i.quantity > 0 ? i.quantity : 0), 0);
  } catch {
    return 0; // storage blocked or corrupt — same as an empty cart
  }
}

/**
 * How many items are in the cart, for the cart button in the member top bar.
 * That bar is shown on every member page, including ones outside the store's
 * CartProvider, so this reads the saved cart directly and listens for
 * changes: CART_CHANGED_EVENT from this tab, `storage` from other tabs.
 */
export function useCartCount() {
  const [count, setCount] = useState(readCount);

  useEffect(() => {
    const sync = () => setCount(readCount());
    window.addEventListener(CART_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CART_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return count;
}
