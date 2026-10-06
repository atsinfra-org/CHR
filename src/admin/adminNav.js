import {
  LayoutDashboard,
  Users,
  PawPrint,
  CalendarRange,
  BookMarked,
  ClipboardCheck,
  CreditCard,
  Coins,
  Inbox,
  ScrollText,
  ShieldCheck,
} from "lucide-react";

/**
 * Single source of truth for the admin console's navigation AND the
 * per-page header metadata (§12 "SECTION LABEL / Page Title / purpose").
 *
 * AdminLayout renders the sidebar from NAV_SECTIONS; every page renders its
 * header from PAGE_META, which is derived from the same structure. Keeping
 * one definition is what stops the sidebar label and the page title from
 * drifting apart.
 *
 * Routes here must stay in sync with VALID_ROUTES in useAdminRoute.js.
 * `adminOnly` items are hidden from staff — AdminApp also redirects them,
 * and the database enforces the same split independently (audit_logs and
 * enquiries are is_admin()-only in RLS regardless of this list).
 *
 * Descriptions state what each page actually does against the real data
 * model — nothing aspirational, nothing the page can't deliver.
 */
export const NAV_SECTIONS = [
  {
    label: "Overview",
    items: [
      {
        key: "overview",
        label: "Dashboard",
        icon: LayoutDashboard,
        description: "Operational snapshot of the farm today.",
      },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        key: "members",
        label: "Members",
        icon: Users,
        description: "Member accounts, memberships and riding history.",
      },
      {
        key: "horses",
        label: "Horses",
        icon: PawPrint,
        description: "The current horse roster, status and availability.",
      },
      {
        key: "sessions",
        label: "Sessions",
        icon: CalendarRange,
        description: "Scheduled riding sessions and their capacity.",
      },
      {
        key: "bookings",
        label: "Bookings",
        icon: BookMarked,
        description: "Booking activity across sessions and members.",
      },
      {
        key: "attendance",
        label: "Attendance",
        icon: ClipboardCheck,
        description: "Mark and review attendance for booked riders.",
      },
    ],
  },
  {
    label: "Finance",
    items: [
      {
        key: "payments",
        label: "Payments",
        icon: CreditCard,
        description: "Payment records from the Razorpay gateway.",
      },
      {
        key: "credits",
        label: "Credits",
        icon: Coins,
        description: "Class-credit ledger and manual adjustments.",
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        key: "enquiries",
        label: "Enquiries",
        icon: Inbox,
        adminOnly: true,
        description: "Enquiries submitted from the public site.",
      },
      {
        key: "audit",
        label: "Audit Log",
        icon: ScrollText,
        adminOnly: true,
        description: "Every privileged action recorded by the system.",
      },
      {
        key: "roles",
        label: "Roles",
        icon: ShieldCheck,
        adminOnly: true,
        description: "Grant and revoke admin and staff access.",
      },
    ],
  },
];

/** route -> { section, title, description, icon, adminOnly } */
export const PAGE_META = Object.fromEntries(
  NAV_SECTIONS.flatMap((section) =>
    section.items.map((item) => [
      item.key,
      {
        section: section.label,
        title: item.label,
        description: item.description,
        icon: item.icon,
        adminOnly: Boolean(item.adminOnly),
      },
    ])
  )
);

/** Sidebar sections with admin-only items removed for staff. */
export function navSectionsFor(isAdmin) {
  return NAV_SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter((i) => !i.adminOnly || isAdmin),
  })).filter((s) => s.items.length > 0);
}
