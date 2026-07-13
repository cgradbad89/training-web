"use client";

import React from "react";
import { Skeleton } from "@/components/ui/Skeleton";

/** Section-header-shaped block: icon dot + title bar, mirrors SectionHeader. */
function SectionHeaderSkeleton() {
  return (
    <div className="flex items-center gap-2 mb-4">
      <Skeleton className="w-[18px] h-[18px] rounded" />
      <Skeleton className="h-5 w-48 rounded" />
    </div>
  );
}

/** Card-shaped wrapper matching this page's `<Card>` (bg-card + border + p-5). */
function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-2xl border border-border p-5">{children}</div>
  );
}

/**
 * Loading placeholder for personal-insights' initial data fetch. Mirrors the
 * loaded page's section order: Cardio Fitness (VO2), Training Load, Predicted
 * Race Times, Best Efforts, Pace Trends, Weather Impact, Personal Records by
 * Year — each a title-bar block + content block sized to that section's
 * actual shape. Presentation-only; no data/logic.
 */
function PersonalInsightsSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading personal insights"
      className="flex flex-col gap-6 p-6 lg:p-6 max-w-5xl mx-auto"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="w-56 h-8 rounded" />
        <Skeleton className="w-36 h-9 rounded-xl" />
      </div>

      {/* Cardio Fitness (VO2) — big number + threshold bar + trend chart */}
      <SectionHeaderSkeleton />
      <CardShell>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-10 w-24 rounded" />
          <Skeleton className="h-2.5 w-full rounded-full" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </CardShell>

      {/* Training Load — 4 metric cards + charts */}
      <SectionHeaderSkeleton />
      <CardShell>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-56 w-full rounded-xl" />
        </div>
      </CardShell>

      {/* Predicted Race Times — 4-tile grid */}
      <SectionHeaderSkeleton />
      <CardShell>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded" />
          ))}
        </div>
      </CardShell>

      {/* Best Efforts */}
      <SectionHeaderSkeleton />
      <CardShell>
        <Skeleton className="h-32 w-full rounded-xl" />
      </CardShell>

      {/* Pace Trends / Pace by Distance — single large chart */}
      <SectionHeaderSkeleton />
      <Skeleton className="h-64 w-full rounded-2xl" />

      {/* Weather Impact — 2 side-by-side charts */}
      <SectionHeaderSkeleton />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>

      {/* Personal Records by Year */}
      <SectionHeaderSkeleton />
      <CardShell>
        <Skeleton className="h-40 w-full rounded-xl" />
      </CardShell>
    </div>
  );
}

export { PersonalInsightsSkeleton };
export default PersonalInsightsSkeleton;
