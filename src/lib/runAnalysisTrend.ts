/**
 * Run Analysis trend — a GENERALIZATION of Pace by Distance's time-bucketing to
 * five selectable metrics (pace, cadence, efficiency score, load, heart rate).
 *
 * Data layer only — no React, no Firestore reads/writes. The workouts array is
 * passed in already-fetched and single-uid-scoped. HR anchors (restingHr/maxHr)
 * are passed in via the existing resolveMaxHr/resolveRestingHr pattern, never
 * re-fetched.
 *
 * Bucket-width RULES are reused verbatim from src/lib/paceRangeTrend.ts —
 * `granularityForWindow` (weekly for 1m/2m/3m, monthly for 6m/12m/ytd),
 * `windowStartDate` (trailing window anchor), `periodStartFor` (week-start vs
 * month-start) and `labelFor` (the exact label format). Nothing about the
 * bucketing is reinvented here.
 */

import {
  granularityForWindow,
  windowStartDate,
  periodStartFor,
  labelFor,
  MIN_VALID_PACE,
  MAX_VALID_PACE,
  type TrendWindow,
} from "@/lib/paceRangeTrend";
import { computeTrainingLoadV2 } from "@/utils/trainingLoad";
import {
  scoreWorkoutsEfficiency,
  type EfficiencyWorkout,
  type EfficiencyScoreResult,
} from "@/utils/efficiencyScore";

export type RunAnalysisMetric =
  | "pace"
  | "cadence"
  | "efficiencyScore"
  | "load"
  | "heartRate";

export interface RunAnalysisWorkout {
  workoutId: string;
  /** ISO date/timestamp string. Parsed to a local Date for bucketing and passed
   *  straight to efficiency scoring (which accepts string startDate). */
  date: string;
  distanceMiles: number;
  durationSeconds: number;
  avgPaceSecPerMile: number | null;
  avgHeartRate: number | null;
  cadenceSPM: number | null;
  /** Raw HealthKit activityType string — selects the Training Load activity factor. */
  activityType: string;
}

export interface RunAnalysisPoint {
  /** Exact label format from computePaceRangeTrend ("May 5" weekly, "May" monthly). */
  bucketLabel: string;
  /** Local YYYY-MM-DD of the bucket's period start (Monday-start week or month-start). */
  bucketStartDate: string;
  /** Average of the selected metric across qualifying runs; null when zero
   *  qualifying runs contributed a value (renders a gap, never a false 0). */
  value: number | null;
  /** Distance+window-matching runs in this bucket, regardless of whether the
   *  metric itself was computable (powers "N of M scored" messaging). */
  runCount: number;
}

/** Local YYYY-MM-DD (no UTC shift) — mirrors efficiencyScore's isoDate. */
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isPositiveFinite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v) && v > 0;
}

/** RunAnalysisWorkout → the minimal EfficiencyWorkout shape (date → startDate).
 *  Exported so table/detail surfaces score the SAME shape this module buckets,
 *  rather than duplicating the mapping. */
export function toEfficiencyWorkout(w: RunAnalysisWorkout): EfficiencyWorkout {
  return {
    workoutId: w.workoutId,
    startDate: w.date,
    distanceMiles: w.distanceMiles,
    durationSeconds: w.durationSeconds,
    avgPaceSecPerMile: w.avgPaceSecPerMile,
    avgHeartRate: w.avgHeartRate,
    cadenceSPM: w.cadenceSPM,
  };
}

/**
 * The metric value contributed by a single run, or null when this run can't
 * contribute (missing input, un-computable load, or a still-building efficiency
 * baseline). A null contribution is EXCLUDED from the bucket average — never
 * treated as 0.
 */
