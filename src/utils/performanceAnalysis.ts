import type {
  DemonstratedPerformanceRace, PerformanceAnalysisInput, PerformanceAnalysisResult,
  PerformanceSnapshotPayload, PerformanceVersions, WorkoutPerformanceFeature,
} from "@/types/performanceAnalysis";
import { DEFAULT_PERFORMANCE_QUALITY_POLICY, summarizeAerobicPerformance } from "@/utils/aerobicPerformance";
import { summarizeDeviceVo2 } from "@/utils/deviceVo2Trend";
import { summarizeEndurancePreparation } from "@/utils/endurancePreparation";
import {
  buildWorkoutInputDigest, canonicalizePerformanceValue, comparePerformanceKeys, hasVerifiedTelemetry,
  hashPerformanceValue, isPerformanceDate, isPerformanceInstant, performanceLocalDate,
  performanceObservationWindow, selectWorkoutsForManualAnalysis, uniquePerformanceRecords,
  workoutIsCompletedAsOf,
} from "@/utils/performanceEvidence";

export const PERFORMANCE_VERSIONS: PerformanceVersions = Object.freeze({
  schema: 1, model: "manual-performance-v1", extractor: "steady-interval-v1", qualityPolicy: "observational-v1",
});

export const PERFORMANCE_DEFAULTS = Object.freeze({
  observationDays: 180, comparisonDays: 28, longRunDefinitionMeters: 12874.752,
  qualityPolicy: DEFAULT_PERFORMANCE_QUALITY_POLICY,
});

function validateInput(input: PerformanceAnalysisInput): void {
  performanceObservationWindow(input.asOf, input.timeZone, input.observationDays);
  if (!Number.isSafeInteger(input.comparisonDays) || input.comparisonDays < 1 || input.comparisonDays * 2 > input.observationDays) throw new TypeError("Comparison windows must fit observation scope");
  if (!Number.isFinite(input.longRunDefinitionMeters) || input.longRunDefinitionMeters <= 0) throw new TypeError("Invalid long-run definition");
  if (input.versions.schema !== 1 || !input.versions.model || !input.versions.extractor || input.versions.qualityPolicy !== input.qualityPolicy.version) throw new TypeError("Incompatible performance versions");
  if (!isPerformanceDate(input.coverage.window.startDate) || !isPerformanceDate(input.coverage.window.endDate) || input.coverage.window.startDate > input.coverage.window.endDate) throw new TypeError("Invalid coverage window");
  const expected = input.coverage.expectedWorkoutCount;
  if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) throw new TypeError("Invalid coverage count");
  // Catch nonfinite raw/feature evidence before any arithmetic or scientific hash.
  canonicalizePerformanceValue(input);
}

