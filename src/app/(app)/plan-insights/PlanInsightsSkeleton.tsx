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

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-2xl border border-border p-5">{children}</div>
  );
}

/**
 * Loading placeholder for plan-insights' initial data fetch. One card per
 * section in the loaded page's actual order: Race Predictions
 * (PredictionTrendChart), Plan adherence (PlanAdherenceChart), Actual vs
 * Planned (PlanRunLoadChart + table), Race Readiness, Performance by Run
 * Type, Recent Trends. Presentation-only; no data/logic.
 */
function PlanInsightsSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading plan insights"
      className="flex flex-col gap-6 p-6 lg:p-6 max-w-5xl mx-auto"
    >
      <div className="flex items-center justify-between">
        <Skeleton className="w-40 h-8 rounded" />
        <Skeleton className="w-36 h-9 rounded-xl" />
      </div>

      {/* Race picker row */}
      <Skeleton className="h-9 w-64 rounded-xl" />

      {/* Race Predictions — PredictionTrendChart */}
      <SectionHeaderSkeleton />
      <CardShell>
        <Skeleton className="h-56 w-full rounded-xl" />
      </CardShell>

      {/* Plan: adherence — PlanAdherenceChart */}
      <SectionHeaderSkeleton />
      <CardShell>
        <Skeleton className="h-56 w-full rounded-xl" />
      </CardShell>

      {/* Actual vs Planned — table + PlanRunLoadChart */}
      <SectionHeaderSkeleton />
      <CardShell>
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full rounded" />
          ))}
        </div>
      </CardShell>
      <Skeleton className="h-56 w-full rounded-2xl" />

      {/* Race Readiness */}
      <SectionHeaderSkeleton />
      <CardShell>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded" />
          ))}
        </div>
      </CardShell>

      {/* Performance by Run Type */}
      <SectionHeaderSkeleton />
      <CardShell>
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded" />
          ))}
        </div>
      </CardShell>

      {/* Recent Trends */}
      <SectionHeaderSkeleton />
      <CardShell>
        <Skeleton className="h-40 w-full rounded-xl" />
      </CardShell>
    </div>
  );
}

export { PlanInsightsSkeleton };
export default PlanInsightsSkeleton;
