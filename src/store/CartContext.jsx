import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { addItem, removeItem, setQuantity } from "./cartMath";

const STORAGE_KEY = "csf-cart-v1";
const CartContext = createContext(null);

function readStored() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((i) => typeof i?.productId === "string" && Number.isInteger(i?.quantity) && i.quantity > 0)
      : [];
  } catch {
    return []; // storage blocked or corrupt — the cart just starts empty
  }
}

/**
 * Cart state, persisted in localStorage purely as a convenience so it
 * survives the full-page navigations between /store, /cart and /checkout.
 * It holds product ids and quantities only; the server re-prices at
 * create_order().
 */
export function CartProvider({ children }) {
  const [items, setItems] = useState(readStored);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // ignore — see readStored
    }
  }, [items]);

  const add = useCallback((product, qty = 1) => setItems((cur) => addItem(cur, product, qty)), []);
  const remove = useCallback((productId) => setItems((cur) => removeItem(cur, productId)), []);
  const setQty = useCallback((productId, qty) => setItems((cur) => setQuantity(cur, productId, qty)), []);
  const clear = useCallback(() => setItems([]), []);

  const value = useMemo(() => ({ items, add, remove, setQty, clear }), [items, add, remove, setQty, clear]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within a CartProvider");
  return ctx;
}
