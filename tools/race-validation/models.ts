import type { RacePerformanceEvidence } from "@/types/racePerformance";
import type { WorkoutRaceResearchInput } from "@/types/workoutRaceResearch";
import { CURRENT_HALF_POLICY, estimateCurrentHalfMarathon } from "@/utils/experimentalCurrentPerformance";
import { buildRaceEvidence, DEFAULT_RACE_PERFORMANCE_POLICY, HALF_MARATHON_METERS, researchRiegelSeconds, researchVdotSeconds } from "@/utils/racePerformance";
import { performanceLocalDate } from "@/utils/performanceEvidence";
import { selectResearchRuns } from "@/utils/workoutRaceResearch";
import { compareKeys } from "./evidence";

export const MODEL_VERSIONS = {
  experimental: CURRENT_HALF_POLICY.version,
  same_anchor: "production-anchor-unadjusted-v1",
  same_distance: "latest-qualified-same-distance-v1",
  riegel: "fixed-riegel-1.06-v1",
  vdot: "daniels-gilbert-equivalence-v1",
} as const;
export type Method = keyof typeof MODEL_VERSIONS;
export const METHODS = Object.keys(MODEL_VERSIONS) as Method[];

export interface Prediction {
  seconds: number | null;
  reason: string | null;
  anchor: Pick<RacePerformanceEvidence, "raceId" | "workoutId" | "raceDate" | "status" | "timingBasis" | "finishSeconds" | "distanceMeters" | "effort" | "timingAgreement" | "provenance" | "confirmationRevisionId" | "reasons"> | null;
}

function prediction(seconds: number | null, reason: string, source: RacePerformanceEvidence | null): Prediction {
  return { seconds, reason: seconds === null ? reason : null, anchor: source && {
    raceId: source.raceId, workoutId: source.workoutId, raceDate: source.raceDate,
    status: source.status, timingBasis: source.timingBasis, finishSeconds: source.finishSeconds, distanceMeters: source.distanceMeters,
    effort: source.effort, timingAgreement: source.timingAgreement, provenance: source.provenance,
    confirmationRevisionId: source.confirmationRevisionId ?? null, reasons: source.reasons,
  } };
}

export function runModels(input: WorkoutRaceResearchInput, coverageReasons: string[]) {
  const selection = selectResearchRuns(input);
  const eligibleWorkoutIds = selection.runs.map(run => run.workout.workoutId).sort(compareKeys);
  const predictions = {} as Record<Method, Prediction>;
  if (coverageReasons.length) {
    for (const method of METHODS) predictions[method] = prediction(null, coverageReasons.join("; "), null);
    return { predictions, eligibleWorkoutIds, workoutExclusions: selection.exclusions, attribution: null };
  }

  const estimate = estimateCurrentHalfMarathon(input);
  const available = estimate.finishMinutes !== null;
  predictions.experimental = prediction(available ? estimate.finishMinutes! * 60 : null, estimate.reason, estimate.anchor);
  predictions.same_anchor = prediction(available ? Math.round(estimate.baselineSeconds! / 60) * 60 : null,
    "The exact production estimate abstained; no common-anchor comparison", estimate.anchor);
  const eligible = new Set(eligibleWorkoutIds);
  const qualified = buildRaceEvidence({ ...input, workouts: input.workouts.filter(workout => eligible.has(workout.workoutId)) })
    .filter(race => race.eligibleForEquivalence && race.ageDays !== null && race.ageDays <= CURRENT_HALF_POLICY.maximumAnchorDays)
    .sort((a, b) => compareKeys(b.raceDate, a.raceDate) || compareKeys(a.raceId, b.raceId));
  const same = qualified.find(race => race.eligibleSameDistanceBenchmark) ?? null;
  const different = qualified.find(race => Math.abs(race.distanceMeters! - HALF_MARATHON_METERS) > DEFAULT_RACE_PERFORMANCE_POLICY.sameDistanceToleranceMeters) ?? null;
  predictions.same_distance = prediction(same?.finishSeconds ?? null, "No eligible recent same-distance maximal result", same);
  predictions.riegel = prediction(different ? researchRiegelSeconds(different.finishSeconds!, different.distanceMeters!, HALF_MARATHON_METERS) : null,
    "No eligible different-distance result or Riegel equivalent", different);
  predictions.vdot = prediction(different ? researchVdotSeconds(different.finishSeconds!, different.distanceMeters!, HALF_MARATHON_METERS) : null,
    "No eligible different-distance result or equivalent in the VDOT domain", different);

  // Use exact production contribution seconds. Invert only the shared freshness
  // multiplier where identifiable, holding pair choice, blend and support fixed.
  const day = performanceLocalDate(input.asOf, input.timeZone);
  const raceWorkoutIds = new Set(input.races.map(race => race.actualRunId));
  const latestTraining = selection.runs.findLast(run => !raceWorkoutIds.has(run.workout.workoutId)
    && run.workout.distanceMiles <= 26.3 && run.paceSecondsPerMile >= 180 && run.paceSecondsPerMile <= 1800);
  const age = estimate.anchor?.ageDays ?? null;
  const clampUnit = (value: number) => Math.max(0, Math.min(value, 1));
  const freshness = age !== null && latestTraining
    ? clampUnit((180 - age) / 90) * clampUnit((42 - (Date.parse(day) - Date.parse(latestTraining.date)) / 86_400_000) / 28)
    : null;
  const component = (name: string) => estimate.contributions.find(entry => entry.feature === name)?.seconds ?? 0;
  const adjustment = estimate.adjustmentSeconds;
  const withoutFreshness = freshness !== null && freshness > 0 ? adjustment / freshness : null;
  const attribution = available ? {
    method: estimate.adjustmentMethod,
    anchorSeconds: estimate.baselineSeconds!,
    volumeFrequencySeconds: component("Volume and frequency"),
    enduranceSeconds: component("Endurance preparation"),
    comparablePaceSeconds: component("Comparable-effort pace"),
    combinedSeconds: adjustment,
    roundingSeconds: predictions.experimental.seconds! - estimate.baselineSeconds! - adjustment,
    freshnessMultiplier: freshness,
    fixedInputsAdjustmentWithoutFreshnessSeconds: withoutFreshness,
    freshnessEffectSeconds: withoutFreshness === null ? null : adjustment - withoutFreshness,
    freshnessReason: withoutFreshness === null ? "Unattenuated effect is unidentified from the production output at zero freshness" : null,
    limitations: estimate.gaps,
  } : null;
  return { predictions, eligibleWorkoutIds, workoutExclusions: selection.exclusions, attribution };
}
