"use client";

import React, { useState, useEffect } from "react";
import "leaflet/dist/leaflet.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  MoreHorizontal,
  X,
} from "lucide-react";
import { AuthGuard } from "@/components/layout/AuthGuard";
import { HubBanner } from "@/components/layout/HubBanner";
import { GoogleMapsProvider } from "@/components/GoogleMapsProvider";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
};

// Full nav set — used by the desktop sidebar (all items) and by the
// mobile "More" sheet (everything NOT in PRIMARY_MOBILE_ITEMS).
const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard",          label: "This Week",          icon: LayoutDashboard },
  { href: "/plan-insights",      label: "Plan Insights",      icon: BarChart2 },
  { href: "/personal-insights",  label: "Personal Insights",  icon: TrendingUp },
  { href: "/coach",              label: "AI Coach",           icon: BotMessageSquare },
  { href: "/health",             label: "Health",             icon: Heart },
  { href: "/runs",               label: "Runs",               icon: Footprints },
  { href: "/routes",             label: "Routes",             icon: Map },
  { href: "/workouts",           label: "Workouts",           icon: Dumbbell },
  { href: "/plans",              label: "Plans",              icon: ClipboardList },
  { href: "/races",              label: "Races",              icon: Trophy },
  { href: "/shoes",              label: "Shoes",              icon: CircleDot },
];

// iOS tab-bar convention: max 5 primary items. Everything else goes in "More".
const PRIMARY_MOBILE_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "This Week", icon: LayoutDashboard },
  { href: "/runs",      label: "Runs",      icon: Footprints      },
  { href: "/plans",     label: "Plans",     icon: ClipboardList   },
  { href: "/health",    label: "Health",    icon: Heart           },
];

const PRIMARY_MOBILE_HREFS = new Set(
  PRIMARY_MOBILE_ITEMS.map((i) => i.href)
);

const SECONDARY_MOBILE_ITEMS: NavItem[] = NAV_ITEMS.filter(
  (item) => !PRIMARY_MOBILE_HREFS.has(item.href)
);

function SideNav() {
  const pathname = usePathname();

  return (
    <nav className="w-52 shrink-0 border-r border-border bg-card hidden lg:flex flex-col py-4 gap-1 px-2">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              active
                ? "bg-primary/10 text-primary"
                : "text-textSecondary hover:bg-surface hover:text-textPrimary"
            }`}
          >
            <Icon size={16} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function MoreSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();

  // ESC-to-close + body scroll lock while open. Hook is called
  // unconditionally — early returns come AFTER hooks.
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="lg:hidden fixed inset-0 z-[60] bg-black/50 flex flex-col justify-end"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="More navigation"
    >
      <div
        className="bg-card border-t border-border rounded-t-2xl shadow-xl max-h-[80vh] flex flex-col"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-2 border-b border-border">
          <h2 className="text-sm font-semibold text-textPrimary">More</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 -mr-2 flex items-center justify-center text-textSecondary hover:text-textPrimary rounded-lg"
          >
            <X size={20} />
          </button>
        </div>
        <div className="overflow-y-auto p-2">
          {SECONDARY_MOBILE_ITEMS.map(({ href, label, icon: Icon }) => {
            const active =
              pathname === href || pathname.startsWith(href + "/");
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                className={`flex items-center gap-3 px-3 rounded-xl text-sm font-medium transition-colors min-h-[48px] ${
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-textPrimary hover:bg-surface"
                }`}
              >
                <Icon size={18} />
                {label}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BottomTabBar() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  // If a secondary item is active, light up the "More" tab so the user has
  // a visual anchor on which area of the app they're in.
  const inSecondary = SECONDARY_MOBILE_ITEMS.some(
    ({ href }) => pathname === href || pathname.startsWith(href + "/")
  );

  return (
    <>
      <nav
        className="lg:hidden fixed bottom-0 left-0 right-0 bg-card border-t border-border z-50 flex items-stretch"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        aria-label="Primary"
      >
        {PRIMARY_MOBILE_ITEMS.map(({ href, label, icon: Icon }) => {
          const active =
            pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              aria-label={label}
              className={`flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[56px] py-2 transition-colors ${
                active ? "text-primary" : "text-textSecondary"
              }`}
            >
              <Icon size={22} />
              <span className="text-[10px] font-medium leading-none">
                {label}
              </span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-label="More"
          aria-expanded={moreOpen}
          className={`flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[56px] py-2 transition-colors ${
            moreOpen || inSecondary ? "text-primary" : "text-textSecondary"
          }`}
        >
          <MoreHorizontal size={22} />
          <span className="text-[10px] font-medium leading-none">More</span>
        </button>
      </nav>

      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <GoogleMapsProvider>
        <div className="flex flex-col min-h-screen">
          <HubBanner />
          <div className="flex flex-1 overflow-hidden">
            <SideNav />
            <main
              className="flex-1 overflow-y-auto bg-surface p-6 lg:pb-6"
              style={{
                paddingBottom:
                  "calc(5rem + env(safe-area-inset-bottom))",
              }}
            >
              {children}
            </main>
          </div>
          <BottomTabBar />
        </div>
      </GoogleMapsProvider>
    </AuthGuard>
  );
}