/** Explicit invocation only. No IO, clock defaults, application effects or persistence. */
export async function calculatePerformanceAnalysis(input: PerformanceAnalysisInput): Promise<PerformanceAnalysisResult> {
  validateInput(input);
  // Freeze this explicit invocation's evidence before the first asynchronous digest.
  input = structuredClone(input);
  const observationWindow = performanceObservationWindow(input.asOf, input.timeZone, input.observationDays);
  const inScopeEvidence = (w: PerformanceAnalysisInput["workouts"][number]) => !isPerformanceInstant(w.startedAt)
    || (performanceLocalDate(w.startedAt, input.timeZone) >= observationWindow.startDate && Date.parse(w.startedAt) <= Date.parse(input.asOf));
  const warnings: string[] = [];
  const workoutSet = uniquePerformanceRecords(input.workouts, w => w.workoutId);
  // Extraction time is operational metadata, not a second independent observation.
  const featureSet = uniquePerformanceRecords(input.features.map(feature => ({ ...feature, extractedAt: "" })), f => f.workoutId);
  const workouts = workoutSet.records.filter(w => workoutIsCompletedAsOf(w, input.asOf));
  const scoped = workouts.filter(w => {
    const date = performanceLocalDate(w.startedAt, input.timeZone);
    return date >= observationWindow.startDate && date <= observationWindow.endDate;
  });
  const relevantWorkoutConflicts = workoutSet.conflictingIds.filter(id => input.workouts.some(w => w.workoutId === id && !w.excluded && w.isRun && inScopeEvidence(w)));
  const relevantFeatureConflicts = featureSet.conflictingIds.filter(id => scoped.some(w => w.workoutId === id));
  if (relevantWorkoutConflicts.length) warnings.push(`Conflicting workout evidence excluded: ${relevantWorkoutConflicts.join(", ")}`);
  if (relevantFeatureConflicts.length) warnings.push(`Conflicting feature evidence excluded: ${relevantFeatureConflicts.join(", ")}`);

  const coverage = { ...input.coverage, window: { ...input.coverage.window }, limitations: [...input.coverage.limitations] };
  const incompleteScope = relevantWorkoutConflicts.length > 0 || input.workouts.some(w => !w.excluded && w.isRun && !workoutIsCompletedAsOf(w, input.asOf) && inScopeEvidence(w));
  if (coverage.workouts === "complete" && (incompleteScope || (coverage.expectedWorkoutCount !== null && coverage.expectedWorkoutCount !== scoped.length))) {
    coverage.workouts = "partial";
    coverage.limitations.push("Incomplete, conflicting, unavailable or missing workout summaries prevent complete scope coverage.");
  }
  const races = uniquePerformanceRecords(input.linkedRaces.filter(r => isPerformanceDate(r.raceDate)
    && r.raceDate <= observationWindow.endDate && workouts.some(w => w.workoutId === r.workoutId)), r => r.raceId);
  if (races.conflictingIds.length) warnings.push("Conflicting race links omitted.");
  const demonstratedRaces: DemonstratedPerformanceRace[] = [];
  for (const race of races.records) {
    const workout = workouts.find(w => w.workoutId === race.workoutId);
    if (!workout || !isPerformanceDate(race.raceDate) || race.raceDate > observationWindow.endDate || !Number.isFinite(race.nominalDistanceMeters) || race.nominalDistanceMeters <= 0) continue;
    if (performanceLocalDate(workout.startedAt, input.timeZone) !== race.raceDate) {
      warnings.push(`Race ${race.raceId} date does not match linked workout; benchmark unresolved.`);
      continue;
    }
    const elapsedSeconds = (Date.parse(workout.endedAt) - Date.parse(workout.startedAt)) / 1000;
    const tolerance = Math.max(60, workout.durationSeconds! * 0.02);
    const copied = race.copiedDurationSeconds;
    const discrepant = Math.abs(elapsedSeconds - workout.durationSeconds!) > tolerance || (copied !== null && (!Number.isFinite(copied) || copied <= 0 || Math.abs(copied - workout.durationSeconds!) > 1));
    demonstratedRaces.push({
      ...race, provenance: { ...race.provenance, notes: [...race.provenance.notes] },
      recordedDistanceMeters: workout.distanceMeters!, durationSeconds: workout.durationSeconds!, elapsedSeconds,
      timingBasis: "effective_workout_duration", officialChipTimeVerified: false,
      timingAgreement: discrepant ? "discrepant" : copied === null ? "unknown" : "agrees",
      limitations: [...race.limitations, ...workout.limitations,
        "Workout-linked duration is not verified official chip time; GPS overdistance is not normalized.",
        ...(discrepant ? ["Workout elapsed time or copied race timing disagrees with effective duration."] : [])],
    });
  }
  demonstratedRaces.sort((a, b) => comparePerformanceKeys(a.raceDate, b.raceDate) || comparePerformanceKeys(a.raceId, b.raceId));
  // Every explicit race link is excluded from aerobic cohorts, including unresolved timing links.
  const excludedWorkoutIds = new Set(input.linkedRaces.filter(r => isPerformanceDate(r.raceDate) && r.raceDate <= observationWindow.endDate).map(r => r.workoutId));
  const acceptedFeatures: WorkoutPerformanceFeature[] = [];
  const qualityPolicyDigest = await hashPerformanceValue(input.qualityPolicy);
  const unresolved = new Set([...relevantWorkoutConflicts, ...relevantFeatureConflicts,
    ...input.workouts.filter(w => !w.excluded && w.isRun && !workoutIsCompletedAsOf(w, input.asOf) && inScopeEvidence(w)).map(w => w.workoutId)]);
  const rejected = new Set<string>();
  for (const workout of scoped) {
    const compact = featureSet.records.find(f => f.workoutId === workout.workoutId);
    if (!compact || !hasVerifiedTelemetry(workout)
      || compact.parentDigest !== workout.parentDigest || compact.sourceInputDigest !== await buildWorkoutInputDigest(workout)
      || compact.telemetryDigest !== workout.telemetry.contentDigest || compact.extractorVersion !== input.versions.extractor
      || compact.qualityPolicyVersion !== input.versions.qualityPolicy || compact.completion !== "completed"
      || compact.qualityPolicyDigest !== qualityPolicyDigest
      || compact.observedAt !== workout.startedAt || compact.telemetryState !== workout.telemetry.state) {
      unresolved.add(workout.workoutId);
      continue;
    }
    const feature = { ...compact };
    if (feature.status === "accepted" && feature.telemetryState === "complete") acceptedFeatures.push(feature);
    else if (feature.status === "rejected") rejected.add(workout.workoutId);
    else unresolved.add(workout.workoutId);
  }
  if (unresolved.size && coverage.telemetry === "complete") coverage.telemetry = "partial";
  const normalized = { ...input, workouts: scoped, coverage };
  const aerobic = summarizeAerobicPerformance({ features: acceptedFeatures, excludedWorkoutIds, asOf: input.asOf, timeZone: input.timeZone, comparisonDays: input.comparisonDays, policy: input.qualityPolicy });
  const deviceVo2 = summarizeDeviceVo2(normalized);
  const preparation = summarizeEndurancePreparation(normalized);
  const limitations = [
    "Descriptive quality thresholds are engineering policies, not validated physiological constants.",
    "Observed HR/speed changes, device VO₂ estimates and preparation do not establish a numerical current race capability.",
    "Device VO₂ may share pace/HR inputs and is not independent race validation or VDOT.",
    "No iOS child-data revisions are assumed; verified supplied content describes a dated extraction only.",
    ...(workouts.some(w => w.availableAt === null && (scoped.includes(w) || demonstratedRaces.some(r => r.workoutId === w.workoutId))) ? ["Some original availability dates are unknown; old as-of analyses cannot prove what was known then."] : []),
  ];
  const content = {
    versions: { ...input.versions }, asOf: input.asOf, timeZone: input.timeZone, observationWindow,
    demonstratedRaces, aerobic, deviceVo2, preparation,
    capability: { distance: "half_marathon" as const, status: "unavailable" as const, estimatedSeconds: null, confidenceInterval: null, reason: "no_validated_estimator" as const },
    completeness: { coverage, effectiveWorkoutCount: scoped.length, acceptedFeatureCount: acceptedFeatures.length,
      unresolvedWorkoutIds: [...unresolved].sort(), rejectedWorkoutIds: [...rejected].sort() },
    warnings: [...new Set(warnings)].sort(), limitations,
  };
  // Include evidence membership/revisions and policy even when rounded summary medians do not move.
  const evidenceDigest = await hashPerformanceValue({
    content, qualityPolicy: input.qualityPolicy, parameters: { observationDays: input.observationDays, comparisonDays: input.comparisonDays, longRunDefinitionMeters: input.longRunDefinitionMeters },
    workouts: workoutSet.records.filter(w => w.isRun && inScopeEvidence(w)), races: demonstratedRaces,
    features: featureSet.records.filter(f => scoped.some(w => w.workoutId === f.workoutId)), deviceVo2: deviceVo2.measurements,
    conflictingWorkoutIds: relevantWorkoutConflicts,
  });
  return { ...content, evidenceDigest };
}

