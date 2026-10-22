import type {
  AerobicPerformanceIndicators,
  EffectivePerformanceWorkout,
  PerformanceQualityPolicy,
  PerformanceTelemetryInterval,
  PerformanceVersions,
  SteadyObservation,
  WorkoutPerformanceFeature,
} from "@/types/performanceAnalysis";
import {
  buildWorkoutInputDigest,
  canonicalizePerformanceValue,
  comparePerformanceKeys,
  hashPerformanceValue,
  isPerformanceInstant,
  performanceComparisonWindows,
  performanceLocalDate,
} from "./performanceEvidence";

/** Descriptive engineering screens, not validated physiological constants.
 * Input intervals are transient position/time-derived measurements, never parent averages.
 * observational-v1 also checks elapsed/duration within max(60s, 2%) and distance ±10%.
 */
export const DEFAULT_PERFORMANCE_QUALITY_POLICY: Readonly<PerformanceQualityPolicy> = Object.freeze({
  version: "observational-v1",
  minimumSourceSamples: 100,
  minimumWorkoutSeconds: 1200,
  minimumWorkoutMeters: 3218.688,
  maximumIntervalSeconds: 10,
  maximumSpeedMps: 7,
  minimumCoverageFraction: 0.9,
  minimumHrCoverageFraction: 0.9,
  minimumHrBpm: 60,
  maximumHrBpmExclusive: 210,
  warmupSeconds: 600,
  windowSeconds: 600,
  minimumMinuteSeconds: 54,
  minimumRunningFraction: 0.95,
  minimumRunningSpeedMps: 1.3,
  maximumRunningSpeedMps: 5.5,
  maximumMinuteSpeedCV: 0.12,
  maximumMinuteHrSdBpm: 6,
  maximumWindowHrDriftBpm: 8,
  maximumAscentMetersPerKm: 15,
  maximumTemperatureF: 80,
  maximumDewPointF: 70,
  maximumWindMph: 15,
  hrBandWidthBpm: 5,
  minimumIndependentWorkouts: 3,
});

// Operational bounds keep malformed inputs from creating unbounded allocations/work.
// Exceeding them means unsupported evidence requiring review, not poor physiology.
const MAX_TELEMETRY_INTERVALS = 100_000;
const MAX_SOURCE_SAMPLES = 1_000_000;
const MAX_WORKOUT_SECONDS = 86_400;
const MAX_OBSERVATIONS_PER_WORKOUT = 30;

const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);
const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const standardDeviation = (values: readonly number[]): number => {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
};

function validatePolicy(policy: PerformanceQualityPolicy): void {
  for (const name of Object.keys(DEFAULT_PERFORMANCE_QUALITY_POLICY) as (keyof PerformanceQualityPolicy)[]) {
    const value = policy[name];
    if (name !== "version" && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
      throw new Error(`Invalid performance quality policy: ${name}`);
    }
  }
  if (!policy.version || policy.windowSeconds % 60 !== 0 || policy.windowSeconds < 360 || policy.windowSeconds > 3600 ||
      policy.warmupSeconds > MAX_WORKOUT_SECONDS || policy.minimumWorkoutSeconds > MAX_WORKOUT_SECONDS ||
      policy.minimumWorkoutMeters > MAX_WORKOUT_SECONDS * 100 || policy.maximumIntervalSeconds > MAX_WORKOUT_SECONDS ||
      policy.maximumSpeedMps > 100 || policy.maximumHrBpmExclusive > 300 ||
      policy.minimumHrBpm % 5 !== 0 || policy.maximumHrBpmExclusive % 5 !== 0 ||
      (policy.maximumHrBpmExclusive - policy.minimumHrBpm) / policy.hrBandWidthBpm > MAX_OBSERVATIONS_PER_WORKOUT ||
      !Number.isSafeInteger(policy.minimumSourceSamples) ||
      policy.minimumSourceSamples > MAX_SOURCE_SAMPLES ||
      !Number.isSafeInteger(policy.minimumIndependentWorkouts) ||
      policy.minimumIndependentWorkouts > MAX_SOURCE_SAMPLES ||
      policy.minimumIndependentWorkouts < 3 || policy.hrBandWidthBpm !== 5 ||
      policy.minimumMinuteSeconds > 60 || policy.minimumCoverageFraction > 1 ||
      policy.minimumHrCoverageFraction > 1 || policy.minimumRunningFraction > 1 ||
      policy.minimumHrBpm >= policy.maximumHrBpmExclusive ||
      policy.minimumRunningSpeedMps >= policy.maximumRunningSpeedMps ||
      policy.maximumRunningSpeedMps > policy.maximumSpeedMps) {
    throw new Error("Invalid performance quality policy bounds");
  }
}

