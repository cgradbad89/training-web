/**
 * Pure race-time prediction + weekly prediction trend.
 *
 * `predictRaceTime` is the SAME pipeline the Plan Insights prediction card uses
 * (buildQualifyingEfforts → fitRiegel → predictSeconds), with the reference
 * date exposed as `asOf`. asOf bounds the runs (on/before it) AND is the
 * reference for all decay / memory math. asOf defaults to now, in which case
 * the result is identical to the pre-refactor inline computation — the MODEL
 * (weights, k-clamp, decay formula) is unchanged; only the reference date moves.
 *
 * `buildPredictionTrend` recomputes that prediction once per plan week (asOf =
 * the week's end) so the gap to the goal finish can be tracked week over week.
 * No storage — everything is recomputed in-memory from historical runs.
 */

import {
  buildQualifyingEfforts,
  fitRiegel,
  predictSeconds,
  type RaceMatchInput,
  type RiegelFit,
} from "@/utils/riegelFit";
import { type RunningPlan } from "@/types/plan";

/** Half-marathon threshold (miles) above which the long-run k-clamp applies. */
export const HALF_MARATHON_MILES = 13.109;

/** Minimal run shape consumed by the prediction (a subset of HealthWorkout). */
export interface PredictionRun {
  workoutId: string;
  distanceMiles?: number | null;
  durationSeconds: number;
  startDate: Date | string | { toDate?: () => Date } | null | undefined;
  activityType: string;
  sourceName?: string;
}

export interface RacePredictionParams {
  /** Target race distance in miles. */
  raceDistanceMiles: number;
  /** The user's races, for ±1-day RACE-tier anchoring (see buildQualifyingEfforts). */
  races: RaceMatchInput[];
  /** Ordinary-run lookback window in days. Default 56 (matches the page). */
  daysBack?: number;
}

export interface RacePredictionResult {
  fit: RiegelFit | null;
  predictedSeconds: number | null;
}

/**
 * Predict race finish time as of `asOf` (default now). Mirrors the Plan
 * Insights card's k-clamp branching exactly: half+ uses minMilesForFit=3.0 and
 * k∈[1.04,1.10]; shorter targets use minMilesForFit=0 and k∈[0.9,1.3].
 */
export function predictRaceTime(
  runs: PredictionRun[],
  params: RacePredictionParams,
  asOf: Date = new Date()
): RacePredictionResult {
  const { raceDistanceMiles, races, daysBack = 56 } = params;
  if (!raceDistanceMiles || raceDistanceMiles <= 0) {
    return { fit: null, predictedSeconds: null };
  }

  const efforts = buildQualifyingEfforts(runs, { daysBack, races, asOf });

  const fit =
    raceDistanceMiles >= HALF_MARATHON_MILES
      ? fitRiegel(efforts, raceDistanceMiles, 3.0, { min: 1.04, max: 1.1 })
      : fitRiegel(efforts, raceDistanceMiles, 0, { min: 0.9, max: 1.3 });

  return {
    fit,
    predictedSeconds: fit ? predictSeconds(fit, raceDistanceMiles) : null,
  };
}

export interface PredictionTrendPoint {
  weekNumber: number; // 1-based
  label: string; // "W1"
  /** Predicted finish (seconds) recomputed as of this week's end; null when the
   *  week is in the future or there's insufficient data to fit. */
  predictedSeconds: number | null;
  /** Constant goal-finish reference (seconds); null when no target is set. */
  goalSeconds: number | null;
}

export interface PredictionTrendParams extends RacePredictionParams {
  /** Goal finish in seconds (target pace × distance); null if no target. */
  goalSeconds: number | null;
}

/**
 * For each plan week, recompute `predictRaceTime` with asOf = that week's END
 * (Mon-start + 6d, end-of-day) — the SAME week boundaries `buildPlanAdherence`
 * uses, so the trend lines up week-for-week with the adherence charts.
 *
 * - Weeks that haven't started yet (start > now) → predictedSeconds null (don't
 *   fabricate a point for the future).
 * - The in-progress week uses asOf = now, so the latest point equals the
 *   prediction card's current number.
 * - Weeks with insufficient data to fit → null (line breaks / starts where data
 *   supports it).
 * `goalSeconds` is the same constant on every point (the reference line).
 */
export function buildPredictionTrend(
  plan: RunningPlan,
  runs: PredictionRun[],
  params: PredictionTrendParams,
  now: Date = new Date()
): PredictionTrendPoint[] {
  const { goalSeconds } = params;
  const planStart = new Date(plan.startDate);
  const nowMs = now.getTime();

  return plan.weeks.map((week) => {
    // Week date range — identical to buildPlanAdherence (Mon → Sun EOD).
    const ws = new Date(planStart);
    ws.setDate(ws.getDate() + (week.weekNumber - 1) * 7);
    const we = new Date(ws);
    we.setDate(ws.getDate() + 6);
    we.setHours(23, 59, 59, 999);

    const base = {
      weekNumber: week.weekNumber,
      label: `W${week.weekNumber}`,
      goalSeconds,
    };

    // Week hasn't started → no data as of then.
    if (ws.getTime() > nowMs) {
      return { ...base, predictedSeconds: null };
    }

    // Past week → asOf = week end; current (in-progress) week → asOf = now.
    const asOf = we.getTime() <= nowMs ? we : now;
    const { predictedSeconds } = predictRaceTime(runs, params, asOf);
    return { ...base, predictedSeconds };
  });
}
