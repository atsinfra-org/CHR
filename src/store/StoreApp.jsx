import { useEffect, useMemo, useState } from "react";
import { Check, Minus, Plus, ShoppingBag, Store as StoreIcon, Trash2 } from "lucide-react";
import { AUTH_LOADING, AUTHENTICATED, useAuth } from "../context/AuthProvider";
import { useAuthModal } from "../context/AuthModalContext";
import { supabase } from "../lib/supabaseClient";
import AccountStateGuard from "../account/AccountStateGuard";
import RazorpayPaymentFlow from "../account/purchase/RazorpayPaymentFlow";
import { ActionButton, Card, CardSkeleton, EmptyState, ErrorState, InlineError, PageHeader, ToastProvider } from "../account/ui";
import { CartProvider, useCart } from "./CartContext";
import { useCatalog } from "./useCatalog";
import { useOnlinePayments } from "./useOnlinePayments";
import { STORE_CATEGORIES } from "./storeConfig";
import MembershipCard from "./MembershipCard";
import TackCard from "./TackCard";
import { orderNumber } from "../lib/labels";
import { formatDate } from "../account/dashboardUtils";
import { CATEGORY_LABEL, formatINR, friendlyOrderError, resolveCart, toOrderPayload } from "./cartMath";

const pathname = window.location.pathname;
const VIEW = pathname.startsWith("/cart") ? "cart" : pathname.startsWith("/checkout") ? "checkout" : "store";

/**
 * Store → Cart → Checkout. One order may mix memberships, tack and café
 * items; one payment covers all of it. Tack and café are strictly in-store
 * collection — nothing here ever asks for an address.
 *
 * Nothing on this page decides money or entitlements: create_order()
 * re-prices every line server-side, and a membership only activates when the
 * payment is verified server-side (Razorpay webhook / verify function).
 */
export default function StoreApp() {
  return (
    <CartProvider>
      <ToastProvider>
        <StoreGate />
      </ToastProvider>
    </CartProvider>
  );
}

function StoreGate() {
  const { configured, status } = useAuth();
  const { openAuth } = useAuthModal();

  useEffect(() => {
    if (configured && status !== AUTH_LOADING && status !== AUTHENTICATED) openAuth("login");
  }, [configured, status, openAuth]);

  if (!configured) {
    return (
      <Centered title="Database Not Connected">
        Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to <code>.env.local</code>.
      </Centered>
    );
  }
  if (status === AUTH_LOADING) return <Centered>Checking session…</Centered>;
  if (status !== AUTHENTICATED) {
    return (
      <Centered title="Sign in to enter the store">
        <p>Log in or register to buy a membership or tack.</p>
        <div className="mt-6 flex justify-center gap-3">
          <ActionButton variant="primary" onClick={() => openAuth("login")}>
            Login / Register
          </ActionButton>
          <ActionButton href="/" variant="ghost">
            Back to home
          </ActionButton>
        </div>
      </Centered>
    );
  }

  return (
    <AccountStateGuard active="store">
      {({ profile }) => (VIEW === "cart" ? <CartView /> : VIEW === "checkout" ? <CheckoutView profile={profile} /> : <StoreView />)}
    </AccountStateGuard>
  );
}

/* ================================================================ STORE */

const TABS = STORE_CATEGORIES;

