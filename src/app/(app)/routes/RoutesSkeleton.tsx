"use client";

import React from "react";
import { Skeleton } from "@/components/ui/Skeleton";

/** Card placeholder mirroring RouteCard: map thumbnail, distance badge +
 *  run-count row, 3-column stats row, sparkline block, view-link row. */
function RouteCardSkeleton() {
  return (
    <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
      <Skeleton className="h-48 w-full rounded-none" />
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-3 w-12 rounded ml-auto" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1">
              <Skeleton className="h-2.5 w-14 rounded" />
              <Skeleton className="h-4 w-16 rounded" />
            </div>
          ))}
        </div>
        <Skeleton className="h-8 w-full rounded" />
        <Skeleton className="h-3 w-24 rounded" />
      </div>
    </div>
  );
}

/**
 * Loading placeholder for the routes page's initial data fetch. Mirrors the
 * loaded page's header + filter-tab row + 3-column grid of ~6 route cards,
 * each matching RouteCard's map/badge/stats/sparkline/link shape.
 * Presentation-only; no data/logic.
 */
function RoutesSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading routes"
      className="p-4 lg:p-6 flex flex-col gap-6"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="w-24 h-6 rounded" />
        <Skeleton className="w-32 h-4 rounded" />
      </div>

      <div className="flex gap-2 flex-wrap">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-16 rounded-full" />
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <RouteCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export { RoutesSkeleton };
export default RoutesSkeleton;
