"use client";

import React from "react";
import { Skeleton } from "@/components/ui/Skeleton";

/** Card placeholder mirroring ShoeCard: name block + badge, mileage
 *  progress-bar block, 3-column stat blocks. */
function ShoeCardSkeleton() {
  return (
    <div className="bg-card rounded-2xl shadow-sm border border-border p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5 min-w-0">
          <Skeleton className="h-5 w-32 rounded" />
          <Skeleton className="h-3 w-24 rounded" />
        </div>
        <Skeleton className="h-6 w-14 rounded-full shrink-0" />
      </div>
      <Skeleton className="h-2.5 w-full rounded-full" />
      <div className="grid grid-cols-3 gap-3 pt-1 border-t border-border">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1">
            <Skeleton className="h-3 w-12 rounded" />
            <Skeleton className="h-4 w-16 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Loading placeholder for the shoes page's initial data fetch. Mirrors the
 * loaded page's header + 2-column grid of ~6 shoe cards, each matching
 * ShoeCard's name/badge, mileage bar, and 3-stat-row shape. Presentation-only;
 * no data/logic.
 */
function ShoesSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading shoes"
      className="p-4 lg:p-6"
    >
      <div className="flex items-center justify-between mb-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="w-24 h-7 rounded" />
          <Skeleton className="w-52 h-3 rounded" />
        </div>
        <Skeleton className="w-28 h-9 rounded-xl" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <ShoeCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export { ShoesSkeleton };
export default ShoesSkeleton;
