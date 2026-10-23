import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { RaceEvidenceStatus, RacePerformanceEvidence } from "@/types/racePerformance";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { isPerformanceDate, isPerformanceInstant, performanceLocalDate } from "@/utils/performanceEvidence";
import { predictRaceTime } from "@/utils/racePrediction";
import { buildRaceEvidence, DEFAULT_RACE_PERFORMANCE_POLICY, researchRiegelSeconds, researchVdotSeconds } from "@/utils/racePerformance";
import { selectEffectiveWorkouts } from "@/utils/selectActiveWorkouts";

export type RaceResearchMethod = "recent_same_distance" | "riegel_fixed_1_06" | "vdot_style" | "legacy_summary_only";
export interface RaceEvaluationCase {
  targetRaceId: string;
  targetRaceDate: string;
  targetStatus: RaceEvidenceStatus;
  actualSeconds: number;
  cutoff: string;
  method: RaceResearchMethod;
  sourceRaceId: string | null;
  sourceStatus: RaceEvidenceStatus | null;
  sourceAgeDays: number | null;
  eligiblePriorRaces: number;
  predictedSeconds: number | null;
  /** Positive = predicted too slow; negative = predicted too fast. */
  signedErrorSeconds: number | null;
  absoluteErrorSeconds: number | null;
  largeError: boolean | null;
  abstentionReason: string | null;
}
export interface RaceEvaluationMetrics {
  attempts: number;
  predictions: number;
  abstentions: number;
  abstentionRate: number | null;
  meanAbsoluteErrorSeconds: number | null;
  meanSignedErrorSeconds: number | null;
  largeErrors: number;
}
export interface RacePerformanceEvaluationReport {
  version: "phase3a-chronological-research-v1";
  asOf: string;
  timeZone: string;
  researchOnly: true;
  inputRaceCount: number;
  inputWorkoutCount: number;
  eligibleOutcomeCount: number;
  evidenceStatusCounts: Record<RaceEvidenceStatus, number>;
  excludedOutcomes: { raceId: string; status: RaceEvidenceStatus; reasons: readonly string[] }[];
  largeErrorThresholdSeconds: number;
  methods: Record<RaceResearchMethod, RaceEvaluationMetrics>;
  cases: RaceEvaluationCase[];
  raceAgeSensitivity: { age: "0–90 days" | "91–180 days" | "over 180 days"; methods: Record<RaceResearchMethod, RaceEvaluationMetrics> }[];
  verificationSensitivity: { mode: "verified_only" | "verified_and_owner_confirmed"; methods: Record<RaceResearchMethod, RaceEvaluationMetrics> }[];
  limitations: string[];
  calibrationRequirements: string[];
}

const METHODS: RaceResearchMethod[] = ["recent_same_distance", "riegel_fixed_1_06", "vdot_style", "legacy_summary_only"];

/** Last instant before the target's local date, including DST and extreme offsets. */
export function raceEvaluationCutoff(raceDate: string, timeZone: string): string {
  if (!isPerformanceDate(raceDate)) throw new TypeError("Invalid evaluation race date");
  const nominal = Date.parse(`${raceDate}T00:00:00.000Z`);
  let low = nominal - 36 * 3_600_000;
  let high = nominal + 36 * 3_600_000;
  // Local date keys are monotonic over this interval. Find the first instant
  // whose local date is the race date, then stop one millisecond before it.
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (performanceLocalDate(new Date(middle).toISOString(), timeZone) < raceDate) low = middle;
    else high = middle;
  }
  return new Date(high - 1).toISOString();
}

function metrics(cases: RaceEvaluationCase[]): RaceEvaluationMetrics {
  const predicted = cases.filter((item) => item.predictedSeconds !== null);
  return {
    attempts: cases.length, predictions: predicted.length, abstentions: cases.length - predicted.length,
    abstentionRate: cases.length ? (cases.length - predicted.length) / cases.length : null,
    meanAbsoluteErrorSeconds: predicted.length ? predicted.reduce((sum, item) => sum + item.absoluteErrorSeconds!, 0) / predicted.length : null,
    meanSignedErrorSeconds: predicted.length ? predicted.reduce((sum, item) => sum + item.signedErrorSeconds!, 0) / predicted.length : null,
    largeErrors: predicted.filter((item) => item.largeError).length,
  };
}

function methodMetrics(cases: RaceEvaluationCase[]): Record<RaceResearchMethod, RaceEvaluationMetrics> {
  return Object.fromEntries(METHODS.map((method) => [method, metrics(cases.filter((item) => item.method === method))])) as Record<RaceResearchMethod, RaceEvaluationMetrics>;
}

/**
 * Offline-only chronological comparison. Outcome labels may be confirmed later;
 * every predictor input must be known before the target's local race day.
 * Current parent revisions with missing/later availability are not backdated.
 */