function StoreView() {
  const catalog = useCatalog();
  const cart = useCart();
  const [tab, setTab] = useState("membership");
  const resolved = useMemo(() => resolveCart(cart.items, catalog.products), [cart.items, catalog.products]);

  const products = catalog.products.filter((p) => p.category === tab);

  return (
    <Shell title="Store" description="Memberships for riding, plus tack to collect in store." cartCount={resolved.count}>
      <div className="mb-6 flex gap-2 overflow-x-auto" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`shrink-0 rounded-full border px-5 py-2.5 font-sans text-sm transition-all duration-200 ${
              tab === t ? "border-racing-green bg-racing-green text-warm-ivory shadow-[0_10px_24px_-14px_rgba(18,55,42,0.6)]" : "border-antique-gold/30 bg-white text-charcoal hover:-translate-y-px hover:border-antique-gold hover:bg-soft-cream/60"
            }`}
          >
            {CATEGORY_LABEL[t]}
          </button>
        ))}
      </div>

      {tab !== "membership" && (
        <p className="mb-5 rounded-[10px] border border-antique-gold/30 bg-antique-gold/[0.07] px-4 py-3 font-sans text-sm text-charcoal">
          <strong className="font-medium">In-store collection only.</strong> Pay online, then collect from the farm. We don&apos;t deliver.
        </p>
      )}

      {catalog.status === "loading" || catalog.status === "idle" ? (
        <CardSkeleton lines={3} />
      ) : catalog.status === "error" ? (
        <ErrorState title="Couldn't load the store" detail={catalog.error} onRetry={catalog.retry} />
      ) : products.length === 0 ? (
        <EmptyState icon={StoreIcon} title="Nothing here yet" detail="Check back soon." />
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {products.map((p) => {
            const common = {
              product: p,
              inCart: cart.items.find((i) => i.productId === p.id),
              onAdd: () => cart.add(p),
              onSetQty: (q) => cart.setQty(p.id, q),
              onRemove: () => cart.remove(p.id),
            };
            if (tab === "membership") return <MembershipCard key={p.id} {...common} />;
            if (tab === "tack") return <TackCard key={p.id} {...common} />;
            return <ProductCard key={p.id} {...common} />; // café and any future category
          })}
        </div>
      )}

      {resolved.count > 0 && (
        <div className="sticky bottom-20 mt-8 flex items-center justify-between gap-4 rounded-[14px] bg-deep-forest px-5 py-4 text-warm-ivory shadow-lg md:bottom-6">
          <p className="font-sans text-sm">
            {resolved.count} item{resolved.count === 1 ? "" : "s"} · <span className="font-medium">{formatINR(resolved.total)}</span>
          </p>
          <ActionButton href="/cart" variant="secondary">
            View Cart
          </ActionButton>
        </div>
      )}
    </Shell>
  );
}

