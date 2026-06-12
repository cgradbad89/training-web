"use client";

import { useState } from "react";

import { MatchedRunsList } from "@/components/MatchedRunsList";
import {
  type MatchedRunSummary,
  type RoutePerformance,
} from "@/utils/routePerformance";
import { formatPace } from "@/utils/pace";
import { parseLocalDate } from "@/utils/dates";

interface RoutePerformanceSectionProps {
  performance: RoutePerformance;
  /** All matched runs in the group (feeds the flyout, newest first there). */
  matchedRuns: MatchedRunSummary[];
  currentRunId: string;
  /** The route's nominal distance (cluster representative). */
  routeDistanceMiles: number;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function formatShortDate(iso: string): string {
  return parseLocalDate(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function RankBadge({ rank, total }: { rank: number; total: number }) {
  if (rank === 1) {
    return (
      <span className="text-xs font-semibold bg-success/10 text-success border border-success/20 px-2.5 py-1 rounded-full shrink-0">
        Fastest on this route
      </span>
    );
  }
  if (rank === 2 || rank === 3) {
    // Muted metallic (silver/bronze) — token-only styling.
    return (
      <span className="text-xs font-semibold bg-surface text-textPrimary border border-border px-2.5 py-1 rounded-full shrink-0">
        {ordinal(rank)} fastest
      </span>
    );
  }
  return (
    <span className="text-xs font-medium text-textSecondary border border-border px-2.5 py-1 rounded-full shrink-0">
      {ordinal(rank)} fastest of {total}
    </span>
  );
}

/**
 * Run Detail "Route Performance" card — rank on the matched route, pace vs the
 * route average, top-3 best efforts, and the "view all matched runs" flyout.
 * The caller renders this only when the run belongs to a group of ≥ 2 runs.
 */
export function RoutePerformanceSection({
  performance,
  matchedRuns,
  currentRunId,
  routeDistanceMiles,
}: RoutePerformanceSectionProps) {
  const [showAllRuns, setShowAllRuns] = useState(false);

  const current = matchedRuns.find((r) => r.runId === currentRunId);
  if (!current) return null;

  const delta = performance.deltaVsAvgSeconds;
  const deltaAbs = Math.round(Math.abs(delta));
  // < 0.5 s/mi rounds to "0s" — call it even rather than faking a direction.
  const deltaMode: "faster" | "slower" | "even" =
    delta <= -0.5 ? "faster" : delta >= 0.5 ? "slower" : "even";

  const flyoutRuns = [...matchedRuns].sort((a, b) =>
    b.date.localeCompare(a.date)
  );

  return (
    <div className="bg-card rounded-2xl border border-border p-5 flex flex-col gap-4">
      {/* Meta row: route chip + rank badge */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-sm font-semibold bg-primary/10 text-primary px-2.5 py-0.5 rounded-full">
          {routeDistanceMiles.toFixed(1)} mi route &middot;{" "}
          {performance.matchedCount} matched runs
        </span>
        <RankBadge rank={performance.rank} total={performance.matchedCount} />
      </div>

      {/* Pace vs route average */}
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-1.5">
          <span className="text-3xl font-bold text-textPrimary tabular-nums">
            {formatPace(current.paceSeconds)}
          </span>
          <span className="text-sm text-textSecondary">/mi</span>
        </div>
        {deltaMode === "faster" && (
          <p className="text-sm font-medium text-success">
            ▲ {deltaAbs}s/mi faster than your route average
          </p>
        )}
        {deltaMode === "slower" && (
          <p className="text-sm font-medium text-danger">
            ▼ {deltaAbs}s/mi slower than your route average
          </p>
        )}
        {deltaMode === "even" && (
          <p className="text-sm font-medium text-textSecondary">
            Right at your route average
          </p>
        )}
        <p className="text-xs text-textSecondary">
          Route average: {formatPace(performance.routeAvgPaceSeconds)} /mi
          across {performance.matchedCount} matched runs
        </p>
      </div>

      {/* Best efforts */}
      <div>
        <h3 className="text-xs font-semibold text-textSecondary uppercase tracking-widest mb-2">
          Best efforts on this route
        </h3>
        <div className="flex flex-col">
          {performance.bestEfforts.map((effort, i) => {
            const isCurrent = effort.runId === currentRunId;
            return (
              <div
                key={effort.runId}
                className={`flex items-center gap-3 py-2 px-2 rounded-lg ${
                  isCurrent ? "bg-primary/5" : ""
                }`}
              >
                <span className="text-xs font-semibold text-textSecondary w-4 tabular-nums">
                  {i + 1}.
                </span>
                <span
                  className={`text-sm font-semibold tabular-nums ${
                    isCurrent ? "text-primary" : "text-textPrimary"
                  }`}
                >
                  {formatPace(effort.paceSeconds)} /mi
                </span>
                {isCurrent && (
                  <span className="text-[9px] font-bold bg-primary/10 text-primary px-1.5 py-0.5 rounded-full uppercase tracking-wide">
                    This run
                  </span>
                )}
                <span className="text-xs text-textSecondary ml-auto">
                  {formatShortDate(effort.date)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* View all matched runs */}
      <button
        onClick={() => setShowAllRuns(true)}
        className="text-xs text-primary font-medium text-left hover:underline"
      >
        View all {performance.matchedCount} matched runs &rarr;
      </button>

      {showAllRuns && (
        <MatchedRunsList
          runs={flyoutRuns}
          currentRunId={currentRunId}
          onClose={() => setShowAllRuns(false)}
          title={`Matched runs · ${routeDistanceMiles.toFixed(1)} mi route`}
        />
      )}
    </div>
  );
}
