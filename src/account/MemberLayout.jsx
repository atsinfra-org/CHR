import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarCheck, Home, LayoutGrid, LogOut, Menu, User, X } from "lucide-react";
import HorseMark from "../components/ui/HorseMark";
import { useAuth as useAuthAction } from "../context/AuthProvider";

/**
 * The member-facing shell: sidebar + topbar on larger screens, a bottom tab
 * bar on mobile. Deliberately lighter than AdminLayout — no dark floating
 * panel, no photographic background, no notification bell (there is no real
 * source of member notifications to back one, and the brief's own rule is
 * never fabricate a feature). Routes/anchors match what AccountHeader
 * already used: this app has no router, only 3 real /account/* pages plus
 * in-page anchors, and the brief's own override clause says to preserve
 * that rather than invent a /member/* namespace.
 */
const NAV = [
  { key: "dashboard", label: "Dashboard", href: "/account", icon: Home },
  { key: "book", label: "Book a Class", href: "/account/book", icon: CalendarCheck, emphasize: true },
  { key: "classes", label: "My Classes", href: "/account#classes", icon: LayoutGrid },
  { key: "profile", label: "Profile", href: "/account#profile", icon: User },
];

export default function MemberLayout({ user, profile, active = "dashboard", children }) {
  return (
    <div className="min-h-screen bg-warm-ivory md:flex">
      <DesktopSidebar user={user} profile={profile} active={active} />

      <div className="flex min-w-0 flex-1 flex-col">
        <MobileTopbar user={user} profile={profile} />
        <main className="flex-1 pb-24 md:pb-0">{children}</main>
      </div>

      <MobileBottomNav active={active} />
    </div>
  );
}

function DesktopSidebar({ user, profile, active }) {
  const { signOut } = useAuthAction();
  return (
    <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-charcoal/10 bg-white md:flex">
      <a href="/account" className="flex items-center gap-2.5 border-b border-charcoal/10 px-6 py-6">
        <HorseMark className="h-6 w-6 text-antique-gold" />
        <span className="font-serif text-[0.95rem] leading-tight text-charcoal">
          Colonel Horse Riding
          <span className="block font-sans text-[10px] tracking-[0.18em] text-warm-grey uppercase">Member Access</span>
        </span>
      </a>

      <nav className="flex flex-1 flex-col gap-1 px-3 py-5">
        {NAV.map((item) => {
          const isActive = item.key === active;
          const Icon = item.icon;
          return (
            <a
              key={item.key}
              href={item.href}
              className={`flex items-center gap-3 rounded-[10px] px-3.5 py-2.5 font-sans text-sm transition-colors ${
                isActive
                  ? "bg-racing-green/[0.08] font-medium text-racing-green"
                  : item.emphasize
                    ? "text-antique-gold hover:bg-antique-gold/[0.06]"
                    : "text-warm-grey hover:bg-soft-cream/60 hover:text-charcoal"
              }`}
            >
              <Icon size={17} strokeWidth={1.75} />
              {item.label}
            </a>
          );
        })}
      </nav>

      <div className="border-t border-charcoal/10 px-4 py-4">
        <div className="flex items-center gap-2.5 px-1.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-antique-gold/15 font-sans text-xs text-antique-gold">
            {(profile?.full_name || user?.email || "M")[0].toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate font-sans text-sm text-charcoal">{profile?.full_name || "Member"}</p>
            <p className="truncate font-sans text-xs text-warm-grey">{user?.email}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={signOut}
          className="mt-3 flex w-full items-center gap-2.5 rounded-[10px] px-3.5 py-2.5 font-sans text-xs tracking-[0.1em] text-warm-grey uppercase transition-colors hover:bg-destructive/5 hover:text-destructive"
        >
          <LogOut size={14} strokeWidth={1.75} />
          Sign Out
        </button>
      </div>
    </aside>
  );
}

function MobileTopbar({ user, profile }) {
  const { signOut } = useAuthAction();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between border-b border-charcoal/10 bg-white px-5 py-3.5 md:hidden">
      <a href="/account" className="flex items-center gap-2">
        <HorseMark className="h-5 w-5 text-antique-gold" />
        <span className="font-serif text-sm text-charcoal">Colonel Horse Riding</span>
      </a>

      <button aria-label="Open menu" onClick={() => setOpen(true)} className="text-charcoal">
        <Menu size={22} strokeWidth={1.75} />
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-charcoal/40"
              onClick={() => setOpen(false)}
            />
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.28, ease: "easeOut" }}
              className="fixed inset-y-0 right-0 z-50 flex w-72 flex-col bg-white"
            >
              <div className="flex items-center justify-between border-b border-charcoal/10 px-5 py-5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-antique-gold/15 font-sans text-xs text-antique-gold">
                    {(profile?.full_name || user?.email || "M")[0].toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-sans text-sm text-charcoal">{profile?.full_name || "Member"}</p>
                    <p className="truncate font-sans text-xs text-warm-grey">{user?.email}</p>
                  </div>
                </div>
                <button aria-label="Close menu" onClick={() => setOpen(false)}>
                  <X size={20} className="text-warm-grey" />
                </button>
              </div>
              <nav className="flex flex-1 flex-col gap-1 px-3 py-4">
                {NAV.map((item) => (
                  <a
                    key={item.key}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-3 rounded-[10px] px-3.5 py-3 font-sans text-sm text-charcoal"
                  >
                    <item.icon size={17} strokeWidth={1.75} />
                    {item.label}
                  </a>
                ))}
              </nav>
              <div className="border-t border-charcoal/10 px-3 py-4">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    signOut();
                  }}
                  className="flex w-full items-center gap-3 rounded-[10px] px-3.5 py-3 font-sans text-sm text-warm-grey"
                >
                  <LogOut size={16} strokeWidth={1.75} />
                  Sign Out
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </header>
  );
}

// §17 — Home/Bookings/Book/Membership/Profile, "Book" visually emphasized.
// This app's real anchors collapse Membership into the dashboard's own
// #membership section (MembershipCard), so the bottom nav points there
// rather than inventing a fifth standalone route that doesn't exist yet.
const BOTTOM_NAV = [
  { key: "dashboard", label: "Home", href: "/account", icon: Home },
  { key: "classes", label: "Classes", href: "/account#classes", icon: LayoutGrid },
  { key: "book", label: "Book", href: "/account/book", icon: CalendarCheck, emphasize: true },
  { key: "membership", label: "Membership", href: "/account#membership", icon: CalendarCheck },
  { key: "profile", label: "Profile", href: "/account#profile", icon: User },
];

function MobileBottomNav({ active }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch justify-around border-t border-charcoal/10 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm md:hidden">
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

