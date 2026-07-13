"use client";

import React from "react";
import { Skeleton } from "@/components/ui/Skeleton";

/**
 * Loading placeholder for the dashboard's initial (pre-`loading`-gate) data
 * fetch. Mirrors the loaded page's row order and card boundaries — title,
 * week navigator, Week Score card, Mon–Sun week calendar, Activity Rings
 * hero, the two training-load cards, the Running KPI row, the Running /
 * This-Week's-Runs pair, the Workout KPI row, and the Workout Plan / This
 * Week's Workouts pair — so there's no layout shift once data arrives.
 * Presentation-only; no data/logic.
 */
function DashboardSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading dashboard"
      className="flex flex-col gap-5 p-6 lg:p-6 p-4 max-w-5xl mx-auto"
    >
      {/* Page title */}
      <Skeleton className="w-40 h-8 rounded" />

      {/* Week navigator */}
      <Skeleton className="w-full h-10 rounded-xl" />

      {/* Week Score card — ring + title/progress-bar stack */}
      <div className="bg-card rounded-2xl border border-border p-5">
        <div className="flex items-center gap-6">
          <Skeleton className="shrink-0 w-[110px] h-[110px] rounded-full" />
          <div className="flex-1 min-w-0 flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3 w-20 rounded" />
              <Skeleton className="h-5 w-32 rounded" />
              <Skeleton className="h-3 w-40 rounded" />
            </div>
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-2.5 rounded-full" />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 7-column Mon–Sun week calendar */}
      <div className="grid grid-cols-7 gap-px bg-border rounded-xl overflow-hidden border border-border">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-[90px] rounded-none" />
        ))}
      </div>

      {/* Activity Rings hero — centered circle */}
      <div className="bg-card rounded-2xl border border-border p-5">
        <Skeleton className="w-32 h-4 rounded mb-4" />
        <div className="flex justify-center">
          <Skeleton className="w-[220px] h-[220px] rounded-full" />
        </div>
      </div>

      {/* Training Load row — Mileage + Load Score cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[0, 1].map((i) => (
          <div key={i} className="bg-card rounded-2xl border border-border p-5 flex flex-col gap-4">
            <Skeleton className="w-40 h-4 rounded" />
            <div className="grid grid-cols-2 gap-4">
              <Skeleton className="h-8 rounded" />
              <Skeleton className="h-8 rounded" />
            </div>
            <Skeleton className="w-24 h-5 rounded" />
          </div>
        ))}
      </div>

      {/* Running KPI row */}
      <div className="bg-card rounded-2xl border border-border p-5">
        <Skeleton className="w-24 h-4 rounded mb-4" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 rounded" />
          ))}
        </div>
      </div>

      {/* Running Plan + This Week's Runs pair */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-56 rounded-2xl" />
        ))}
      </div>

      {/* Workout KPI row */}
      <div className="bg-card rounded-2xl border border-border p-5">
        <Skeleton className="w-24 h-4 rounded mb-4" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 rounded" />
          ))}
        </div>
      </div>

      {/* Workout Plan + This Week's Workouts pair */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-56 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

export { DashboardSkeleton };
export default DashboardSkeleton;
