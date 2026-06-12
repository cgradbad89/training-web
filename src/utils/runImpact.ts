/**
 * "This Run's Impact" — with/without-this-run recomputes for the Run Detail
 * impact card. Pure, in-memory; no Firestore.
 *
 * HONESTY RULE (approved product decision): deltas are reported exactly as
 * computed. A slow run that worsens the race prediction yields an unfavorable
 * (positive) deltaSeconds — never suppressed or clamped.
 *
 * Both selectors call the EXISTING model entry points with a filtered input
 * list — the prediction model (predictRaceTime → Riegel WLS) and the CTL EWMA
 * (buildDailyLoadMap → buildLoadEwmaSeries) are not reimplemented here.
 */

import {
  predictRaceTime,
  type PredictionRun,
  type RacePredictionParams,
} from "@/utils/racePrediction";
import {
  buildDailyLoadMap,
  buildLoadEwmaSeries,
} from "@/utils/trainingLoadSeries";
import { type HealthWorkout } from "@/types/healthWorkout";

export interface PredictionImpact {
  /** Current displayed prediction (full run set), seconds. */
  withSeconds: number;
  /** Prediction with this run excluded; null = the remaining history can't
   *  support a prediction ("Not enough history without this run"). */
  withoutSeconds: number | null;
  /** withSeconds − withoutSeconds. Negative = this run IMPROVED (lowered) the
   *  prediction; positive = it worsened it. Null when withoutSeconds is null. */
  deltaSeconds: number | null;
}

/**
 * Race prediction with vs. without the current run.
 *
 * Returns null when no prediction exists even WITH the full run set (the tile
 * is hidden — there is no "current prediction" to compare against). When only
 * the without-run recompute fails (e.g. the run is the race anchor, or
 * exclusion drops the qualifying efforts below the model's minimum of 4),
 * `withoutSeconds`/`deltaSeconds` are null — the sentinel for "Not enough
 * history without this run".
 */
export function computePredictionImpact(
  runs: PredictionRun[],
  currentRunId: string,
  params: RacePredictionParams,
  asOf: Date = new Date()
): PredictionImpact | null {
  const withResult = predictRaceTime(runs, params, asOf);
  if (withResult.predictedSeconds == null) return null;

  const withoutRuns = runs.filter((r) => r.workoutId !== currentRunId);
  const withoutResult = predictRaceTime(withoutRuns, params, asOf);
  const withoutSeconds = withoutResult.predictedSeconds;

  return {
    withSeconds: withResult.predictedSeconds,
    withoutSeconds,
    deltaSeconds:
      withoutSeconds == null
        ? null
        : withResult.predictedSeconds - withoutSeconds,
  };
}

export interface CtlImpact {
  /** Today's CTL (42-day EWMA) with the full workout set. */
  withCtl: number;
  /** Today's CTL with this run's load excluded. */
  withoutCtl: number;
  /** withCtl − withoutCtl. ≥ 0 in practice (a run's load contribution is
   *  non-negative); 0 when the run has no resolvable load. */
  delta: number;
}

/** Seed window — matches Personal Insights (well past 3× CTL_DAYS=42). */
export const CTL_IMPACT_SEED_DAYS = 180;

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Today's CTL with vs. without the current run. Mirrors the Personal Insights
 * seeding (180 days, or the earliest workout if history is shorter) and walks
 * BOTH series over the IDENTICAL date window, so the delta isolates this run's
 * load contribution — nothing else differs between the two walks.
 *
 * Loads resolve via buildDailyLoadMap → resolveDisplayLoad (single source of
 * truth); a run whose load is null contributes 0 to both series → delta 0,
 * reported honestly rather than hidden.
 */
export function computeCtlImpact(
  workouts: HealthWorkout[],
  currentRunId: string,
  maxHr: number,
  restingHr: number,
  today: Date = new Date()
): CtlImpact | null {
  if (workouts.length === 0) return null;

  const todayLocal = startOfLocalDay(today);

  const earliestMs = workouts.reduce(
    (min, w) => Math.min(min, w.startDate.getTime()),
    Infinity
  );
  const seedFromWindow = new Date(todayLocal);
  seedFromWindow.setDate(todayLocal.getDate() - (CTL_IMPACT_SEED_DAYS - 1));
  const seedStart =
    isFinite(earliestMs) && new Date(earliestMs) > seedFromWindow
      ? startOfLocalDay(new Date(earliestMs))
      : seedFromWindow;

  const withMap = buildDailyLoadMap(workouts, maxHr, restingHr);
  const withSeries = buildLoadEwmaSeries(withMap, seedStart, todayLocal);

  const withoutMap = buildDailyLoadMap(
    workouts.filter((w) => w.workoutId !== currentRunId),
    maxHr,
    restingHr
  );
  const withoutSeries = buildLoadEwmaSeries(withoutMap, seedStart, todayLocal);

  const withLast = withSeries[withSeries.length - 1];
  const withoutLast = withoutSeries[withoutSeries.length - 1];
  if (!withLast || !withoutLast) return null;

  return {
    withCtl: withLast.ctl,
    withoutCtl: withoutLast.ctl,
    delta: withLast.ctl - withoutLast.ctl,
  };
}