function ProductCard({ product: p, inCart, onAdd, onSetQty, onRemove }) {
  const isMembership = p.category === "membership";
  const priced = p.price != null;
  const interactive = p.is_purchasable;
  // A plan the customer already holds stays locked until it ends (30 days from billing).
  const heldUntil = p.active_until ?? null;
  const selected = Boolean(inCart) && interactive;

  const activate = () => {
    if (interactive && !selected) onAdd();
  };
  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };

  const tone = !interactive
    ? "cursor-not-allowed border-antique-gold/15 opacity-60"
    : selected
      ? "cursor-pointer border-racing-green shadow-[0_22px_44px_-24px_rgba(18,55,42,0.45)] ring-2 ring-racing-green/15"
      : "cursor-pointer border-antique-gold/20 hover:-translate-y-1 hover:border-antique-gold hover:shadow-[0_24px_48px_-24px_rgba(8,28,21,0.35)] active:translate-y-0";

  return (
    <div
      role="button"
      tabIndex={interactive ? 0 : -1}
      aria-pressed={selected}
      aria-disabled={!interactive}
      aria-label={`${p.name}${priced ? `, ${formatINR(p.price)}` : ""}${selected ? ", in your cart" : interactive ? ", add to cart" : ", unavailable"}`}
      onClick={activate}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          activate();
        }
      }}
      className={`group relative flex flex-col overflow-hidden rounded-[18px] border bg-white p-5 shadow-[0_1px_2px_rgba(27,27,24,0.04),0_12px_32px_-18px_rgba(8,28,21,0.13)] transition-all duration-300 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-antique-gold sm:p-6 ${tone}`}
    >
      {/* accent line: grows on hover, solid when selected */}
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 top-0 h-[3px] origin-left bg-antique-gold transition-transform duration-300 ${
          selected ? "scale-x-100 bg-racing-green" : interactive ? "scale-x-0 group-hover:scale-x-100" : "scale-x-0"
        }`}
      />
      {selected && (
        <span className="absolute top-4 right-4 flex items-center gap-1 rounded-full bg-racing-green px-2.5 py-1 font-sans text-[10px] tracking-[0.14em] text-warm-ivory uppercase">
          <Check size={11} strokeWidth={2.25} /> In cart
        </span>
      )}

      <div className="flex-1">
        <h3 className="pr-20 font-serif text-xl text-charcoal transition-colors duration-300 group-hover:text-racing-green">{p.name}</h3>
        {isMembership ? (
          <ul className="mt-3 space-y-1 font-sans text-sm text-warm-grey">
            <li>
              <span className="text-charcoal">{p.class_credits}</span> riding class{p.class_credits === 1 ? "" : "es"}
            </li>
            <li>Valid {p.validity_days} days</li>
            <li>
              <span className="text-charcoal">{p.reschedules_allowed}</span> reschedule{p.reschedules_allowed === 1 ? "" : "s"} included
            </li>
          </ul>
        ) : (
          <p className="mt-3 inline-block rounded-full bg-soft-cream px-3 py-1 font-sans text-[11px] tracking-[0.1em] text-warm-grey uppercase">
            In-store collection only
          </p>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="font-serif text-2xl text-charcoal">{priced ? formatINR(p.price) : <span className="text-base text-warm-grey">Price coming soon</span>}</p>
        {heldUntil && <p className="basis-full font-sans text-xs leading-relaxed text-warm-grey">You already have this membership. It becomes available again after it ends.</p>}

        {heldUntil ? (
          <span className="rounded-full bg-racing-green/10 px-3 py-1.5 font-sans text-[11px] tracking-[0.1em] text-racing-green uppercase">
            Active until {formatDate(heldUntil)}
          </span>
        ) : !interactive ? (
          <span className="font-sans text-xs tracking-[0.12em] text-warm-grey uppercase">Unavailable</span>
        ) : !selected ? (
          <ActionButton variant="primary" icon={Plus} onClick={stop(onAdd)}>
            Add to cart
          </ActionButton>
        ) : isMembership ? (
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <ActionButton variant="ghost" icon={Trash2} onClick={stop(onRemove)}>
              Remove
            </ActionButton>
            <ActionButton href="/cart" variant="secondary">
              View cart
            </ActionButton>
          </div>
        ) : (
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center rounded-full border border-antique-gold/35">
              <button type="button" aria-label={`Decrease ${p.name}`} onClick={stop(() => onSetQty(inCart.quantity - 1))} className="flex h-10 w-10 items-center justify-center text-charcoal transition-colors hover:text-racing-green">
                <Minus size={14} />
              </button>
              <span className="w-6 text-center font-sans text-sm tabular-nums" aria-live="polite">
                {inCart.quantity}
              </span>
              <button type="button" aria-label={`Increase ${p.name}`} onClick={stop(() => onSetQty(inCart.quantity + 1))} className="flex h-10 w-10 items-center justify-center text-charcoal transition-colors hover:text-racing-green">
                <Plus size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ================================================================= CART */

function CartView() {
  const catalog = useCatalog();
  const cart = useCart();
  const resolved = useMemo(() => resolveCart(cart.items, catalog.products), [cart.items, catalog.products]);

  return (
    <Shell title="Your Cart" description="Review your items before paying." cartCount={resolved.count}>
      {catalog.status === "loading" || catalog.status === "idle" ? (
        <CardSkeleton lines={3} />
      ) : catalog.status === "error" ? (
        <ErrorState title="Couldn't load your cart" detail={catalog.error} onRetry={catalog.retry} />
      ) : cart.items.length === 0 ? (
        <EmptyState
          icon={ShoppingBag}
          title="Your cart is empty"
          detail="Add a membership or tack from the store."
          action={
            <ActionButton href="/store" variant="primary">
              Browse the Store
            </ActionButton>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <ul className="divide-y divide-charcoal/5">
              {resolved.lines.map((l) => (
                <li key={l.productId} className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="font-sans text-sm font-medium text-charcoal">{l.name}</p>
                    <p className="mt-0.5 font-sans text-xs text-warm-grey">
                      {CATEGORY_LABEL[l.category]}
                      {l.fulfillment === "IN_STORE_ONLY" ? " · collect in store" : ""} · {formatINR(l.unitPrice)}
                      {l.quantity > 1 ? ` each` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {l.category !== "membership" && (
                      <div className="flex items-center rounded-full border border-charcoal/15">
                        <button type="button" aria-label={`Decrease ${l.name}`} onClick={() => cart.setQty(l.productId, l.quantity - 1)} className="flex h-9 w-9 items-center justify-center text-charcoal">
                          <Minus size={14} />
                        </button>
                        <span className="w-6 text-center font-sans text-sm tabular-nums" aria-live="polite">
                          {l.quantity}
                        </span>
                        <button type="button" aria-label={`Increase ${l.name}`} onClick={() => cart.setQty(l.productId, l.quantity + 1)} className="flex h-9 w-9 items-center justify-center text-charcoal">
                          <Plus size={14} />
                        </button>
                      </div>
                    )}
                    <p className="w-24 text-right font-sans text-sm tabular-nums text-charcoal">{formatINR(l.lineTotal)}</p>
                    <button type="button" aria-label={`Remove ${l.name}`} onClick={() => cart.remove(l.productId)} className="flex h-9 w-9 items-center justify-center rounded-full text-warm-grey transition-colors hover:bg-destructive/5 hover:text-destructive">
                      <Trash2 size={16} strokeWidth={1.75} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            {resolved.unavailable.length > 0 && (
              <div className="mt-5">
                <InlineError message={`${resolved.unavailable.length} item${resolved.unavailable.length === 1 ? " is" : "s are"} no longer available and won't be charged.`} />
                <ActionButton variant="ghost" className="mt-2" onClick={() => resolved.unavailable.forEach((u) => cart.remove(u.productId))}>
                  Remove unavailable items
                </ActionButton>
              </div>
            )}
          </Card>

          <Summary resolved={resolved}>
            <ActionButton href="/checkout" variant="primary" className="mt-5 w-full" disabled={resolved.lines.length === 0}>
              Proceed to Checkout
            </ActionButton>
          </Summary>
        </div>
      )}
    </Shell>
  );
}

