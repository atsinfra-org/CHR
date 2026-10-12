import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarCheck2, Check, LockKeyhole, Minus, Plus, ShoppingBag, Store as StoreIcon, Trash2 } from "lucide-react";
import { AUTH_LOADING, AUTHENTICATED, useAuth } from "../context/AuthProvider";
import { supabase } from "../lib/supabaseClient";
import AccountStateGuard from "../account/AccountStateGuard";
import RazorpayPaymentFlow from "../account/purchase/RazorpayPaymentFlow";
import AuthModal from "../components/AuthModal/AuthModal";
import StoreEntrance from "./StoreEntrance";
import { ActionButton, Card, CardSkeleton, EmptyState, ErrorState, InlineError, PageHeader, ToastProvider } from "../account/ui";
import { CartProvider, useCart } from "./CartContext";
import { useCatalog } from "./useCatalog";
import { STORE_CATEGORIES } from "./storeConfig";
import MembershipCard from "./MembershipCard";
import TackCard from "./TackCard";
import { photoFor } from "./productPhotos";
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
        {/* The Login / Register popup. It has to be mounted here too: the
            landing page has its own copy, and without this one the entrance
            buttons had nothing to open. */}
        <AuthModal />
      </ToastProvider>
    </CartProvider>
  );
}

function StoreGate() {
  const { configured, status } = useAuth();

  if (!configured) {
    return (
      <Centered title="Database Not Connected">
        Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to <code>.env.local</code>.
      </Centered>
    );
  }
  if (status === AUTH_LOADING) return <Centered>Checking session…</Centered>;
  if (status !== AUTHENTICATED) return <StoreEntrance />;

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
    <Shell title="Store" description="Memberships for riding, plus tack to collect in store." cartCount={resolved.count} cartTotal={resolved.total}>
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
  const byId = useMemo(() => new Map(catalog.products.map((p) => [p.id, p])), [catalog.products]);
  const ready = catalog.status !== "loading" && catalog.status !== "idle" && catalog.status !== "error";
  const empty = ready && cart.items.length === 0;

  return (
    <Shell
      title="Your cart"
      description={empty ? "Nothing here yet." : "Check your items, then pay online."}
      action={
        <ActionButton href="/store" variant="secondary" icon={ArrowLeft}>
          Continue shopping
        </ActionButton>
      }
    >
      {!empty && <Steps current={0} />}

      {!ready && catalog.status !== "error" ? (
        <CardSkeleton lines={3} />
      ) : catalog.status === "error" ? (
        <ErrorState title="Couldn't load your cart" detail={catalog.error} onRetry={catalog.retry} />
      ) : empty ? (
        <div className="rounded-[22px] border border-antique-gold/25 bg-white px-6 py-14 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-soft-cream text-racing-green">
            <ShoppingBag size={22} strokeWidth={1.5} />
          </span>
          <h2 className="mt-5 font-serif text-2xl text-charcoal">Your cart is empty</h2>
          <p className="mx-auto mt-2 max-w-sm font-sans text-sm leading-relaxed text-warm-grey">Choose a membership to start riding, or pick up tack for your next class.</p>
          <ActionButton href="/store" variant="primary" className="mt-6">
            Browse the store
          </ActionButton>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
          <div className="lg:col-span-2">
            <ul className="space-y-4">
              {resolved.lines.map((l) => (
                <CartLine key={l.productId} line={l} product={byId.get(l.productId)} onQty={(q) => cart.setQty(l.productId, q)} onRemove={() => cart.remove(l.productId)} />
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
          </div>

          <Summary resolved={resolved}>
            <a
              href="/checkout"
              aria-disabled={resolved.lines.length === 0}
              className={`group mt-5 flex h-[52px] w-full items-center justify-center gap-2.5 rounded-[12px] bg-racing-green font-sans text-[13px] font-semibold tracking-[0.14em] text-warm-ivory uppercase shadow-[0_14px_30px_-16px_rgba(18,55,42,0.7)] transition-colors duration-200 hover:bg-deep-forest focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-antique-gold ${
                resolved.lines.length === 0 ? "pointer-events-none opacity-50" : ""
              }`}
            >
              Proceed to checkout
              <ArrowRight size={16} strokeWidth={1.75} className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </a>
          </Summary>
        </div>
      )}
    </Shell>
  );
}

/** One thing in the cart: its photograph, what it is, and what can be changed. */
function CartLine({ line: l, product, onQty, onRemove }) {
  const photo = photoFor(product);
  const isMembership = l.category === "membership";
  const detail = isMembership
    ? [
        product?.class_credits != null && `${product.class_credits} class${product.class_credits === 1 ? "" : "es"}`,
        product?.validity_days != null && `valid ${product.validity_days} days`,
        product?.reschedules_allowed != null && `${product.reschedules_allowed} reschedule${product.reschedules_allowed === 1 ? "" : "s"}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : `Collected in store${l.quantity > 1 ? ` · ${formatINR(l.unitPrice)} each` : ""}`;

  return (
    <li className="flex gap-4 rounded-[18px] border border-antique-gold/20 bg-white p-4 shadow-[0_1px_2px_rgba(27,27,24,0.04),0_12px_32px_-18px_rgba(8,28,21,0.13)] sm:gap-5 sm:p-5">
      <div className="h-20 w-20 shrink-0 overflow-hidden rounded-[12px] bg-soft-cream sm:h-[104px] sm:w-[104px]">
        {photo ? (
          <img src={photo.image} alt="" loading="lazy" className="h-full w-full object-cover" style={{ objectPosition: photo.focus }} />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-racing-green/50">
            <ShoppingBag size={22} strokeWidth={1.5} />
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-serif text-[15px] italic text-[#8a6a33]">{isMembership ? "Membership" : "Tack shop"}</p>
            <h3 className="font-serif text-[1.35rem] leading-tight text-charcoal">{l.name}</h3>
            {detail && <p className="mt-1 font-sans text-[13px] leading-relaxed text-warm-grey">{detail}</p>}
          </div>
          <p className="shrink-0 font-serif text-[1.35rem] leading-tight tabular-nums text-charcoal">{formatINR(l.lineTotal)}</p>
        </div>

        <div className="mt-auto flex items-center justify-between gap-3 pt-3">
          {isMembership ? (
            <span className="font-sans text-xs text-warm-grey">One per order</span>
          ) : (
            <div className="flex items-center rounded-full border border-antique-gold/35 bg-white">
              <button type="button" aria-label={`Decrease ${l.name}`} onClick={() => onQty(l.quantity - 1)} className="flex h-9 w-9 items-center justify-center rounded-full text-charcoal transition-colors hover:bg-soft-cream">
                <Minus size={14} />
              </button>
              <span className="w-7 text-center font-sans text-sm tabular-nums" aria-live="polite">
                {l.quantity}
              </span>
              <button type="button" aria-label={`Increase ${l.name}`} onClick={() => onQty(l.quantity + 1)} className="flex h-9 w-9 items-center justify-center rounded-full text-charcoal transition-colors hover:bg-soft-cream">
                <Plus size={14} />
              </button>
            </div>
          )}
          <button
            type="button"
            aria-label={`Remove ${l.name}`}
            onClick={onRemove}
            className="flex h-9 items-center gap-1.5 rounded-full px-3 font-sans text-xs tracking-[0.08em] text-warm-grey uppercase transition-colors hover:bg-destructive/5 hover:text-destructive"
          >
            <Trash2 size={14} strokeWidth={1.75} /> Remove
          </button>
        </div>
      </div>
    </li>
  );
}

/** Where the customer is on the way to paying: Cart, Payment, Confirmation. */
function Steps({ current }) {
  const steps = ["Cart", "Payment", "Confirmation"];
  return (
    <ol className="mb-6 flex items-center gap-2 font-sans text-xs sm:gap-3" aria-label="Steps to complete your order">
      {steps.map((label, i) => (
        <li key={label} className="flex items-center gap-2 sm:gap-3" aria-current={i === current ? "step" : undefined}>
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
              i <= current ? "bg-racing-green text-warm-ivory" : "border border-charcoal/20 text-warm-grey"
            } ${i === current ? "ring-4 ring-racing-green/15" : ""}`}
          >
            {i < current ? <Check size={12} strokeWidth={2.5} /> : i + 1}
          </span>
          <span className={i === current ? "font-medium text-charcoal" : "text-warm-grey"}>{label}</span>
          {i < steps.length - 1 && <span className="h-px w-5 bg-charcoal/15 sm:w-10" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

function Summary({ resolved, children }) {
  const notes = [
    [LockKeyhole, "Secure payment by UPI, card or net banking"],
    resolved.hasMembership && [CalendarCheck2, "Your membership starts as soon as you pay"],
    resolved.hasInStore && [StoreIcon, "Tack is collected at the club, so no address is needed"],
  ].filter(Boolean);

  return (
    <Card className="h-fit lg:sticky lg:top-24">
      <h2 className="font-serif text-xl text-charcoal">Order summary</h2>
      <dl className="mt-4 space-y-2.5 font-sans text-sm">
        {resolved.lines.map((l) => (
          <div key={l.productId} className="flex justify-between gap-3">
            <dt className="text-warm-grey">
              {l.name}
              {l.quantity > 1 ? ` × ${l.quantity}` : ""}
            </dt>
            <dd className="tabular-nums text-charcoal">{formatINR(l.lineTotal)}</dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 border-t border-charcoal/10 pt-3.5">
          <dt className="font-sans text-sm font-medium text-charcoal">Total</dt>
          <dd className="font-serif text-[1.7rem] leading-none tabular-nums text-charcoal">{formatINR(resolved.total)}</dd>
        </div>
      </dl>
      {children}
      <ul className="mt-5 space-y-2.5 border-t border-charcoal/10 pt-4">
        {notes.map(([Icon, text]) => (
          <li key={text} className="flex items-start gap-2.5 font-sans text-xs leading-relaxed text-warm-grey">
            <Icon size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-racing-green" />
            {text}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ============================================================== CHECKOUT */

function CheckoutView({ profile }) {
  const catalog = useCatalog();
  const cart = useCart();
  const resolved = useMemo(() => resolveCart(cart.items, catalog.products), [cart.items, catalog.products]);
  const [order, setOrder] = useState(null); // { orderId, paymentId, total, currency, hasMembership, hasInStore } — created, payment in progress
  const [state, setState] = useState({ busy: false, error: null });
  const [paid, setPaid] = useState(false);

  // One click: create_order() prices the cart server-side, then the payment
  // window opens for that order. Nothing is paid or activated here — only a
  // payment Razorpay confirms to our server does that.
  const startPayment = async () => {
    setState({ busy: true, error: null });
    const { data, error } = await supabase.rpc("create_order", { p_items: toOrderPayload(resolved.lines.map((l) => ({ productId: l.productId, quantity: l.quantity }))) });
    if (error) {
      setState({ busy: false, error: friendlyOrderError(error) });
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    setState({ busy: false, error: null });
    setOrder({
      orderId: row.order_id,
      paymentId: row.payment_id,
      total: Number(row.total_amount),
      currency: row.currency,
      hasMembership: resolved.hasMembership,
      hasInStore: resolved.hasInStore,
    });
  };

  const onPaid = () => {
    setPaid(true);
    cart.clear();
  };

  // Taken from the order once it exists: the cart is emptied after payment,
  // and the confirmation must still describe what was bought.
  const hasMembership = order ? order.hasMembership : resolved.hasMembership;
  const hasInStore = order ? order.hasInStore : resolved.hasInStore;

  return (
    <Shell
      title="Checkout"
      description="One payment for everything in your cart."
      action={
        paid ? null : (
          <ActionButton href="/cart" variant="secondary" icon={ArrowLeft}>
            Back to cart
          </ActionButton>
        )
      }
    >
      {(resolved.lines.length > 0 || order) && <Steps current={paid ? 2 : 1} />}
      {catalog.status === "loading" || catalog.status === "idle" ? (
        <CardSkeleton lines={3} />
      ) : catalog.status === "error" ? (
        <ErrorState title="Couldn't load checkout" detail={catalog.error} onRetry={catalog.retry} />
      ) : resolved.lines.length === 0 && !order ? (
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
            <Card>
              <h2 className="font-serif text-lg text-charcoal">Pay online</h2>
              <p className="mt-2 font-sans text-sm leading-relaxed text-warm-grey">
                Pay by UPI, card or net banking.
                {hasMembership && " Your membership starts as soon as the payment goes through."}
                {hasInStore && " Tack items are collected in store — we'll tell you when they're ready."}
              </p>
              <div className="mt-6">
                {!order ? (
                  <>
                    {state.error && (
                      <div className="mb-4">
                        <InlineError message={state.error} />
                      </div>
                    )}
                    <ActionButton variant="primary" loading={state.busy} onClick={startPayment} disabled={resolved.lines.length === 0}>
                      Pay {formatINR(resolved.total)}
                    </ActionButton>
                  </>
                ) : (
                  <RazorpayPaymentFlow
                    autoStart
                    paymentId={order.paymentId}
                    plan={{ name: `Order ${orderNumber(order.orderId)}`, amount: order.total, currency: order.currency }}
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
              {order && !paid && (
                <p className="mt-4 font-sans text-xs leading-relaxed text-warm-grey">
                  Order {orderNumber(order.orderId)} is saved. If you leave now you can finish paying from{" "}
                  <a href="/orders" className="text-racing-green underline underline-offset-4">
                    My Orders
                  </a>
                  .
                </p>
              )}
            </Card>
          </div>
          {!paid && (
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

/* =============================================================== LAYOUT */

function Shell({ title, description, cartCount = 0, cartTotal, action, children }) {
  // With something in the cart this is the next step, so it is the one solid
  // button at the top of the page, with the count and (on the store) the total.
  const filled = cartCount > 0;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 md:px-10 md:py-12">
      <PageHeader
        title={title}
        description={description}
        actions={
          action !== undefined ? (
            action
          ) : (
            <ActionButton href="/cart" variant={filled ? "primary" : "secondary"} icon={ShoppingBag}>
              {filled ? `View cart (${cartCount})${cartTotal ? ` · ${formatINR(cartTotal)}` : ""}` : "Cart"}
            </ActionButton>
          )
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
