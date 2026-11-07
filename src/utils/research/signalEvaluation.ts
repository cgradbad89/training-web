/**
 * Phase 3M — RESEARCH-ONLY offline evaluation harness for prediction-evidence
 * candidates. Never imported by live code (test-enforced), never configures or
 * alters the production estimator, and selects no winner.
 *
 * It keeps two questions apart:
 *   1. AVAILABILITY — at an explicit as-of instant, with data truncated to what
 *      was knowable then, does each candidate have enough evidence to produce a
 *      value, and what are its sample sizes? (`evaluateSignalsAsOf`)
 *   2. ACCURACY — scored against independent, qualified, LATER race outcomes.
 *      (`scoreAgainstOutcomes`) Until enough independent outcomes exist it reports
 *      `NOT EVALUABLE` and returns no ranking and no error statistics.
 *
 * Candidates: the frozen v2 baseline (the only one that yields a finish time),
 * comparable-effort pace evidence, same-route efficiency trend, stored HR-drift
 * trend, and the VO₂ 28-day median. The last three are DESCRIPTIVE levels/trends:
 * no transform to a race time is defined or implied, so their accuracy is
 * reported as "no prediction transform defined", never as zero error.
 *
 * Leakage control (each tested): workouts that ended after the instant are removed;
 * weather fetched after the instant is treated as absent (the gate's own rule);
 * VO₂ readings after the local date are removed; outcomes must be strictly later
 * than the as-of instant to be used for scoring; appending future data changes nothing.
 */
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { buildComparableEffortFunnel } from "../comparableEffortFunnel";
import { estimateCurrentHalfMarathon } from "../experimentalCurrentPerformance";
import { performanceLocalDate } from "../performanceEvidence";
import { buildVo2TrendSeries, median, theilSenSlopePer28d } from "../vo2Trend";
import type { Vo2Entry } from "../vo2History";
import { assessStoredHrDrift } from "./hrDriftAudit";

export const MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY = 5;

export type CandidateId = "v2-baseline" | "comparable-effort" | "same-route-efficiency" | "hr-drift-trend" | "vo2-28d-median";
export interface CandidateAvailability {
  id: CandidateId;
  status: "available" | "insufficient";
  /** Why the candidate has no value (or "ok"). */
  reason: string;
  sample: Record<string, number>;
  /** v2-baseline: predicted finish SECONDS. Others: a descriptive level/trend (unit in `unit`). */
  value: number | null;
  unit: "seconds" | "pct_per_28d" | "pct_per_28d_drift" | "ml_kg_min" | null;
  producesFinishTime: boolean;
}

export interface SignalEvaluationInput {
  asOf: string;
  timeZone: string;
  races: readonly Race[];
  workouts: readonly HealthWorkout[];
  overrides?: Record<string, WorkoutOverride>;
  vo2: readonly Vo2Entry[];
}

export interface SignalEvaluationRow {
  asOf: string;
  leakageExcluded: { workouts: number; weatherFetchedAfter: number; vo2: number };
  candidates: CandidateAvailability[];
}

const DAY = 86_400_000;

function theilSen(points: readonly { x: number; y: number }[]): number | null {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j].x - points[i].x;
      if (dx > 0) slopes.push((points[j].y - points[i].y) / dx);
    }
  }
  return median(slopes);
}