function metricContribution(
  w: RunAnalysisWorkout,
  metric: RunAnalysisMetric,
  effScores: Map<string, EfficiencyScoreResult> | null,
  restingHr: number,
  maxHr: number
): { value: number; weight: number } | null {
  switch (metric) {
    case "pace": {
      // DISTANCE-WEIGHTED, matching computePaceRangeTrend exactly: pace is
      // derived from durationSeconds / distanceMiles (NOT the avgPaceSecPerMile
      // field) and weighted by distanceMiles, so a bucket reduces to
      // Σ durationSeconds / Σ distanceMiles. Runs without a positive distance or
      // duration can't yield a pace and are excluded (a long+short mix is then
      // weighted by mileage, not counted equally). NB: computePaceRangeTrend's
      // [MIN_VALID_PACE, MAX_VALID_PACE] sec/mi sanity bounds — the SAME outlier
      // guard computePaceRangeTrend applies (a GPS-glitch sub-3:00/mi split or a
      // stopped-clock 20:00+/mi crawl is dropped so it can't distort the bucket).
      // Pace-metric only; the other metrics have no such bound.
      if (!isPositiveFinite(w.distanceMiles)) return null;
      if (!isPositiveFinite(w.durationSeconds)) return null;
      const pace = w.durationSeconds / w.distanceMiles;
      if (!Number.isFinite(pace)) return null;
      if (pace < MIN_VALID_PACE || pace > MAX_VALID_PACE) return null;
      return { value: pace, weight: w.distanceMiles };
    }
    case "cadence":
      return isPositiveFinite(w.cadenceSPM)
        ? { value: w.cadenceSPM, weight: 1 }
        : null;
    case "heartRate":
      return isPositiveFinite(w.avgHeartRate)
        ? { value: w.avgHeartRate, weight: 1 }
        : null;
    case "load": {
      const load = computeTrainingLoadV2(
        w.durationSeconds,
        w.avgHeartRate,
        maxHr,
        restingHr,
        w.activityType
      );
      return load != null && Number.isFinite(load)
        ? { value: load, weight: 1 }
        : null;
    }
    case "efficiencyScore": {
      const r = effScores?.get(w.workoutId);
      // Only 'scored' runs count; 'building_baseline' is excluded (not 0).
      if (!r || r.status !== "scored" || r.score == null) return null;
      return { value: r.score, weight: 1 };
    }
  }
}

interface BucketAccum {
  periodStart: Date;
  /** Σ(value × weight) across contributing runs. For pace, weight = miles so
   *  this is Σ durationSeconds; for the other metrics weight = 1 so it is a
   *  plain Σ value. */
  weightedSum: number;
  /** Σ(weight) — the denominator, and the "did any run contribute?" gate. For
   *  the weight-1 metrics this equals the count of contributing runs, so their
   *  arithmetic (weightedSum / weightSum) is identical to a simple mean. */
  weightSum: number;
  /** Distance+window-matching runs, regardless of metric computability. */
  runCount: number;
}

/**
 * Build a per-bucket trend for one metric over runs whose TOTAL distance falls
 * in [minMiles, maxMiles] inclusive, within the trailing window (same anchor +
 * granularity as computePaceRangeTrend).
 *
 * For the efficiencyScore metric, scoreWorkoutsEfficiency is called ONCE over
 * the FULL passed workout set (so each run's baseline is built from its
 * neighbours), then the distance filter is applied only to bucket membership —
 * exactly as buildEfficiencyTrend does. building_baseline runs are excluded
 * from the average. For load, computeTrainingLoadV2 is evaluated per run and
 * null results are skipped. For pace/cadence/heartRate, null/invalid values are
 * excluded from the average.
 *
 * A bucket with zero qualifying (valid-metric) runs gets value: null so the UI
 * renders a gap instead of a false dip. `now` defaults to new Date() and exists
 * only to make the trailing-window anchor deterministic in tests (mirrors
 * computePaceRangeTrend's `now` parameter).
 */
