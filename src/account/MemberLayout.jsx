import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bell,
  CalendarCheck,
  ChevronDown,
  ExternalLink,
  Home,
  LayoutDashboard,
  LogOut,
  Menu,
  Receipt,
  ShoppingBag,
  User,
  X,
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { notificationBody } from "../lib/notificationText";
import { useAuth } from "../context/AuthProvider";

/**
 * The customer area shell — deliberately the same family as the admin
 * console (AdminLayout): floating deep-forest sidebar with the crest and
 * the sidebar photograph, a sticky top bar with the date, a notification
 * bell and a profile menu, and the cream page with the corner watermark. Navigation is real routes (this app has no router: plain
 * links), unlike the admin's hash routes.
 */
const NAV_SECTIONS = [
  {
    label: "Overview",
    items: [{ key: "dashboard", label: "Dashboard", href: "/account", icon: LayoutDashboard }],
  },
  {
    label: "Riding",
    items: [{ key: "book", label: "Book a Class", href: "/account/book", icon: CalendarCheck }],
  },
  {
    label: "Shop",
    items: [
      { key: "store", label: "Store", href: "/store", icon: ShoppingBag },
      { key: "orders", label: "Orders", href: "/orders", icon: Receipt },
    ],
  },
  {
    label: "Account",
    items: [{ key: "profile", label: "Account", href: "/account/profile", icon: User }],
  },
];

const BOTTOM_NAV = [
  { key: "dashboard", label: "Home", href: "/account", icon: Home },
  { key: "store", label: "Store", href: "/store", icon: ShoppingBag },
  { key: "book", label: "Book", href: "/account/book", icon: CalendarCheck, emphasize: true },
  { key: "orders", label: "Orders", href: "/orders", icon: Receipt },
  { key: "profile", label: "Account", href: "/account/profile", icon: User },
];

const TITLES = Object.fromEntries(NAV_SECTIONS.flatMap((s) => s.items.map((i) => [i.key, i.label])));

/** "Saturday 10 October" on the club's calendar (Asia/Kolkata). */
function todayLabel() {
  const p = (opts) => new Date().toLocaleDateString("en-GB", { ...opts, timeZone: "Asia/Kolkata" });
  return `${p({ weekday: "long" })} ${p({ day: "numeric" })} ${p({ month: "long" })}`;
}