function validInstant(instant: string): number {
  const time = Date.parse(instant);
  if (!isPerformanceInstant(instant)) {
    throw new Error("Performance instants must be valid UTC timestamps");
  }
  return time;
}

interface MinuteMeasurement {
  seconds: number;
  hrSeconds: number;
  runningSeconds: number;
  distance: number;
  hrIntegral: number;
}

function summarizeWindow(
  intervals: readonly PerformanceTelemetryInterval[],
  start: number,
  policy: PerformanceQualityPolicy,
): { start: number; end: number; speed: number; hr: number } | null {
  const minutes: MinuteMeasurement[] = Array.from({ length: policy.windowSeconds / 60 }, () => ({
    seconds: 0, hrSeconds: 0, runningSeconds: 0, distance: 0, hrIntegral: 0,
  }));
  for (const interval of intervals) {
    const clippedStart = Math.max(start, interval.startSeconds);
    const clippedEnd = Math.min(start + policy.windowSeconds, interval.endSeconds);
    if (clippedEnd <= clippedStart) continue;
    const firstMinute = Math.floor((clippedStart - start) / 60);
    const lastMinute = Math.min(minutes.length - 1, Math.ceil((clippedEnd - start) / 60) - 1);
    for (let index = firstMinute; index <= lastMinute; index++) {
      const seconds = Math.min(clippedEnd, start + (index + 1) * 60) - Math.max(clippedStart, start + index * 60);
      const minute = minutes[index];
      minute.seconds += seconds;
      minute.distance += seconds * interval.speedMps;
      if (interval.speedMps >= policy.minimumRunningSpeedMps && interval.speedMps <= policy.maximumRunningSpeedMps) {
        minute.runningSeconds += seconds;
      }
      if (finite(interval.hrBpm) && interval.hrBpm >= policy.minimumHrBpm && interval.hrBpm < policy.maximumHrBpmExclusive) {
        minute.hrSeconds += seconds;
        minute.hrIntegral += seconds * interval.hrBpm;
      }
    }
  }
  if (minutes.some((minute) => minute.seconds < policy.minimumMinuteSeconds ||
      minute.hrSeconds / minute.seconds < policy.minimumHrCoverageFraction ||
      minute.runningSeconds / minute.seconds < policy.minimumRunningFraction)) return null;
  const speeds = minutes.map((minute) => minute.distance / minute.seconds);
  const heartRates = minutes.map((minute) => minute.hrIntegral / minute.hrSeconds);
  if (standardDeviation(speeds) / mean(speeds) > policy.maximumMinuteSpeedCV ||
      standardDeviation(heartRates) > policy.maximumMinuteHrSdBpm ||
      Math.abs(mean(heartRates.slice(0, 3)) - mean(heartRates.slice(-3))) > policy.maximumWindowHrDriftBpm) return null;
  const totalSeconds = minutes.reduce((sum, minute) => sum + minute.seconds, 0);
  const totalHrSeconds = minutes.reduce((sum, minute) => sum + minute.hrSeconds, 0);
  return {
    start,
    end: start + policy.windowSeconds,
    speed: minutes.reduce((sum, minute) => sum + minute.distance, 0) / totalSeconds,
    hr: minutes.reduce((sum, minute) => sum + minute.hrIntegral, 0) / totalHrSeconds,
  };
}

