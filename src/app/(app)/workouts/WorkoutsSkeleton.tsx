"use client";

import React from "react";
import { Skeleton } from "@/components/ui/Skeleton";

/** One list-row placeholder mirroring WorkoutRow's column layout: date,
 *  icon+name, type badge, duration, calories, HR, load badge. */
function WorkoutRowSkeleton() {
  return (
    <div className="flex items-center gap-3 py-3 px-4">
      <Skeleton className="w-11 h-8 rounded shrink-0" />
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <Skeleton className="w-4 h-4 rounded shrink-0" />
        <Skeleton className="h-4 w-32 rounded" />
      </div>
      <Skeleton className="w-14 h-5 rounded-full shrink-0" />
      <Skeleton className="w-16 h-4 rounded shrink-0" />
      <Skeleton className="hidden md:block w-20 h-4 rounded shrink-0" />
      <Skeleton className="hidden md:block w-20 h-4 rounded shrink-0" />
      <Skeleton className="w-12 h-5 rounded-full shrink-0" />
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
 * Loading placeholder for the workouts list page's initial data fetch.
 * Mirrors the loaded page's two-column layout: left sidebar (year + type
 * tabs, summary tile, mini calendar, export button) and a right-hand list of
 * ~8 workout rows matching WorkoutRow's exact column widths. Presentation-only;
 * no data/logic.
 */
function WorkoutsSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading workouts"
      className="flex flex-col lg:flex-row gap-6 p-4 lg:p-6 min-h-full"
    >
      {/* Left sidebar */}
      <aside className="w-full lg:w-64 shrink-0 flex flex-col gap-5">
        <SidebarTile lines={2} />
        <SidebarTile lines={3} />
        <div className="hidden lg:block bg-card rounded-2xl border border-border p-4">
          <Skeleton className="h-3 w-20 rounded mb-3" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
        <Skeleton className="h-10 w-full rounded-xl" />
      </aside>

      {/* Right-hand workout list */}
      <main className="flex-1 min-w-0">
        <div className="bg-card rounded-2xl border border-border divide-y divide-border">
          {Array.from({ length: 8 }).map((_, i) => (
            <WorkoutRowSkeleton key={i} />
          ))}
        </div>
      </main>
    </div>
  );
}

export { WorkoutsSkeleton };
export default WorkoutsSkeleton;