export function evaluateSignalsAsOf(input: SignalEvaluationInput): SignalEvaluationRow {
  const cutoff = Date.parse(input.asOf);
  if (!Number.isFinite(cutoff)) throw new TypeError("asOf must be an ISO instant");
  const localDay = performanceLocalDate(input.asOf, input.timeZone);

  let weatherFetchedAfter = 0;
  const known = input.workouts
    .filter((w) => w.endDate.getTime() <= cutoff)
    .map((w) => {
      if (w.weather && !(Date.parse(w.weather.fetchedAt) <= cutoff)) {
        weatherFetchedAfter += 1;
        return { ...w, weather: null };
      }
      return w;
    });
  const vo2Known = input.vo2.filter((e) => e.date <= localDay);
  const leakageExcluded = {
    workouts: input.workouts.length - known.length,
    weatherFetchedAfter,
    vo2: input.vo2.length - vo2Known.length,
  };
  const base = { races: input.races, workouts: known, overrides: input.overrides ?? {}, asOf: input.asOf, timeZone: input.timeZone };
  const candidates: CandidateAvailability[] = [];

  // 1. Frozen v2 baseline — the only candidate with a finish time.
  const estimate = estimateCurrentHalfMarathon(base);
  candidates.push({
    id: "v2-baseline", producesFinishTime: true, unit: "seconds",
    status: estimate.finishMinutes === null ? "insufficient" : "available",
    reason: estimate.finishMinutes === null ? estimate.reason : "ok",
    sample: { matchedPairs: estimate.diagnostics.matchedPairs },
    value: estimate.finishMinutes === null ? null : estimate.finishMinutes * 60,
  });

  // 2. Comparable-effort evidence (already inside v2; reported as availability only).
  const funnel = buildComparableEffortFunnel(base);
  candidates.push({
    id: "comparable-effort", producesFinishTime: false, unit: null,
    status: funnel.paceWeight > 0 ? "available" : "insufficient",
    reason: funnel.paceWeight > 0 ? "ok" : funnel.verdict,
    sample: { matchedPairs: funnel.matchedPairs, matchedWeeks: funnel.matchedWeeks, effectivePairs: Math.round(funnel.effectivePairs * 100) / 100 },
    value: null,
  });

  // 3. Same-route efficiency trend: EF = speed/HR within clusters of ≥3 steady runs over ≥14 days (90-day window).
  const windowStart = cutoff - 90 * DAY;
  // Race efforts and labelled hard sessions are not steady training: excluded.
  const raceRuns = new Set(input.races.flatMap((r) => (r.actualRunId ? [r.actualRunId] : [])));
  const steady = known.filter((w) => w.isRunLike && !raceRuns.has(w.workoutId)
    && !/treadmill|indoor|tempo|interval|race|fartlek|hill repeat/i.test(w.displayType ?? "") && w.routeClusterId
    && w.startDate.getTime() >= windowStart && w.avgHeartRate && w.avgHeartRate > 40 && w.avgPaceSecPerMile && w.avgPaceSecPerMile > 0
    && w.durationSeconds >= 20 * 60);
  const clusters = new Map<string, HealthWorkout[]>();
  for (const w of steady) clusters.set(w.routeClusterId!, [...(clusters.get(w.routeClusterId!) ?? []), w]);
  const clusterSlopes: number[] = [];
  let clusterRuns = 0;
  for (const runs of clusters.values()) {
    const times = runs.map((r) => r.startDate.getTime());
    if (runs.length < 3 || Math.max(...times) - Math.min(...times) < 14 * DAY) continue;
    clusterRuns += runs.length;
    const efs = runs.map((r) => ({ x: r.startDate.getTime() / DAY, y: (3600 / r.avgPaceSecPerMile!) / r.avgHeartRate! }));
    const meanEf = efs.reduce((s, p) => s + p.y, 0) / efs.length;
    const slope = theilSen(efs);
    if (slope !== null && meanEf > 0) clusterSlopes.push(((slope * 28) / meanEf) * 100);
  }
  candidates.push({
    id: "same-route-efficiency", producesFinishTime: false, unit: "pct_per_28d",
    status: clusterSlopes.length >= 1 ? "available" : "insufficient",
    reason: clusterSlopes.length >= 1 ? "ok" : "No route cluster has ≥3 steady runs spanning ≥14 days in the last 90 days.",
    sample: { qualifyingClusters: clusterSlopes.length, runsInQualifyingClusters: clusterRuns, steadyRoutedRuns: steady.length },
    value: median(clusterSlopes),
  });

  // 4. Stored HR-drift trend: usable values from runs ≥40 min (limits warm-up dominance), 90-day window.
  const drift = known
    .filter((w) => w.isRunLike && w.startDate.getTime() >= windowStart && w.durationSeconds >= 2400 && assessStoredHrDrift(w).usable)
    .map((w) => ({ x: w.startDate.getTime() / DAY, y: w.hrDriftPct as number }));
  const driftSpan = drift.length ? Math.max(...drift.map((p) => p.x)) - Math.min(...drift.map((p) => p.x)) : 0;
  const driftOk = drift.length >= 6 && driftSpan >= 28;
  candidates.push({
    id: "hr-drift-trend", producesFinishTime: false, unit: "pct_per_28d_drift",
    status: driftOk ? "available" : "insufficient",
    reason: driftOk ? "ok" : "Needs ≥6 usable drift values from ≥40-minute runs spanning ≥28 days.",
    sample: { usableDriftRuns: drift.length, spanDays: Math.round(driftSpan) },
    value: driftOk ? (theilSen(drift) ?? 0) * 28 : null,
  });

  // 5. VO₂ 28-day median (device estimate; descriptive).
  const series = buildVo2TrendSeries(vo2Known, { asOf: localDay });
  const latest = series.points[series.points.length - 1];
  const fresh = !!latest && (Date.parse(localDay) - Date.parse(latest.date)) / DAY <= 30;
  const ok = latest?.median28 != null && fresh;
  candidates.push({
    id: "vo2-28d-median", producesFinishTime: false, unit: "ml_kg_min",
    status: ok ? "available" : "insufficient",
    reason: ok ? "ok" : !latest ? "No VO₂ readings known at the instant." : !fresh ? "Latest VO₂ reading is older than 30 days." : "Fewer than 3 readings in the trailing 28 days.",
    sample: { readingsInWindow: latest?.readingsInWindow ?? 0, readingsKnown: series.points.length,
      slopeAvailable: theilSenSlopePer28d(vo2Known, localDay) === null ? 0 : 1 },
    value: ok ? latest!.median28 : null,
  });

  return { asOf: input.asOf, leakageExcluded, candidates };
}