export async function extractWorkoutPerformanceFeature(input: {
  workout: EffectivePerformanceWorkout;
  intervals: readonly PerformanceTelemetryInterval[];
  sourceSampleCount: number;
  asOf: string;
  extractedAt: string;
  versions: PerformanceVersions;
  policy: PerformanceQualityPolicy;
}): Promise<WorkoutPerformanceFeature> {
  if (input.intervals.length > MAX_TELEMETRY_INTERVALS) throw new RangeError("Performance telemetry exceeds supported interval count");
  // Capture caller-owned input before the first crypto await. Later caller edits cannot
  // make verified content differ from the measurements reduced for this invocation.
  const workout = structuredClone(input.workout);
  const intervals = input.intervals.map((interval) => ({ ...interval }));
  const sourceSampleCount = input.sourceSampleCount;
  const versions = { ...input.versions };
  const policy = { ...input.policy };
  const extractedAt = input.extractedAt;
  validatePolicy(policy);
  if (versions.qualityPolicy !== policy.version) throw new Error("Quality policy version mismatch");
  const asOf = validInstant(input.asOf);
  validInstant(extractedAt);
  const started = validInstant(workout.startedAt);
  const ended = validInstant(workout.endedAt);
  const reasons: string[] = [];
  const unresolved: string[] = [];
  const limitations = [...workout.limitations, "quality_thresholds_are_descriptive_heuristics", "steady_running_does_not_establish_maximal_effort"];
  if (workout.excluded) reasons.push("workout_excluded");
  if (!workout.isRun) reasons.push("not_running");
  if (workout.runKind !== "outdoor") reasons.push("outdoor_speed_basis_required");
  if (workout.completion !== "completed") unresolved.push("workout_completion_unverified");
  if (ended <= started || ended > asOf || started > asOf) reasons.push("invalid_or_future_workout_time");
  if (workout.availableAt === null) limitations.push("source_availability_time_unknown");
  else if (validInstant(workout.availableAt) > asOf) reasons.push("source_unavailable_as_of");
  if (!finite(workout.durationSeconds) || workout.durationSeconds < policy.minimumWorkoutSeconds) reasons.push("insufficient_workout_duration");
  if (!finite(workout.distanceMeters) || workout.distanceMeters < policy.minimumWorkoutMeters) reasons.push("insufficient_workout_distance");
  const elapsed = (ended - started) / 1000;
  if (elapsed > MAX_WORKOUT_SECONDS || (finite(workout.durationSeconds) && workout.durationSeconds > MAX_WORKOUT_SECONDS)) reasons.push("workout_exceeds_supported_duration");
  if (finite(workout.durationSeconds) && Math.abs(elapsed - workout.durationSeconds) > Math.max(60, workout.durationSeconds * 0.02)) {
    reasons.push("duration_elapsed_discrepancy");
  }
  if (!finite(workout.ascentMeters)) unresolved.push("terrain_measurement_unknown");
  else if (workout.ascentMeters < 0 || (finite(workout.distanceMeters) &&
      workout.ascentMeters / (workout.distanceMeters / 1000) > policy.maximumAscentMetersPerKm)) reasons.push("terrain_screen_failed");
  const environmentValues = [workout.environment.temperatureF, workout.environment.dewPointF, workout.environment.windMph];
  const environmentKnown = environmentValues.every(finite);
  if (!environmentKnown) limitations.push("environment_not_fully_observed");
  if (environmentValues.some((value) => value !== null && !Number.isFinite(value))) reasons.push("invalid_environment_measurement");
  if ((finite(workout.environment.temperatureF) && workout.environment.temperatureF > policy.maximumTemperatureF) ||
      (finite(workout.environment.dewPointF) && workout.environment.dewPointF > policy.maximumDewPointF) ||
      (finite(workout.environment.windMph) && (workout.environment.windMph < 0 || workout.environment.windMph > policy.maximumWindMph))) reasons.push("known_extreme_environment");
  if (workout.telemetry.state === "absent" && workout.telemetry.verification === "supplied_content" && workout.telemetry.contentDigest) {
    reasons.push("telemetry_verified_absent");
  } else if (workout.telemetry.state !== "complete" || workout.telemetry.verification !== "supplied_content" || !workout.telemetry.contentDigest) {
    unresolved.push(workout.telemetry.state === "absent" ? "telemetry_absence_unverified" : "telemetry_completeness_unverified");
  }
  if (!Number.isSafeInteger(sourceSampleCount) || sourceSampleCount < 0 || sourceSampleCount > MAX_SOURCE_SAMPLES || sourceSampleCount < intervals.length || sourceSampleCount < policy.minimumSourceSamples) {
    reasons.push("insufficient_or_invalid_source_samples");
  }
  // Reject malformed samples before hashing; canonical hashing deliberately cannot encode NaN.
  const invalidMeasurement = intervals.some((interval) => !Number.isFinite(interval.startSeconds) ||
    !Number.isFinite(interval.endSeconds) || !Number.isFinite(interval.speedMps) ||
    (interval.hrBpm !== null && !Number.isFinite(interval.hrBpm)));
  const invalidSampleCount = !Number.isSafeInteger(sourceSampleCount) || sourceSampleCount < 0 || sourceSampleCount > MAX_SOURCE_SAMPLES;
  if (invalidMeasurement) reasons.push("invalid_interval_measurement");
  if (!invalidMeasurement && !invalidSampleCount) {
    // Receipts identify exact supplied order. A reordered stream needs its own receipt;
    // sorting a copy below only makes measurement reduction chronological and nonmutating.
    const suppliedDigest = await hashPerformanceValue({ intervals, sourceSampleCount });
    if (workout.telemetry.contentDigest && workout.telemetry.contentDigest !== suppliedDigest) unresolved.push("telemetry_content_digest_mismatch");
  }
  const ordered = [...intervals].sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
  const structuralFailure = ordered.some((interval, index) =>
    !Number.isFinite(interval.startSeconds) || !Number.isFinite(interval.endSeconds) ||
    interval.startSeconds < 0 || interval.endSeconds <= interval.startSeconds || interval.endSeconds > elapsed ||
    (index > 0 && interval.startSeconds < ordered[index - 1].endSeconds));
  if (structuralFailure) reasons.push("invalid_or_overlapping_intervals");
  const measurementsEvaluable = !structuralFailure && !invalidMeasurement;
  const accepted = !measurementsEvaluable ? [] : ordered.filter((interval) =>
    interval.endSeconds - interval.startSeconds <= policy.maximumIntervalSeconds &&
    Number.isFinite(interval.speedMps) && interval.speedMps >= 0 && interval.speedMps <= policy.maximumSpeedMps);
  const acceptedSeconds = accepted.reduce((sum, interval) => sum + interval.endSeconds - interval.startSeconds, 0);
  const hrSeconds = accepted.reduce((sum, interval) => sum + (finite(interval.hrBpm) &&
    interval.hrBpm >= policy.minimumHrBpm && interval.hrBpm < policy.maximumHrBpmExclusive ? interval.endSeconds - interval.startSeconds : 0), 0);
  const span = ordered.length && !structuralFailure ? ordered[ordered.length - 1].endSeconds - ordered[0].startSeconds : 0;
  const timeCoverageFraction = measurementsEvaluable && elapsed > 0 ? acceptedSeconds / elapsed : null;
  const hrCoverageFraction = acceptedSeconds > 0 ? hrSeconds / acceptedSeconds : null;
  if (measurementsEvaluable) {
    if (span <= 0 || elapsed <= 0 || span / elapsed < policy.minimumCoverageFraction || acceptedSeconds / span < policy.minimumCoverageFraction) reasons.push("insufficient_measured_time_coverage");
    if (hrCoverageFraction === null || hrCoverageFraction < policy.minimumHrCoverageFraction) reasons.push("insufficient_measured_hr_coverage");
    const pathDistance = accepted.reduce((sum, interval) => sum + interval.speedMps * (interval.endSeconds - interval.startSeconds), 0);
    if (finite(workout.distanceMeters) && workout.distanceMeters > 0 && Math.abs(pathDistance / workout.distanceMeters - 1) > 0.1) reasons.push("measured_distance_disagreement");
  } else {
    // Rejected intervals contribute no accepted seconds. That does not establish
    // independently measured time/HR gaps or disagreement with parent distance.
    limitations.push("measured_coverage_and_distance_not_evaluated_due_to_invalid_intervals");
  }

  const windows: NonNullable<ReturnType<typeof summarizeWindow>>[] = [];
  if (reasons.length === 0 && unresolved.length === 0) {
    for (let start = policy.warmupSeconds; start + policy.windowSeconds <= elapsed; start += policy.windowSeconds) {
      const window = summarizeWindow(accepted, start, policy);
      if (window) windows.push(window);
    }
    if (!windows.length) reasons.push("no_qualifying_steady_windows");
  }
  const bands = new Map<number, typeof windows>();
  for (const window of windows) {
    const band = Math.floor(window.hr / policy.hrBandWidthBpm) * policy.hrBandWidthBpm;
    bands.set(band, [...(bands.get(band) ?? []), window]);
  }
  const observations: SteadyObservation[] = [...bands.entries()].sort(([a], [b]) => a - b).slice(0, MAX_OBSERVATIONS_PER_WORKOUT).map(([band, values]) => ({
    lowerBpmInclusive: band,
    upperBpmExclusive: band + policy.hrBandWidthBpm,
    medianSpeedMps: median(values.map((value) => value.speed))!,
    medianHrBpm: median(values.map((value) => value.hr))!,
    windowCount: values.length,
    representativeStartSeconds: values[0].start,
    representativeEndSeconds: values[0].end,
  }));
  return {
    workoutId: workout.workoutId,
    parentDigest: workout.parentDigest,
    sourceInputDigest: await buildWorkoutInputDigest(workout),
    telemetryDigest: workout.telemetry.contentDigest,
    extractorVersion: versions.extractor,
    qualityPolicyVersion: versions.qualityPolicy,
    qualityPolicyDigest: await hashPerformanceValue(policy),
    observedAt: workout.startedAt,
    extractedAt,
    completion: workout.completion,
    telemetryState: workout.telemetry.state,
    status: unresolved.length ? "unresolved" : reasons.length ? "rejected" : "accepted",
    observations,
    reasons: [...new Set([...reasons, ...unresolved])].sort(comparePerformanceKeys),
    quality: { timeCoverageFraction, hrCoverageFraction, acceptedSeconds, sourceSampleCount: invalidSampleCount ? 0 : sourceSampleCount, environmentKnown },
    provenance: { ...workout.provenance, notes: [...workout.provenance.notes] },
    limitations: [...new Set(limitations)].sort(comparePerformanceKeys),
  };
}

