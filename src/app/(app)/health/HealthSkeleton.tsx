"use client";

import React from "react";
import { Skeleton } from "@/components/ui/Skeleton";

/**
 * Loading placeholder for the health page's initial data fetch. The page
 * defaults to the "Today" tab, so this mirrors that tab's actual shape:
 * header, tab strip, the Activity Rings hero card (220px circle), and the
 * 5-column per-ring KPI card grid beneath it. Presentation-only; no
 * data/logic.
 */
function HealthSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading health"
      className="p-6 max-w-5xl mx-auto"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6 gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="w-24 h-8 rounded" />
          <Skeleton className="w-40 h-3 rounded" />
        </div>
      </div>

      {/* Tab strip */}
      <div className="mb-6">
        <Skeleton className="h-10 w-64 rounded-xl" />
      </div>

      {/* Activity Rings hero */}
      <div className="bg-card rounded-2xl border border-border p-5 mb-8">
        <div className="flex items-center justify-between gap-2 mb-5">
          <Skeleton className="h-8 w-40 rounded-xl" />
          <Skeleton className="h-8 w-8 rounded-xl" />
        </div>
        <div className="flex justify-center">
          <Skeleton className="w-[220px] h-[220px] rounded-full" />
        </div>
      </div>

      {/* Per-ring KPI card grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}

export { HealthSkeleton };
export default HealthSkeleton;
