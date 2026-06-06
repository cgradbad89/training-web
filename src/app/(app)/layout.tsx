"use client";

import React from "react";
import "leaflet/dist/leaflet.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AuthGuard } from "@/components/layout/AuthGuard";
import { HubBanner } from "@/components/layout/HubBanner";
import { GoogleMapsProvider } from "@/components/GoogleMapsProvider";
import AutoMatchRunner from "@/components/AutoMatchRunner";
import PRComputerRunner from "@/components/PRComputerRunner";
import { MobileTabBar } from "@/components/layout/MobileTabBar";
import { NAV_ITEMS } from "@/components/layout/navItems";

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

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <AutoMatchRunner />
      <PRComputerRunner />
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
          <MobileTabBar />
        </div>
      </GoogleMapsProvider>
    </AuthGuard>
  );
}
