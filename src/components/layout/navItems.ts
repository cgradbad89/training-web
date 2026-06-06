import type React from "react";
import {
  LayoutDashboard,
  Footprints,
  Map,
  Dumbbell,
  ClipboardList,
  Trophy,
  CircleDot,
  BarChart2,
  TrendingUp,
  Heart,
  BotMessageSquare,
  Settings,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
};

// ─── Single source of truth for app navigation ────────────────────────────────
// The desktop sidebar renders this full list, in this order. The mobile bottom
// tab bar and its "More" sheet DERIVE their items from this same array (by
// href), so the two navigation surfaces can never drift in label/icon/href.
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard",          label: "This Week",          icon: LayoutDashboard },
  { href: "/plan-insights",      label: "Plan Insights",      icon: BarChart2 },
  { href: "/personal-insights",  label: "Personal Insights",  icon: TrendingUp },
  { href: "/health",             label: "Health",             icon: Heart },
  { href: "/workouts",           label: "Workouts",           icon: Dumbbell },
  { href: "/runs",               label: "Runs",               icon: Footprints },
  { href: "/routes",             label: "Routes",             icon: Map },
  { href: "/plans",              label: "Plans & Goals",      icon: ClipboardList },
  { href: "/races",              label: "Races",              icon: Trophy },
  { href: "/shoes",              label: "Shoes",              icon: CircleDot },
  { href: "/coach",              label: "AI Coach",           icon: BotMessageSquare },
  { href: "/settings",           label: "Settings",           icon: Settings },
];

// ─── Mobile primary tabs (PRODUCT DECISION) ──────────────────────────────────
// iOS tab-bar convention: at most 5 slots, the 5th being "More". These four are
// a product choice and are trivially reorderable / swappable — just edit this
// ordered list of hrefs. Labels + icons are always pulled from NAV_ITEMS above,
// so changing a label/icon there updates both the sidebar and the tab bar.
export const PRIMARY_MOBILE_HREFS: string[] = [
  "/dashboard",      // This Week
  "/runs",           // Runs
  "/plan-insights",  // Plan Insights
  "/coach",          // AI Coach
];

const PRIMARY_SET = new Set(PRIMARY_MOBILE_HREFS);

// Derived: the primary tab items, in PRIMARY_MOBILE_HREFS order.
export const PRIMARY_MOBILE_ITEMS: NavItem[] = PRIMARY_MOBILE_HREFS.map((href) => {
  const item = NAV_ITEMS.find((i) => i.href === href);
  if (!item) {
    throw new Error(`PRIMARY_MOBILE_HREFS references unknown href: ${href}`);
  }
  return item;
});

// Derived: everything NOT primary, in NAV_ITEMS order → the "More" sheet.
export const SECONDARY_MOBILE_ITEMS: NavItem[] = NAV_ITEMS.filter(
  (i) => !PRIMARY_SET.has(i.href)
);