function Summary({ resolved, children }) {
  return (
    <Card className="h-fit">
      <h2 className="font-serif text-lg text-charcoal">Order summary</h2>
      <dl className="mt-4 space-y-2 font-sans text-sm">
        {resolved.lines.map((l) => (
          <div key={l.productId} className="flex justify-between gap-3">
            <dt className="text-warm-grey">
              {l.name}
              {l.quantity > 1 ? ` × ${l.quantity}` : ""}
            </dt>
            <dd className="tabular-nums text-charcoal">{formatINR(l.lineTotal)}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t border-charcoal/10 pt-3 text-base">
          <dt className="font-medium text-charcoal">Total</dt>
          <dd className="font-medium tabular-nums text-charcoal">{formatINR(resolved.total)}</dd>
        </div>
      </dl>
      {resolved.hasInStore && <p className="mt-4 font-sans text-xs leading-relaxed text-warm-grey">Tack items are collected in store — no delivery or address needed.</p>}
      {children}
    </Card>
  );
}

/* ============================================================== CHECKOUT */

function CheckoutView({ profile }) {
  const catalog = useCatalog();
  const cart = useCart();
  const resolved = useMemo(() => resolveCart(cart.items, catalog.products), [cart.items, catalog.products]);
  const online = useOnlinePayments();
  const [order, setOrder] = useState(null); // { orderId, paymentId, total, currency } — online payment in progress
  const [placed, setPlaced] = useState(null); // { orderId, total } — pending order awaiting staff confirmation
  const [state, setState] = useState({ busy: false, error: null });
  const [paid, setPaid] = useState(false);

  const placeOrder = async () => {
    setState({ busy: true, error: null });
    const { data, error } = await supabase.rpc("create_order", { p_items: toOrderPayload(resolved.lines.map((l) => ({ productId: l.productId, quantity: l.quantity }))) });
    if (error) {
      setState({ busy: false, error: friendlyOrderError(error) });
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    const created = { orderId: row.order_id, paymentId: row.payment_id, total: Number(row.total_amount), currency: row.currency };
    setState({ busy: false, error: null });
    if (online.enabled) {
      setOrder(created);
    } else {
      // No gateway: the order stays PENDING until staff confirm payment.
      // Nothing is activated here and no payment is claimed.
      setPlaced(created);
      cart.clear();
    }
  };

  const onPaid = () => {
    setPaid(true);
    cart.clear();
  };

  const hasMembership = resolved.hasMembership;
  const hasInStore = resolved.hasInStore;

  return (
    <Shell title="Checkout" description="One payment for everything in your cart." cartCount={resolved.count}>
      {catalog.status === "loading" || catalog.status === "idle" ? (
        <CardSkeleton lines={3} />
      ) : catalog.status === "error" ? (
        <ErrorState title="Couldn't load checkout" detail={catalog.error} onRetry={catalog.retry} />
      ) : resolved.lines.length === 0 && !order && !placed ? (
        <EmptyState
          icon={ShoppingBag}
          title="Nothing to check out"
          detail="Your cart is empty."
          action={
            <ActionButton href="/store" variant="primary">
              Browse the Store
            </ActionButton>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-5 lg:col-span-2">
            {placed ? (
              <PlacedOrder placed={placed} />
            ) : (
            <Card>
              <h2 className="font-serif text-lg text-charcoal">{online.enabled ? "Pay online" : "Place your order"}</h2>
              {online.enabled ? (
                <p className="mt-2 font-sans text-sm leading-relaxed text-warm-grey">
                  Pay by UPI, card or net banking.
                  {hasMembership && " Your membership activates as soon as our server confirms the payment."}
                  {hasInStore && " Tack items are ready for collection in store — we'll notify you."}
                </p>
              ) : (
                <div className="mt-2 font-sans text-sm leading-relaxed text-warm-grey">
                  <p className="font-medium text-charcoal">Online payment is coming soon.</p>
                  <p className="mt-1">
                    You can still place your order now. It will show as <em>awaiting payment confirmation</em> until the
                    club confirms your payment (cash or other arrangement).
                    {hasMembership && " Your membership activates once payment is confirmed."}
                    {hasInStore && " Tack items are collected in store."}
                  </p>
                </div>
              )}
              <div className="mt-6">
                {!order ? (
                  <>
                    {state.error && (
                      <div className="mb-4">
                        <InlineError message={state.error} />
                      </div>
                    )}
                    <ActionButton variant="primary" loading={state.busy} onClick={placeOrder} disabled={resolved.lines.length === 0 || online.status === "loading"}>
                      {online.enabled ? "Continue to Payment" : "Place Order"} — {formatINR(resolved.total)}
                    </ActionButton>
                  </>
                ) : (
                  <RazorpayPaymentFlow
                    paymentId={order.paymentId}
                    plan={{ name: "Colonel Stud Farm order", amount: order.total, currency: order.currency }}
                    profile={profile}
                    onActivated={onPaid}
                    successTitle="Payment Confirmed"
                    successMessage={
                      hasMembership
                        ? "Thank you — your membership is active. You can now book your first class."
                        : "Thank you — your order is confirmed. We'll let you know when it's ready to collect."
                    }
                    successHref={hasMembership ? "/account" : "/store"}
                    successLabel={hasMembership ? "Go to Dashboard" : "Back to Store"}
                  />
                )}
              </div>
            </Card>
            )}
          </div>
          {!paid && !placed && (
            <Summary resolved={resolved}>
              {!order && (
                <ActionButton href="/cart" variant="ghost" className="mt-3 w-full">
                  Edit cart
                </ActionButton>
              )}
            </Summary>
          )}
        </div>
      )}
    </Shell>
  );
}

function PlacedOrder({ placed }) {
  return (
    <Card>
      <div className="flex items-center gap-2 text-racing-green">
        <Check size={18} strokeWidth={1.75} />
        <span className="font-sans text-xs tracking-[0.14em] uppercase">Order placed</span>
      </div>
      <dl className="mt-4 space-y-2 font-sans text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-warm-grey">Order number</dt>
          <dd className="font-medium text-charcoal">{orderNumber(placed.orderId)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-warm-grey">Total</dt>
          <dd className="tabular-nums text-charcoal">{formatINR(placed.total)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-warm-grey">Status</dt>
          <dd className="text-charcoal">Awaiting payment confirmation</dd>
        </div>
      </dl>
      <p className="mt-4 font-sans text-sm leading-relaxed text-warm-grey">
        Payment is <strong className="font-medium text-charcoal">not yet confirmed</strong>. The club will confirm your payment, and you&apos;ll be
        notified here once your order is paid. Memberships activate only after confirmation.
      </p>
      <ActionButton href="/orders" variant="primary" className="mt-5">
        View My Orders
      </ActionButton>
    </Card>
  );
}

/* =============================================================== LAYOUT */

function Shell({ title, description, cartCount, children }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <PageHeader
        title={title}
        description={description}
        actions={
          <ActionButton href="/cart" variant="secondary" icon={ShoppingBag}>
            Cart{cartCount > 0 ? ` (${cartCount})` : ""}
          </ActionButton>
        }
      />
      {children}
    </div>
  );
}

function Centered({ title, children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-warm-ivory px-6 text-center">
      <div className="max-w-md font-sans text-sm leading-relaxed text-warm-grey">
        {title && <h1 className="mb-3 font-serif text-3xl text-charcoal">{title}</h1>}
        {children}
      </div>
    </div>
  );
}