export default function MemberLayout({ user, profile, active = "dashboard", children }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-soft-cream">
      {/* Corner watermark, same masked treatment as the admin console. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed right-0 top-0 -z-10 hidden sm:block"
        style={{
          width: "min(640px, 60vw)",
          height: "min(440px, 55vh)",
          backgroundImage: "url(/assests/content.webp)",
          backgroundPosition: "top right",
          backgroundSize: "min(640px, 60vw) auto",
          backgroundRepeat: "no-repeat",
          WebkitMaskImage: "radial-gradient(120% 130% at 100% 0%, #000 28%, transparent 70%)",
          maskImage: "radial-gradient(120% 130% at 100% 0%, #000 28%, transparent 70%)",
        }}
      />

      <div className="fixed inset-y-0 left-0 z-30 hidden w-[300px] p-4 md:block">
        <Sidebar active={active} />
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-deep-forest/60 md:hidden"
              onClick={() => setMobileOpen(false)}
            />
            <motion.div
              initial={{ x: "-105%" }}
              animate={{ x: 0 }}
              exit={{ x: "-105%" }}
              transition={{ duration: 0.28, ease: "easeOut" }}
              className="fixed inset-y-0 left-0 z-50 w-[280px] p-3 md:hidden"
            >
              <Sidebar
                active={active}
                onNavigate={() => setMobileOpen(false)}
                closeButton={
                  <button aria-label="Close menu" onClick={() => setMobileOpen(false)} className="text-warm-ivory/70">
                    <X size={18} />
                  </button>
                }
              />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <div className="flex min-h-screen flex-col md:pl-[300px]">
        <Topbar title={TITLES[active] ?? "Member"} user={user} profile={profile} onOpenMenu={() => setMobileOpen(true)} />
        <main className="flex-1 pb-24 md:pb-0">{children}</main>
      </div>

      <MobileBottomNav active={active} />
    </div>
  );
}

function Sidebar({ active, onNavigate, closeButton }) {
  return (
    <aside
      className="flex h-full flex-col rounded-[24px] bg-deep-forest bg-cover bg-no-repeat bg-bottom p-4 shadow-[0_24px_60px_-24px_rgba(8,28,21,0.55)]"
      style={{
        backgroundImage: "linear-gradient(rgba(8,28,21,0.86), rgba(8,28,21,0.86)), url(/assests/sidebar.webp)",
      }}
    >
      <div className="flex items-center justify-between px-2 py-2">
        <a href="/" className="flex items-center gap-3">
          <img src="/assests/ecl-gold.png" alt="Colonel Horse Riding crest" className="h-10 w-auto shrink-0" />
          <div className="leading-tight">
            <p className="font-serif text-[15px] tracking-[0.04em] text-warm-ivory">Colonel Horse Riding</p>
          </div>
        </a>
        {closeButton}
      </div>

      <nav className="mt-3 flex-1 space-y-5 overflow-y-auto px-1 pb-2" data-lenis-prevent>
        {NAV_SECTIONS.map((section) => (
          <div key={section.label}>
            <p className="px-3 pb-1.5 font-sans text-[9.5px] tracking-[0.22em] text-warm-ivory/35 uppercase">{section.label}</p>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = active === item.key;
                return (
                  <a
                    key={item.key}
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={isActive ? "page" : undefined}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 font-sans text-[13.5px] transition-colors duration-200 ${
                      isActive ? "bg-antique-gold/15 text-warm-ivory" : "text-warm-ivory/55 hover:bg-warm-ivory/5 hover:text-warm-ivory"
                    }`}
                  >
                    <item.icon size={16} strokeWidth={1.75} className={isActive ? "text-champagne-gold" : "text-warm-ivory/45"} />
                    {item.label}
                  </a>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-4 pb-2 text-center">
        <p className="font-serif text-[13px] italic leading-snug text-warm-ivory/75">&ldquo;More than a farm, a way of life.&rdquo;</p>
        <span className="mx-auto mt-2 block h-px w-8 bg-antique-gold/40" aria-hidden="true" />
      </div>

      <a
        href="/"
        className="mt-1 flex items-center gap-3 rounded-xl px-3 py-2.5 font-sans text-[13px] text-warm-ivory/45 transition-colors hover:bg-warm-ivory/5 hover:text-warm-ivory"
      >
        <ExternalLink size={15} strokeWidth={1.75} />
        View public site
      </a>
    </aside>
  );
}

function Topbar({ title, user, profile, onOpenMenu }) {
  return (
    <header className="sticky top-0 z-20 border-b border-antique-gold/15 bg-soft-cream/85 px-4 py-3 backdrop-blur-md sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-[1180px] items-center gap-3">
        <button aria-label="Open menu" onClick={onOpenMenu} className="shrink-0 text-charcoal md:hidden">
          <Menu size={22} strokeWidth={1.75} />
        </button>
        <h1 className="truncate font-serif text-lg text-charcoal sm:hidden">{title}</h1>
        <p className="hidden font-serif text-lg italic text-[#8a6a33] sm:block">{todayLabel()}</p>
        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
          <NotificationBell userId={user?.id} />
          <ProfileMenu user={user} profile={profile} />
        </div>
      </div>
    </header>
  );
}

/** The member's own notifications (RLS: audience 'user', user_id = auth.uid()). */
function NotificationBell({ userId }) {
  const [state, setState] = useState({ status: "loading", items: [] });
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const load = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await supabase
      .from("notifications")
      .select("id, type, title, body, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(8);
    setState(error ? { status: "error", items: [] } : { status: "ready", items: data ?? [] });
  }, [userId]);

  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 60000);
    const onDoc = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("pointerdown", onDoc);
    return () => {
      clearInterval(t);
      document.removeEventListener("pointerdown", onDoc);
    };
  }, [load]);

  const unread = state.items.filter((n) => !n.read_at).length;

  const markAll = async () => {
    await supabase.rpc("mark_notifications_read", { p_ids: null });
    load();
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          load();
        }}
        aria-label={unread > 0 ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications"}
        className="relative flex h-9 w-9 items-center justify-center rounded-full border border-antique-gold/30 bg-white text-charcoal transition-colors hover:border-antique-gold"
      >
        <Bell size={16} strokeWidth={1.75} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 font-sans text-[9px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-antique-gold/20 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-charcoal/8 px-4 py-3">
            <p className="font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">Notifications</p>
            {unread > 0 && (
              <button type="button" onClick={markAll} className="font-sans text-[11px] text-racing-green underline underline-offset-4">
                Mark all read
              </button>
            )}
          </div>
          {state.status === "error" ? (
            <p className="px-4 py-4 font-sans text-xs text-warm-grey">Couldn&apos;t load right now.</p>
          ) : state.items.length === 0 ? (
            <p className="px-4 py-4 font-sans text-xs text-warm-grey">Nothing new.</p>
          ) : (
            <ul className="divide-y divide-charcoal/[0.06]">
              {state.items.map((n) => (
                <li key={n.id} className="flex gap-2.5 px-4 py-3">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read_at ? "bg-charcoal/15" : "bg-antique-gold"}`} aria-hidden="true" />
                  <span className="min-w-0 font-sans text-sm text-charcoal">
                    {n.title}
                    {notificationBody(n) && <span className="block text-xs leading-relaxed text-warm-grey">{notificationBody(n)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ProfileMenu({ user, profile }) {
  const { signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const name = profile?.full_name || "Member";

  useEffect(() => {
    const onDoc = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2.5 rounded-full border border-antique-gold/30 bg-white py-1 pr-2.5 pl-1 transition-colors hover:border-antique-gold"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-racing-green font-sans text-xs text-warm-ivory">
          {(name || user?.email || "M")[0].toUpperCase()}
        </span>
        <span className="hidden text-left leading-tight sm:block">
          <span className="block max-w-[140px] truncate font-sans text-[13px] text-charcoal">{profile?.full_name || user?.email}</span>
          <span className="block font-sans text-[10.5px] text-warm-grey">Member</span>
        </span>
        <ChevronDown size={14} strokeWidth={1.75} className="text-warm-grey" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border border-antique-gold/20 bg-white py-1 shadow-lg">
          <p className="truncate border-b border-charcoal/8 px-4 py-3 font-sans text-xs text-warm-grey">{user?.email}</p>
          <a role="menuitem" href="/account/profile" className="flex items-center gap-2.5 px-4 py-2.5 font-sans text-sm text-charcoal hover:bg-soft-cream/60">
            <User size={14} strokeWidth={1.75} className="text-warm-grey" /> Account
          </a>
          {(profile?.role === "admin" || profile?.role === "staff") && (
            <a role="menuitem" href="/admin" className="flex items-center gap-2.5 px-4 py-2.5 font-sans text-sm text-charcoal hover:bg-soft-cream/60">
              <LayoutDashboard size={14} strokeWidth={1.75} className="text-warm-grey" /> Admin console
            </a>
          )}
          <a role="menuitem" href="/" className="flex items-center gap-2.5 px-4 py-2.5 font-sans text-sm text-charcoal hover:bg-soft-cream/60">
            <ExternalLink size={14} strokeWidth={1.75} className="text-warm-grey" /> Public site
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left font-sans text-sm text-charcoal hover:bg-soft-cream/60"
          >
            <LogOut size={14} strokeWidth={1.75} className="text-warm-grey" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function MobileBottomNav({ active }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-antique-gold/20 bg-soft-cream/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm md:hidden">
      {BOTTOM_NAV.map((item) => {
        const isActive = item.key === active;
        const Icon = item.icon;
        if (item.emphasize) {
          return (
            <a key={item.key} href={item.href} className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-racing-green text-warm-ivory">
                <Icon size={17} strokeWidth={1.75} />
              </span>
              <span className="font-sans text-[10px] font-medium text-racing-green">{item.label}</span>
            </a>
          );
        }
        return (
          <a
            key={item.key}
            href={item.href}
            className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 font-sans text-[10px] whitespace-nowrap ${
              isActive ? "text-racing-green" : "text-warm-grey"
            }`}
          >
            <Icon size={18} strokeWidth={1.75} />
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
