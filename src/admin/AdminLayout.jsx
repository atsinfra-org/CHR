import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bell,
  ChevronDown,
  ExternalLink,
  LogOut,
  Menu,
  Search,
  X,
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { PAGE_META, navSectionsFor } from "./adminNav";
import { useAdminQuery } from "./useAdminQuery";

// Navigation, page titles and the per-page header metadata all come from
// adminNav.js, so the sidebar label and the page header can never drift
// apart (§64). `adminOnly` items are hidden from staff there — AdminApp
// also redirects them, and the DB enforces the same split independently.
const PAGE_TITLE = Object.fromEntries(Object.entries(PAGE_META).map(([key, meta]) => [key, meta.title]));

export default function AdminLayout({ route, user, profile, role, children }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const isAdmin = role === "admin";

  const sections = useMemo(() => navSectionsFor(isAdmin), [isAdmin]);

  return (
    <div className="min-h-screen bg-soft-cream">
      {/*
        The one page-level brand image — a corner watermark behind the
        topbar's search field, on every page.

        This is its own layer rather than the wrapper's own background:
        the photo's built-in fade only gets close to the page's cream — it
        never matches it exactly, so painting it as a plain background left
        a faint but visible rectangle where the image ended and the flat
        color began. A CSS mask fixes that properly: it fades the layer's
        own opacity to zero well inside its box, so what shows past that
        point is genuinely the page's own background color, not a
        near-match pixel — no seam is possible.

        `position: fixed` (not `background-attachment: fixed`) pins it to
        the viewport corner through scrolling and sidesteps iOS Safari's
        long-standing background-attachment:fixed quirks. `-z-10` keeps it
        behind this div's own children (the sidebar, the sticky header, the
        page content) while staying above the div's own bg-soft-cream —
        exactly the "decorative backdrop" stacking negative z-index is for.
        Hidden below `sm:` because the search bar it sits behind is too.
      */}
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

      {/* Desktop floating sidebar */}
      <div className="fixed inset-y-0 left-0 z-30 hidden w-[300px] p-4 md:block">
        <Sidebar sections={sections} route={route} role={role} onNavigate={() => {}} />
      </div>

      {/* Mobile drawer */}
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
                sections={sections}
                route={route}
                role={role}
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

      {/* Main column */}
      <div className="flex min-h-screen flex-col md:pl-[300px]">
        <Topbar
          title={PAGE_TITLE[route] ?? "Admin"}
          user={user}
          profile={profile}
          role={role}
          sections={sections}
          onOpenMenu={() => setMobileOpen(true)}
        />
        <main className="flex-1 px-4 py-5 sm:px-6 sm:py-7 lg:px-8">
          <div className="mx-auto max-w-[1180px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
function Sidebar({ sections, route, role, onNavigate, closeButton }) {
  return (
    <aside
      className="flex h-full flex-col rounded-[24px] bg-deep-forest bg-cover bg-no-repeat bg-bottom p-4 shadow-[0_24px_60px_-24px_rgba(8,28,21,0.55)]"
      style={{
        // sidebar.webp is a portrait shot that's already near-black at the
        // top but shows a bright horse + grass band lower down. The
        // <aside>'s height (and so where that band lands under the nav
        // list) varies with viewport height and with how many sections are
        // open, so a gradient timed to one scroll position isn't reliable —
        // a uniform dark wash across the whole photo (second background
        // layer, same element) is what keeps every row's text legible
        // regardless of which nav item ends up over the bright part.
        backgroundImage: "linear-gradient(rgba(8,28,21,0.86), rgba(8,28,21,0.86)), url(/assests/sidebar.webp)",
      }}
    >
      <div className="flex items-center justify-between px-2 py-2">
        <div className="flex items-center gap-3">
          {/* Recolored from the supplied ECL.png (pure-black linework on
              transparent) to champagne-gold, matching the accent already
              used for this label and the nav icons — the original black
              would have nearly disappeared against deep-forest. Source
              kept at public/assests/ECL.png for any future recolor. */}
          <img src="/assests/ecl-gold.png" alt="Colonel Horse Riding crest" className="h-10 w-auto shrink-0" />
          <div className="leading-tight">
            <p className="font-serif text-[15px] tracking-[0.04em] text-warm-ivory">Colonel Horse Riding</p>
            <p className="font-sans text-[9.5px] tracking-[0.28em] text-champagne-gold uppercase">
              {role === "admin" ? "Admin Console" : "Staff Console"}
            </p>
          </div>
        </div>
        {closeButton}
      </div>

      <nav className="mt-3 flex-1 space-y-5 overflow-y-auto px-1 pb-2">
        {sections.map((section) => (
          <div key={section.label}>
            <p className="px-3 pb-1.5 font-sans text-[9.5px] tracking-[0.22em] text-warm-ivory/35 uppercase">
              {section.label}
            </p>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const active = route === item.key;
                return (
                  <a
                    key={item.key}
                    href={`#${item.key}`}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 font-sans text-[13.5px] transition-colors duration-200 ${
                      active
                        ? "bg-antique-gold/15 text-warm-ivory"
                        : "text-warm-ivory/55 hover:bg-warm-ivory/5 hover:text-warm-ivory"
                    }`}
                  >
                    <item.icon
                      size={16}
                      strokeWidth={1.75}
                      className={active ? "text-champagne-gold" : "text-warm-ivory/45"}
                    />
                    {item.label}
                  </a>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Decorative brand line only — no data claim, same family as the
          dashboard hero's "Better Horses. Brighter Tomorrows." */}
      <div className="px-4 pb-2 text-center">
        <p className="font-serif text-[13px] italic leading-snug text-warm-ivory/75">
          &ldquo;More than a farm, a way of life.&rdquo;
        </p>
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

/* ------------------------------------------------------------------ */
function Topbar({ title, user, profile, role, sections, onOpenMenu }) {
  return (
    <header className="sticky top-0 z-20 border-b border-antique-gold/15 bg-soft-cream/85 px-4 py-3 backdrop-blur-md sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-[1180px] items-center gap-3">
        <button aria-label="Open menu" onClick={onOpenMenu} className="shrink-0 text-charcoal md:hidden">
          <Menu size={22} strokeWidth={1.75} />
        </button>

        {/* On mobile the search/command palette hides (below), so the page
            still needs a name at a glance without opening the drawer. On
            larger screens each page already carries its own on-page
            PageHeader with a bigger serif title, so the topbar hands that
            space to the search field instead of repeating the title. */}
        <h1 className="truncate font-serif text-lg text-charcoal sm:hidden">{title}</h1>

        <QuickJump sections={sections} className="hidden sm:block sm:max-w-sm sm:flex-1" />

        <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
          <NotificationBell />
          <ProfileMenu user={user} profile={profile} role={role} />
        </div>
      </div>
    </header>
  );
}

/* Real command search — filters admin sections and jumps via the hash
   router; browsable (not just filter-as-you-type) so Ctrl/Cmd+K opens a
   genuine palette of the console's real sections, nothing decorative. */
function QuickJump({ sections, className = "" }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  const inputRef = useRef(null);

  const items = useMemo(() => sections.flatMap((s) => s.items.map((i) => ({ ...i, section: s.label }))), [sections]);
  const matches = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return items.slice(0, 8);
    return items.filter((i) => `${i.label} ${i.section}`.toLowerCase().includes(n)).slice(0, 6);
  }, [q, items]);

  useEffect(() => {
    const onDoc = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, []);

  // Ctrl/Cmd+K focuses the field from anywhere on the page — a real
  // keyboard shortcut to match the hint chip shown inside it, not a chip
  // promising a behavior that doesn't exist.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (key) => {
    window.location.hash = `#${key}`;
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      <div className="flex items-center gap-2 rounded-full border border-antique-gold/30 bg-white px-3.5 py-2.5">
        <Search size={15} strokeWidth={1.75} className="shrink-0 text-warm-grey" />
        <input
          ref={inputRef}
          type="text"
          value={q}
          placeholder="Search anything…"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches[0]) go(matches[0].key);
            if (e.key === "Escape") setOpen(false);
          }}
          className="w-full min-w-0 bg-transparent font-sans text-sm text-charcoal outline-none placeholder:text-warm-grey/60"
        />
        <kbd className="hidden shrink-0 rounded-md border border-charcoal/15 bg-soft-cream/70 px-1.5 py-0.5 font-sans text-[10px] text-warm-grey md:inline-block">
          Ctrl K
        </kbd>
      </div>
      {open && matches.length > 0 && (
        <ul className="absolute left-0 right-0 z-30 mt-2 overflow-hidden rounded-xl border border-antique-gold/20 bg-white py-1 shadow-lg sm:left-auto sm:w-64">
          {matches.map((m) => (
            <li key={m.key}>
              <button
                type="button"
                onClick={() => go(m.key)}
                className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left font-sans text-sm text-charcoal hover:bg-soft-cream/60"
              >
                <m.icon size={14} strokeWidth={1.75} className="text-warm-grey" />
                {m.label}
                <span className="ml-auto font-sans text-[10px] tracking-[0.1em] text-warm-grey/60 uppercase">{m.section}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Admin notification bell, backed by the notifications table (admin
 * audience only — RLS also restricts these rows to staff/admin, so
 * customer-private notifications are never visible here). Shows the unread
 * count, the latest few events, and links to the full Notifications page.
 * Refreshes every minute and whenever the menu is opened.
 */
function NotificationBell() {
  const unreadQ = useAdminQuery(() =>
    supabase.from("notifications").select("id", { count: "exact", head: true }).eq("audience", "admin").is("read_at", null).then((r) => ({ data: r.count ?? 0, error: r.error }))
  );
  const latestQ = useAdminQuery(() =>
    supabase.from("notifications").select("id, title, body, read_at, created_at").eq("audience", "admin").order("created_at", { ascending: false }).limit(5)
  );
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const reloadUnread = unreadQ.reload;
  const reloadLatest = latestQ.reload;

  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    const t = setInterval(() => {
      if (document.visibilityState === "visible") {
        reloadUnread();
        reloadLatest();
      }
    }, 60000);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      clearInterval(t);
    };
  }, [reloadUnread, reloadLatest]);

  const total = unreadQ.status === "ready" ? unreadQ.data : 0;
  const items = latestQ.status === "ready" ? latestQ.data ?? [] : [];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          reloadUnread();
          reloadLatest();
        }}
        aria-label={total > 0 ? `${total} unread notification${total === 1 ? "" : "s"}` : "Notifications"}
        className="relative flex h-9 w-9 items-center justify-center rounded-full border border-antique-gold/30 bg-white text-charcoal transition-colors hover:border-antique-gold"
      >
        <Bell size={16} strokeWidth={1.75} />
        {total > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 font-sans text-[9px] font-semibold text-white">
            {total > 9 ? "9+" : total}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-antique-gold/20 bg-white shadow-lg">
          <p className="border-b border-charcoal/8 px-4 py-3 font-sans text-[10.5px] tracking-[0.14em] text-warm-grey uppercase">
            Notifications
          </p>
          {latestQ.status === "loading" ? (
            <p className="px-4 py-4 font-sans text-xs text-warm-grey">Loading…</p>
          ) : latestQ.status === "error" ? (
            <p className="px-4 py-4 font-sans text-xs text-warm-grey">Couldn&apos;t load right now.</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-4 font-sans text-xs text-warm-grey">Nothing yet.</p>
          ) : (
            <ul className="divide-y divide-charcoal/[0.06]">
              {items.map((n) => (
                <li key={n.id} className="flex gap-2.5 px-4 py-3">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read_at ? "bg-charcoal/15" : "bg-antique-gold"}`} aria-hidden="true" />
                  <span className="min-w-0 font-sans text-sm text-charcoal">
                    {n.title}
                    {n.body && <span className="block truncate text-xs text-warm-grey">{n.body}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <a
            href="#notifications"
            onClick={() => setOpen(false)}
            className="block border-t border-charcoal/8 px-4 py-3 text-center font-sans text-xs tracking-[0.12em] text-racing-green uppercase hover:bg-soft-cream/60"
          >
            View all
          </a>
        </div>
      )}
    </div>
  );
}

function ProfileMenu({ user, profile, role }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, []);

  const name = profile?.full_name || user.email;
  const initial = (profile?.full_name || user.email || "?").trim().charAt(0).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-antique-gold/30 bg-white py-1 pl-1 pr-2.5"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-racing-green font-sans text-xs text-warm-ivory">
          {initial}
        </span>
        <span className="hidden text-left leading-tight sm:block">
          <span className="block max-w-[120px] truncate font-sans text-xs text-charcoal">{name}</span>
          <span className="block font-sans text-[10px] capitalize text-warm-grey">{role}</span>
        </span>
        <ChevronDown size={13} strokeWidth={2} className="text-warm-grey" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-56 overflow-hidden rounded-xl border border-antique-gold/20 bg-white shadow-lg">
          <div className="border-b border-charcoal/8 px-4 py-3">
            <p className="truncate font-sans text-sm text-charcoal">{name}</p>
            {profile?.full_name && <p className="truncate font-sans text-xs text-warm-grey">{user.email}</p>}
            <p className="mt-0.5 font-sans text-[10px] tracking-[0.14em] text-antique-gold uppercase">{role}</p>
          </div>
          <a href="/" className="flex items-center gap-2.5 px-4 py-2.5 font-sans text-sm text-charcoal hover:bg-soft-cream/60">
            <ExternalLink size={14} strokeWidth={1.75} className="text-warm-grey" />
            View public site
          </a>
          <button
            type="button"
            onClick={() => supabase.auth.signOut()}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left font-sans text-sm text-charcoal hover:bg-soft-cream/60"
          >
            <LogOut size={14} strokeWidth={1.75} className="text-warm-grey" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