/** Each workout contributes once per absolute-HR band, regardless of window count. */
export function summarizeAerobicPerformance(input: {
  features: readonly WorkoutPerformanceFeature[];
  excludedWorkoutIds: ReadonlySet<string>;
  asOf: string;
  timeZone: string;
  comparisonDays: number;
  policy: PerformanceQualityPolicy;
}): AerobicPerformanceIndicators {
  validatePolicy(input.policy);
  const asOf = validInstant(input.asOf);
  const windows = performanceComparisonWindows(input.asOf, input.timeZone, input.comparisonDays);
  const limitations = ["descriptive_speed_changes_are_not_race_time_changes", "heart_rate_bands_are_not_verified_physiological_zones", "route_weather_fatigue_and_effort_are_not_controlled", "workout_windows_are_correlated"];
  const byId = new Map<string, WorkoutPerformanceFeature>();
  const conflicts = new Set<string>();
  for (const feature of input.features) {
    const previous = byId.get(feature.workoutId);
    // Conflicting revisions cannot be resolved by input order or extraction timestamp.
    try {
      if (previous && canonicalizePerformanceValue({ ...previous, extractedAt: null }) !== canonicalizePerformanceValue({ ...feature, extractedAt: null })) conflicts.add(feature.workoutId);
    } catch {
      conflicts.add(feature.workoutId);
    }
    byId.set(feature.workoutId, feature);
  }
  if (conflicts.size) limitations.push("conflicting_workout_features_excluded");
  let oversizedFeature = false;
  type Band = AerobicPerformanceIndicators["bands"][number];
  const grouped = new Map<number, { current: SteadyObservation[]; reference: SteadyObservation[]; dates: Set<string> }>();
  let independentWorkoutCount = 0;
  for (const [id, feature] of byId) {
    if (conflicts.has(id) || input.excludedWorkoutIds.has(id) || feature.status !== "accepted" ||
        feature.completion !== "completed" || feature.telemetryState !== "complete" ||
        feature.qualityPolicyVersion !== input.policy.version) continue;
    if (!isPerformanceInstant(feature.observedAt) || validInstant(feature.observedAt) > asOf) continue;
    const date = performanceLocalDate(feature.observedAt, input.timeZone);
    const cohort = date >= windows.currentWindow.startDate && date <= windows.currentWindow.endDate ? "current" :
      date >= windows.referenceWindow.startDate && date <= windows.referenceWindow.endDate ? "reference" : null;
    if (!cohort) continue;
    if (feature.observations.length > MAX_OBSERVATIONS_PER_WORKOUT) {
      oversizedFeature = true;
      continue;
    }
    const sourceBands = new Map<number, SteadyObservation[]>();
    for (const observation of feature.observations) {
      const lower = observation.lowerBpmInclusive;
      if (!Number.isFinite(lower) || lower % input.policy.hrBandWidthBpm !== 0 ||
          observation.upperBpmExclusive !== lower + input.policy.hrBandWidthBpm ||
          lower < input.policy.minimumHrBpm || observation.upperBpmExclusive > input.policy.maximumHrBpmExclusive ||
          !Number.isFinite(observation.medianSpeedMps) || observation.medianSpeedMps <= 0 ||
          observation.medianSpeedMps > input.policy.maximumSpeedMps ||
          !Number.isFinite(observation.medianHrBpm) || observation.medianHrBpm < lower ||
          observation.medianHrBpm >= observation.upperBpmExclusive ||
          !Number.isSafeInteger(observation.windowCount) || observation.windowCount < 1 ||
          observation.windowCount > Math.floor(MAX_WORKOUT_SECONDS / input.policy.windowSeconds) ||
          !Number.isFinite(observation.representativeStartSeconds) || observation.representativeStartSeconds < input.policy.warmupSeconds ||
          !Number.isFinite(observation.representativeEndSeconds) || observation.representativeEndSeconds > MAX_WORKOUT_SECONDS ||
          observation.representativeEndSeconds - observation.representativeStartSeconds !== input.policy.windowSeconds) continue;
      sourceBands.set(lower, [...(sourceBands.get(lower) ?? []), observation]);
    }
    if (!sourceBands.size) continue;
    independentWorkoutCount++;
    for (const [lower, observations] of sourceBands) {
      // Malformed duplicate source-band records are collapsed, never extra source votes.
      const representative = { ...observations[0],
        medianSpeedMps: median(observations.map((value) => value.medianSpeedMps))!,
        medianHrBpm: median(observations.map((value) => value.medianHrBpm))!,
      };
      const group = grouped.get(lower) ?? { current: [], reference: [], dates: new Set<string>() };
      group[cohort].push(representative);
      group.dates.add(date);
      grouped.set(lower, group);
    }
  }
  const bands: Band[] = [...grouped.entries()].sort(([a], [b]) => a - b).map(([lower, group]) => {
    const currentMedianSpeedMps = median(group.current.map((value) => value.medianSpeedMps));
    const referenceMedianSpeedMps = median(group.reference.map((value) => value.medianSpeedMps));
    const sufficient = group.current.length >= input.policy.minimumIndependentWorkouts && group.reference.length >= input.policy.minimumIndependentWorkouts;
    return {
      lowerBpmInclusive: lower,
      upperBpmExclusive: lower + input.policy.hrBandWidthBpm,
      currentWorkoutCount: group.current.length,
      referenceWorkoutCount: group.reference.length,
      currentMedianSpeedMps,
      referenceMedianSpeedMps,
      currentMedianHrBpm: median(group.current.map((value) => value.medianHrBpm)),
      referenceMedianHrBpm: median(group.reference.map((value) => value.medianHrBpm)),
      speedChangePct: sufficient && currentMedianSpeedMps !== null && referenceMedianSpeedMps !== null ? (currentMedianSpeedMps / referenceMedianSpeedMps - 1) * 100 : null,
      status: sufficient ? "descriptive" : "insufficient",
      observationDates: [...group.dates].sort(comparePerformanceKeys),
    };
  });
  if (oversizedFeature) limitations.push("oversized_workout_features_excluded");
  return { ...windows, status: bands.some((band) => band.status === "descriptive") ? "descriptive" : "insufficient", independentWorkoutCount, bands, limitations: [...new Set(limitations)].sort(comparePerformanceKeys) };
}
