"use client";

import React from "react";
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
} from "lucide-react";
import { AuthGuard } from "@/components/layout/AuthGuard";
import { HubBanner } from "@/components/layout/HubBanner";

const NAV_ITEMS = [
  { href: "/dashboard",          label: "This Week",          icon: LayoutDashboard },
  { href: "/plan-insights",      label: "Plan Insights",      icon: BarChart2 },
  { href: "/personal-insights",  label: "Personal Insights",  icon: TrendingUp },
  { href: "/coach",              label: "AI Coach",            icon: BotMessageSquare },
  { href: "/health",             label: "Health",             icon: Heart },
  { href: "/runs",               label: "Runs",               icon: Footprints },
  { href: "/routes",             label: "Routes",             icon: Map },
  { href: "/workouts",           label: "Workouts",           icon: Dumbbell },
  { href: "/plans",              label: "Plans",              icon: ClipboardList },
  { href: "/races",              label: "Races",              icon: Trophy },
  { href: "/shoes",              label: "Shoes",              icon: CircleDot },
];

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

function BottomTabBar() {
  const pathname = usePathname();

  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-card border-t border-border h-16 z-50 flex items-center">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            aria-label={label}
            className={`flex-1 flex items-center justify-center h-full transition-colors ${
              active ? "text-primary" : "text-textSecondary"
            }`}
          >
            <Icon size={22} />
          </Link>
        );
      })}
    </nav>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <div className="flex flex-col min-h-screen">
        <HubBanner />
        <div className="flex flex-1 overflow-hidden">
          <SideNav />
          <main className="flex-1 overflow-y-auto bg-surface p-6 pb-20 lg:pb-6">{children}</main>
        </div>
        <BottomTabBar />
      </div>
    </AuthGuard>
  );
}