export function evaluateRacePerformanceHistory(input: {
  races: readonly Race[];
  workouts: readonly HealthWorkout[];
  overrides?: Record<string, WorkoutOverride> | null;
  asOf: string;
  timeZone: string;
  largeErrorThresholdSeconds?: number;
}): RacePerformanceEvaluationReport {
  if (!isPerformanceInstant(input.asOf)) throw new TypeError("Invalid research as-of instant");
  const threshold = input.largeErrorThresholdSeconds ?? 300;
  if (!Number.isFinite(threshold) || threshold <= 0) throw new TypeError("Large-error threshold must be positive");
  const current = buildRaceEvidence({ ...input, asOfMode: "current" });
  const statusCounts: Record<RaceEvidenceStatus, number> = { verified: 0, owner_confirmed: 0, recorded_unverified: 0, inconsistent: 0, insufficient_evidence: 0 };
  current.forEach((evidence) => statusCounts[evidence.status]++);
  const outcomes = current.filter((evidence) => evidence.eligibleForEquivalence && evidence.finishSeconds !== null && evidence.distanceMeters !== null);
  const excludedOutcomes = current.filter((evidence) => !outcomes.includes(evidence)).map((evidence) => ({ raceId: evidence.raceId, status: evidence.status, reasons: evidence.reasons }));
  const cases: RaceEvaluationCase[] = [];
  const limitations = new Set<string>([
    "All outputs are research comparators, not current-capability estimates or race-day forecasts.",
    "No personalized prediction interval, fit-R² confidence, or forecast validation is established by this report.",
    "A held-out target may use only confirmed prior race revisions known before its local race day. Later corrections and unknown revision times cannot be reconstructed.",
    "Legacy comparison uses only completed parent summaries with known availability and canonical overrides; it excludes GPS/HR children, best-effort segments, synthetic planned workouts, and future consistency credits. It is not a reproduction of the full legacy live projection.",
    "The five-minute large-error threshold is a reporting choice, not a calibrated uncertainty bound.",
    "Distance-equivalence comparisons use the latest qualifying different-distance maximal performance; they do not fit an individualized distance exponent.",
    "Unknown history coverage and excluded unverified outcomes can cause selection bias. Age and verification slices describe this sample only.",
  ]);

  function predictCase(target: RacePerformanceEvidence, method: RaceResearchMethod, verifiedOnly: boolean): RaceEvaluationCase {
    const cutoff = raceEvaluationCutoff(target.raceDate, input.timeZone);
    const historical = buildRaceEvidence({ ...input, asOf: cutoff, asOfMode: "historical", targetDistanceMeters: target.distanceMeters! });
    const eligible = historical.filter((evidence) => evidence.raceDate < target.raceDate && evidence.eligibleForEquivalence
      && (!verifiedOnly || evidence.status === "verified"));
    const candidates = method === "recent_same_distance"
      ? eligible.filter((evidence) => evidence.eligibleSameDistanceBenchmark)
      : eligible.filter((evidence) => evidence.distanceMeters !== null
        && Math.abs(evidence.distanceMeters - target.distanceMeters!) > DEFAULT_RACE_PERFORMANCE_POLICY.sameDistanceToleranceMeters);
    const source = [...candidates].sort((a, b) => b.raceDate.localeCompare(a.raceDate) || a.raceId.localeCompare(b.raceId))[0] ?? null;
    let predictedSeconds: number | null = null;
    if (method === "recent_same_distance") predictedSeconds = source?.finishSeconds ?? null;
    if (method === "riegel_fixed_1_06" && source) predictedSeconds = researchRiegelSeconds(source.finishSeconds!, source.distanceMeters!, target.distanceMeters!);
    if (method === "vdot_style" && source) predictedSeconds = researchVdotSeconds(source.finishSeconds!, source.distanceMeters!, target.distanceMeters!);
    if (method === "legacy_summary_only") {
      const known = input.workouts.filter((workout) => {
        const availableAt = workout.syncedAt?.getTime();
        const override = input.overrides?.[workout.workoutId];
        return Number.isFinite(availableAt) && availableAt! <= Date.parse(cutoff)
          && Number.isFinite(workout.endDate?.getTime()) && workout.endDate.getTime() <= Date.parse(cutoff)
          && (!override || (isPerformanceInstant(override.updatedAt) && Date.parse(override.updatedAt) <= Date.parse(cutoff)));
      });
      const effective = selectEffectiveWorkouts([...known], input.overrides).filter((workout) => workout.isRunLike);
      // Exact repeated parent IDs collapse. Conflicting revisions cannot be
      // reproduced safely, so withhold them instead of choosing the last one.
      const grouped = new Map<string, HealthWorkout[]>();
      effective.forEach((workout) => grouped.set(workout.workoutId, [...(grouped.get(workout.workoutId) ?? []), workout]));
      const key = (workout: HealthWorkout) => JSON.stringify([
        workout.startDate.getTime(), workout.endDate.getTime(), workout.distanceMiles, workout.durationSeconds, workout.activityType,
      ]);
      const seen = new Set<string>();
      const runs = [...grouped.values()].filter((versions) => new Set(versions.map(key)).size === 1)
        .map((versions) => versions[0]).filter((workout) => {
          const signature = key(workout);
          if (seen.has(signature)) return false;
          seen.add(signature);
          return true;
        });
      predictedSeconds = predictRaceTime(runs, {
        raceDistanceMiles: target.distanceMeters! / 1609.344,
        races: eligible.map((evidence) => ({ raceDate: evidence.raceDate, distanceMiles: evidence.distanceMeters! / 1609.344 })),
      }, new Date(cutoff)).predictedSeconds;
    }
    if (predictedSeconds !== null && (!Number.isFinite(predictedSeconds) || predictedSeconds <= 0)) predictedSeconds = null;
    const signed = predictedSeconds === null ? null : predictedSeconds - target.finishSeconds!;
    return {
      targetRaceId: target.raceId, targetRaceDate: target.raceDate, targetStatus: target.status,
      actualSeconds: target.finishSeconds!, cutoff, method,
      sourceRaceId: method === "legacy_summary_only" ? null : source?.raceId ?? null,
      sourceStatus: method === "legacy_summary_only" ? null : source?.status ?? null,
      sourceAgeDays: method === "legacy_summary_only" ? null : source?.ageDays ?? null,
      eligiblePriorRaces: eligible.length, predictedSeconds, signedErrorSeconds: signed,
      absoluteErrorSeconds: signed === null ? null : Math.abs(signed), largeError: signed === null ? null : Math.abs(signed) >= threshold,
      abstentionReason: predictedSeconds !== null ? null : method === "legacy_summary_only" ? "insufficient_reproducible_parent_summaries"
        : source ? "equivalence_outside_supported_range" : "no_eligible_known_prior_race",
    };
  }

  for (const target of outcomes) for (const method of METHODS) cases.push(predictCase(target, method, false));
  const verifiedCases = outcomes.filter((target) => target.status === "verified").flatMap((target) => METHODS.map((method) => predictCase(target, method, true)));
  if (outcomes.length < 3) limitations.add(`Only ${outcomes.length} eligible held-out race outcome(s) are available. This cannot validate a personalized model or uncertainty interval.`);
  if (input.races.length === 0) limitations.add("No race identity/result/verification records were supplied; workout distance alone is not a race outcome label.");
  return {
    version: "phase3a-chronological-research-v1", asOf: input.asOf, timeZone: input.timeZone, researchOnly: true,
    inputRaceCount: input.races.length, inputWorkoutCount: input.workouts.length, eligibleOutcomeCount: outcomes.length,
    evidenceStatusCounts: statusCounts, excludedOutcomes, largeErrorThresholdSeconds: threshold,
    methods: methodMetrics(cases), cases,
    raceAgeSensitivity: [
      { age: "0–90 days", methods: methodMetrics(cases.filter((item) => item.sourceAgeDays !== null && item.sourceAgeDays <= 90)) },
      { age: "91–180 days", methods: methodMetrics(cases.filter((item) => item.sourceAgeDays !== null && item.sourceAgeDays > 90 && item.sourceAgeDays <= 180)) },
      { age: "over 180 days", methods: methodMetrics(cases.filter((item) => item.sourceAgeDays !== null && item.sourceAgeDays > 180)) },
    ],
    verificationSensitivity: [
      { mode: "verified_only", methods: methodMetrics(verifiedCases) },
      { mode: "verified_and_owner_confirmed", methods: methodMetrics(cases) },
    ],
    limitations: [...limitations].sort(),
    calibrationRequirements: [
      "Reconcile official chip/elapsed timing, nominal distance, date, linkage, maximal effort, conditions, and provenance for each candidate outcome; record when each exact evidence revision became known.",
      "Preserve dated parent-summary and override revisions or pre-race snapshots to reconstruct only information actually available at each target cutoff.",
      "Accumulate multiple independent held-out half-marathon outcomes across race ages and conditions, with qualifying different-distance maximal efforts where available; report the number of evaluable pairs and abstentions.",
      "Pre-register eligibility, freshness, comparison methods, error tolerances and calibration splits. Compare race-only methods with training-context additions on untouched later outcomes; require repeatable incremental accuracy before numerical current-capability estimates.",
      "Validate race-day forecasting and uncertainty coverage separately with pre-race snapshots at useful forecast horizons. Mileage, adherence and future planned runs cannot supply assumed improvement credits.",
    ],
  };
}