export function shouldAppendPerformanceSnapshot(previous: PerformanceAnalysisResult | null, next: PerformanceAnalysisResult): boolean {
  return previous === null || previous.evidenceDigest !== next.evidenceDigest;
}

export function buildPerformanceSnapshotPayload(input: {
  result: PerformanceAnalysisResult;
  reason: PerformanceSnapshotPayload["reason"];
  calculationStartedAt: string;
  calculationCompletedAt: string;
  provenance: PerformanceSnapshotPayload["provenance"];
}): PerformanceSnapshotPayload {
  if (!isPerformanceInstant(input.result.asOf) || !isPerformanceInstant(input.calculationStartedAt) || !isPerformanceInstant(input.calculationCompletedAt)
    || Date.parse(input.calculationCompletedAt) < Date.parse(input.calculationStartedAt)
    || Date.parse(input.result.asOf) > Date.parse(input.calculationStartedAt)) throw new TypeError("Invalid explicit calculation timestamps");
  const reconstructed = input.reason === "historical_reconstruction"
    || Date.parse(input.result.asOf) < Date.parse(input.calculationStartedAt);
  return {
    result: structuredClone(input.result), evidenceDigest: input.result.evidenceDigest, versions: { ...input.result.versions },
    reason: reconstructed ? "historical_reconstruction" : input.reason,
    historyBasis: reconstructed ? "reconstruction_current_metadata" : "actual_calculation",
    calculationStartedAt: input.calculationStartedAt, calculationCompletedAt: input.calculationCompletedAt,
    evidenceAsOf: input.result.asOf, provenance: structuredClone(input.provenance), coverage: structuredClone(input.result.completeness.coverage),
  };
}

export { selectWorkoutsForManualAnalysis };