/* ------------------------------ accuracy ------------------------------ */

export interface QualifiedOutcome {
  raceDate: string; // local date
  finishSeconds: number;
  /** Independent, qualified (maximal effort, independent timing) — see tools/race-validation/outcome.ts. */
  qualified: boolean;
}

export type AccuracyReport =
  | {
      status: "NOT EVALUABLE";
      qualifiedOutcomes: number;
      required: number;
      /** Deliberately absent: no error statistics, no ranking, no winner. */
      reason: string;
    }
  | {
      status: "DESCRIPTIVE ONLY";
      qualifiedOutcomes: number;
      required: number;
      candidates: { id: CandidateId; scoredRows: number; meanAbsoluteErrorSeconds: number | null; signedBiasSeconds: number | null; note: string }[];
      note: string;
    };

/**
 * Chronological scoring. A row is scored only against an outcome strictly later than
 * its as-of local date. With fewer than MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY independent
 * outcomes the result is `NOT EVALUABLE` and carries no statistics. Even above the
 * threshold the report is descriptive: it ranks nothing and claims no improvement.
 */
export function scoreAgainstOutcomes(
  rows: readonly SignalEvaluationRow[],
  outcomes: readonly QualifiedOutcome[],
  timeZone: string
): AccuracyReport {
  const qualified = outcomes.filter((o) => o.qualified && o.finishSeconds > 0);
  const required = MIN_QUALIFIED_OUTCOMES_FOR_ACCURACY;
  if (qualified.length < required) {
    return {
      status: "NOT EVALUABLE", qualifiedOutcomes: qualified.length, required,
      reason: `${qualified.length} independent qualified outcome(s); at least ${required} are required before any error statistic is reported. One outcome supports a sanity check, not model selection.`,
    };
  }
  const errors = new Map<CandidateId, number[]>();
  for (const row of rows) {
    const day = performanceLocalDate(row.asOf, timeZone);
    const target = qualified.filter((o) => o.raceDate > day).sort((a, b) => a.raceDate.localeCompare(b.raceDate))[0];
    if (!target) continue;
    for (const c of row.candidates) {
      if (!c.producesFinishTime || c.value === null) continue;
      errors.set(c.id, [...(errors.get(c.id) ?? []), c.value - target.finishSeconds]);
    }
  }
  const ids = new Set(rows.flatMap((r) => r.candidates.map((c) => c.id)));
  return {
    status: "DESCRIPTIVE ONLY", qualifiedOutcomes: qualified.length, required,
    candidates: [...ids].map((id) => {
      const e = errors.get(id) ?? [];
      const yields = rows.some((r) => r.candidates.find((c) => c.id === id)?.producesFinishTime);
      return {
        id, scoredRows: e.length,
        meanAbsoluteErrorSeconds: e.length ? e.reduce((s, x) => s + Math.abs(x), 0) / e.length : null,
        signedBiasSeconds: e.length ? e.reduce((s, x) => s + x, 0) / e.length : null,
        note: yields ? "Rows share outcomes and are dependent; do not pool into a significance claim."
          : "No prediction transform defined for this candidate; accuracy is not assessed (not zero error).",
      };
    }),
    note: "No ranking or winner is produced. Use tools/race-validation evaluateStudy for custody-checked scoring.",
  };
}

/** Throws if the outcome is not strictly later than the as-of local date. */
export function assertChronological(asOf: string, timeZone: string, outcome: QualifiedOutcome): void {
  if (!(outcome.raceDate > performanceLocalDate(asOf, timeZone))) {
    throw new RangeError("Outcome is not later than the as-of instant: refusing a leaked comparison");
  }
}