export function buildRunAnalysisTrend(
  workouts: RunAnalysisWorkout[],
  metric: RunAnalysisMetric,
  minMiles: number,
  maxMiles: number,
  windowKey: TrendWindow,
  restingHr: number,
  maxHr: number,
  now: Date = new Date()
): RunAnalysisPoint[] {
  const granularity = granularityForWindow(windowKey);
  const start = windowStartDate(windowKey, now);

  // Efficiency scores are baseline-relative, so score the FULL population once —
  // NOT the distance-filtered subset — before bucketing. Other metrics are
  // per-run and need no pre-pass.
  const effScores =
    metric === "efficiencyScore"
      ? scoreWorkoutsEfficiency(
          workouts.map(toEfficiencyWorkout),
          restingHr,
          maxHr
        )
      : null;

  const buckets = new Map<number, BucketAccum>();

  for (const w of workouts) {
    // In-range = TOTAL distance within [minMiles, maxMiles] inclusive.
    if (w.distanceMiles < minMiles || w.distanceMiles > maxMiles) continue;

    const d = new Date(w.date);
    const t = d.getTime();
    if (!Number.isFinite(t)) continue; // unparseable date → skip
    if (d < start) continue; // outside the trailing window

    const ps = periodStartFor(d, granularity);
    const key = ps.getTime();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { periodStart: ps, weightedSum: 0, weightSum: 0, runCount: 0 };
      buckets.set(key, bucket);
    }
    bucket.runCount += 1;

    const contrib = metricContribution(w, metric, effScores, restingHr, maxHr);
    if (
      contrib != null &&
      Number.isFinite(contrib.value) &&
      Number.isFinite(contrib.weight) &&
      contrib.weight > 0
    ) {
      bucket.weightedSum += contrib.value * contrib.weight;
      bucket.weightSum += contrib.weight;
    }
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime())
    .map((b) => ({
      bucketLabel: labelFor(b.periodStart, granularity),
      bucketStartDate: isoDate(b.periodStart),
      value: b.weightSum > 0 ? b.weightedSum / b.weightSum : null,
      runCount: b.runCount,
    }));
}

/**
 * The individual runs BEHIND one chart bucket — the drill-down counterpart to
 * buildRunAnalysisTrend's aggregate.
 *
 * Membership is the SAME predicate buildRunAnalysisTrend uses to increment a
 * bucket's `runCount` (distance in [minMiles, maxMiles] inclusive, a parseable
 * date at/after the trailing-window start, and a matching period start), so the
 * returned length always equals that bucket's `runCount`.
 *
 * NB: metric validity is deliberately NOT applied. buildRunAnalysisTrend counts
 * a run in `runCount` even when it contributes no metric value (missing HR, an
 * out-of-[MIN_VALID_PACE, MAX_VALID_PACE] derived pace, a still-building
 * efficiency baseline), and this table shows each run's own raw values — so a
 * run excluded from the AVERAGE still appears here with its actual numbers.
 *
 * `bucketStartDate` is matched as a LOCAL YYYY-MM-DD string via the same isoDate
 * used to mint RunAnalysisPoint.bucketStartDate — NOT by parsing it back into a
 * Date. `new Date("2026-07-13")` parses as UTC midnight while periodStartFor
 * returns LOCAL midnight, so a Date-to-Date comparison would silently match
 * nothing in any timezone west of UTC.
 *
 * Returned in chronological ascending order. `now` mirrors buildRunAnalysisTrend's
 * parameter so the trailing-window anchor is deterministic in tests.
 */
export function runsInBucket(
  workouts: RunAnalysisWorkout[],
  bucketStartDate: string,
  window: TrendWindow,
  minMiles: number,
  maxMiles: number,
  now: Date = new Date()
): RunAnalysisWorkout[] {
  const granularity = granularityForWindow(window);
  const start = windowStartDate(window, now);

  const matched: { w: RunAnalysisWorkout; t: number }[] = [];

  for (const w of workouts) {
    // In-range = TOTAL distance within [minMiles, maxMiles] inclusive.
    if (w.distanceMiles < minMiles || w.distanceMiles > maxMiles) continue;

    const d = new Date(w.date);
    const t = d.getTime();
    if (!Number.isFinite(t)) continue; // unparseable date → skip
    if (d < start) continue; // outside the trailing window

    if (isoDate(periodStartFor(d, granularity)) !== bucketStartDate) continue;

    matched.push({ w, t });
  }

  return matched.sort((a, b) => a.t - b.t).map((m) => m.w);
}
