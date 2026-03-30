"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AuthGuard } from "@/components/layout/AuthGuard";
import { HubBanner } from "@/components/layout/HubBanner";

const NAV_ITEMS = [
  { href: "/dashboard", label: "This Week" },
  { href: "/runs", label: "Runs" },
  { href: "/workouts", label: "Workouts" },
  { href: "/plans", label: "Plan" },
  { href: "/races", label: "Races" },
  { href: "/shoes", label: "Shoes" },
];

function SideNav() {
  const pathname = usePathname();

  return (
    <nav className="w-52 shrink-0 border-r border-gray-200 bg-white flex flex-col py-4 gap-1 px-2">
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              active
                ? "bg-blue-50 text-blue-700"
                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            }`}
          >
            {item.label}
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
          <main className="flex-1 overflow-y-auto p-6">{children}</main>
        </div>
      </div>
    </AuthGuard>
  );
}
