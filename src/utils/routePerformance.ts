/**
 * Route performance — pure, in-memory selectors for the Run Detail "Route
 * Performance" card and the shared MatchedRunsList.
 *
 * Ranking rule (approved product decision): best-effort rank is by PACE across
 * ALL matched runs in the route group, including distance-mismatched ones
 * (e.g. a 13.4 mi race that clustered with a 9 mi route still ranks by its
 * pace). No distance filtering happens here — the clustering decides
 * membership; this module only orders what it's given.
 *
 * No Firestore reads or writes.
 */

import { type HealthWorkout } from "@/types/healthWorkout";
import { resolveDisplayLoad } from "@/utils/trainingLoad";

export interface MatchedRunSummary {
  runId: string;
  /** ISO "YYYY-MM-DD" (local calendar date). */
  date: string;
  /** Avg pace, seconds per mile. */
  paceSeconds: number;
  distanceMiles: number;
  /** Display load via resolveDisplayLoad; null if unavailable (renders "—"). */
  load: number | null;
}

export interface RoutePerformance {
  matchedCount: number;
  /** Mean pace across matched runs (sec/mi). */
  routeAvgPaceSeconds: number;
  /** This run's pace minus the route average; negative = faster than avg. */
  deltaVsAvgSeconds: number;
  /** 1 = fastest by pace. */
  rank: number;
  /** Top 3 by pace, ascending (fastest first). */
  bestEfforts: MatchedRunSummary[];
}

/** YYYY-MM-DD from a Date using its local components. */
function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * A run's avg pace in sec/mi. Prefers the device `avgPaceSecPerMile`; falls
 * back to durationSeconds / distanceMiles (older sync rows can have a null
 * stored pace — same fallback the PR computation uses). Null when neither is
 * derivable.
 */
export function runPaceSeconds(run: {
  avgPaceSecPerMile?: number | null;
  durationSeconds: number;
  distanceMiles: number;
}): number | null {
  if (
    typeof run.avgPaceSecPerMile === "number" &&
    Number.isFinite(run.avgPaceSecPerMile) &&
    run.avgPaceSecPerMile > 0
  ) {
    return run.avgPaceSecPerMile;
  }
  if (run.distanceMiles > 0 && run.durationSeconds > 0) {
    return run.durationSeconds / run.distanceMiles;
  }
  return null;
}

/**
 * Map a route group's runs to MatchedRunSummary rows. Runs with no derivable
 * pace are dropped (they can't be ranked or charted). Load goes through
 * resolveDisplayLoad — the single source of truth for displayed load.
 */
export function toMatchedRunSummaries(
  runs: HealthWorkout[],
  maxHr: number,
  restingHr: number
): MatchedRunSummary[] {
  return runs.flatMap((w) => {
    const pace = runPaceSeconds(w);
    if (pace == null) return [];
    return [
      {
        runId: w.workoutId,
        date: toLocalIsoDate(w.startDate),
        paceSeconds: pace,
        distanceMiles: w.distanceMiles ?? 0,
        load: resolveDisplayLoad(w, maxHr, restingHr),
      },
    ];
  });
}

/**
 * Rank + pace-vs-average summary for the current run within its route group.
 * Null when the run isn't in the group or the group has < 2 runs (a route
 * needs at least one comparison run for any of this to mean something).
 */
export function computeRoutePerformance(
  currentRunId: string,
  matchedRuns: MatchedRunSummary[]
): RoutePerformance | null {
  if (matchedRuns.length < 2) return null;
  const current = matchedRuns.find((r) => r.runId === currentRunId);
  if (!current) return null;

  // Fastest first; date breaks pace ties deterministically (earlier run keeps
  // the better rank — it set the mark first).
  const sorted = [...matchedRuns].sort(
    (a, b) => a.paceSeconds - b.paceSeconds || a.date.localeCompare(b.date)
  );
  const rank = sorted.findIndex((r) => r.runId === currentRunId) + 1;

  const routeAvgPaceSeconds =
    matchedRuns.reduce((sum, r) => sum + r.paceSeconds, 0) /
    matchedRuns.length;

  return {
    matchedCount: matchedRuns.length,
    routeAvgPaceSeconds,
    deltaVsAvgSeconds: current.paceSeconds - routeAvgPaceSeconds,
    rank,
    bestEfforts: sorted.slice(0, 3),
  };
}
