"use client";

import React from "react";
import { Skeleton } from "@/components/ui/Skeleton";

/** One list-row placeholder mirroring RunRow's column layout: date, run
 *  info, distance, pace, HR, duration, load badge, shoe. */
function RunRowSkeleton() {
  return (
    <div className="py-3 px-4">
      <div className="flex items-center gap-3">
        <Skeleton className="w-9 h-8 rounded shrink-0" />
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <Skeleton className="h-4 w-32 rounded" />
          <Skeleton className="hidden sm:block h-3 w-12 rounded-full" />
        </div>
        <Skeleton className="w-16 h-4 rounded shrink-0" />
        <Skeleton className="w-20 h-4 rounded shrink-0" />
        <Skeleton className="hidden sm:block w-16 h-4 rounded shrink-0" />
        <Skeleton className="hidden lg:block w-16 h-4 rounded shrink-0" />
        <Skeleton className="w-12 h-5 rounded-full shrink-0" />
        <Skeleton className="hidden sm:block w-28 h-6 rounded-full shrink-0" />
      </div>
    </div>
  );
}

/** Sidebar tile placeholder — matches this page's repeated `bg-card` tiles. */
function SidebarTile({ lines = 3 }: { lines?: number }) {
  return (
    <div className="bg-card rounded-2xl border border-border p-4 flex flex-col gap-4">
      <Skeleton className="h-3 w-20 rounded" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-6 w-full rounded" />
      ))}
    </div>
  );
}

/**
 * Loading placeholder for the runs list page's initial data fetch. Mirrors
 * the loaded page's two-column layout: left sidebar (year/month + filters,
 * summary tile, shoes-used tile, mini calendar) and a right-hand list of
 * ~8 run rows matching RunRow's exact column widths. Presentation-only; no
 * data/logic.
 */
function RunsSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading runs"
      className="flex flex-col lg:flex-row gap-6 p-4 lg:p-6 min-h-full max-w-5xl mx-auto"
    >
      {/* Left sidebar */}
      <aside className="w-full lg:w-64 shrink-0 flex flex-col gap-5">
        <SidebarTile lines={2} />
        <SidebarTile lines={3} />
        <SidebarTile lines={1} />
        <div className="hidden lg:block bg-card rounded-2xl border border-border p-4">
          <Skeleton className="h-3 w-20 rounded mb-3" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </aside>

      {/* Right-hand run list */}
      <main className="flex-1 min-w-0">
        <div className="flex items-center justify-end mb-4">
          <Skeleton className="h-4 w-32 rounded" />
        </div>
        <div className="bg-card rounded-2xl border border-border divide-y divide-border">
          {Array.from({ length: 8 }).map((_, i) => (
            <RunRowSkeleton key={i} />
          ))}
        </div>
      </main>
    </div>
  );
}

export { RunsSkeleton };
export default RunsSkeleton;
