import { describe, expect, it } from "vitest";
import type {
  EffectivePerformanceWorkout,
  PerformanceTelemetryInterval,
  PerformanceVersions,
  WorkoutPerformanceFeature,
} from "@/types/performanceAnalysis";
import {
  DEFAULT_PERFORMANCE_QUALITY_POLICY as policy,
  extractWorkoutPerformanceFeature,
  summarizeAerobicPerformance,
} from "../aerobicPerformance";
import { hashPerformanceValue } from "../performanceEvidence";

const versions: PerformanceVersions = { schema: 1, model: "manual-foundation-v1", extractor: "steady-interval-v2", qualityPolicy: policy.version };
const asOf = "2026-10-21T14:00:00Z";
const provenance = { source: "synthetic-position-derived-intervals", sourceId: "synthetic-workout", notes: [] };

function intervalsFor(seconds = 1800, speed = 3, hr: number | null = 147): PerformanceTelemetryInterval[] {
  return Array.from({ length: seconds / 5 }, (_, index) => ({ startSeconds: index * 5, endSeconds: (index + 1) * 5, speedMps: speed, hrBpm: hr }));
}

async function extract(options: {
  intervals?: PerformanceTelemetryInterval[];
  workout?: Partial<EffectivePerformanceWorkout>;
  sourceSampleCount?: number;
  extraction?: Partial<Parameters<typeof extractWorkoutPerformanceFeature>[0]>;
} = {}) {
  const intervals = options.intervals ?? intervalsFor();
  const sourceSampleCount = options.sourceSampleCount ?? intervals.length + 1;
  const digest = await hashPerformanceValue({ intervals, sourceSampleCount });
  const workout: EffectivePerformanceWorkout = {
    workoutId: "synthetic-workout",
    startedAt: "2026-10-18T12:00:00Z",
    endedAt: "2026-10-18T12:30:00Z",
    availableAt: "2026-10-18T13:00:00Z",
    completion: "completed",
    excluded: false,
    isRun: true,
    runKind: "outdoor",
    distanceMeters: 5400,
    durationSeconds: 1800,
    averageHrBpm: 190,
    ascentMeters: 20,
    environment: { temperatureF: 60, dewPointF: 45, windMph: 3 },
    parentDigest: "synthetic-parent",
    telemetry: { state: "complete", verification: "supplied_content", contentDigest: digest },
    provenance,
    limitations: [],
    ...options.workout,
  };
  return extractWorkoutPerformanceFeature({ workout, intervals, sourceSampleCount, asOf, extractedAt: asOf, versions, policy, ...options.extraction });
}

function feature(id: string, date: string, speed = 3, hr = 147, count = 1): WorkoutPerformanceFeature {
  const lower = Math.floor(hr / 5) * 5;
  return {
    workoutId: id, parentDigest: `parent-${id}`, sourceInputDigest: `input-${id}`, telemetryDigest: `telemetry-${id}`,
    extractorVersion: versions.extractor, qualityPolicyVersion: policy.version,
    qualityPolicyDigest: "synthetic-policy-digest",
    observedAt: `${date}T12:00:00Z`, extractedAt: asOf, completion: "completed", telemetryState: "complete", status: "accepted",
    observations: [{ lowerBpmInclusive: lower, upperBpmExclusive: lower + 5, medianSpeedMps: speed, medianHrBpm: hr, windowCount: count, representativeStartSeconds: 600, representativeEndSeconds: 1200 }],
    reasons: [], quality: { timeCoverageFraction: 1, hrCoverageFraction: 1, acceptedSeconds: 1800, sourceSampleCount: 361, environmentKnown: true },
    provenance: { ...provenance, sourceId: id }, limitations: [],
  };
}

function summarize(features: WorkoutPerformanceFeature[], overrides: Partial<Parameters<typeof summarizeAerobicPerformance>[0]> = {}) {
  return summarizeAerobicPerformance({ features, excludedWorkoutIds: new Set(), asOf, timeZone: "America/New_York", comparisonDays: 28, policy, ...overrides });
}

describe("measured steady-running extraction", () => {
  it("accepts measured intervals, uses their HR and emits compact per-band representatives", async () => {
    const result = await extract();
    expect(result.status).toBe("accepted");
    expect(result.observations).toEqual([{ lowerBpmInclusive: 145, upperBpmExclusive: 150, medianSpeedMps: 3, medianHrBpm: 147, windowCount: 2, representativeStartSeconds: 600, representativeEndSeconds: 1200 }]);
    expect(result.quality).toMatchObject({ timeCoverageFraction: 1, hrCoverageFraction: 1, acceptedSeconds: 1800, sourceSampleCount: 361 });
    expect(JSON.stringify(result)).not.toContain("startSeconds");
    expect(result.limitations).toContain("steady_running_does_not_establish_maximal_effort");
  });

  it("uses the median of source-band windows and deterministic earliest provenance", async () => {
    const intervals = intervalsFor(2400);
    intervals.forEach((interval) => { if (interval.startSeconds >= 1800) interval.speedMps = 3.3; });
    const result = await extract({ intervals, workout: { endedAt: "2026-10-18T12:40:00Z", durationSeconds: 2400, distanceMeters: 7380 } });
    expect(result.status).toBe("accepted");
    expect(result.observations[0]).toMatchObject({ windowCount: 3, medianSpeedMps: 3, representativeStartSeconds: 600 });
  });

  it("is deterministic and does not mutate supplied measurements or metadata", async () => {
    const intervals = intervalsFor();
    const before = structuredClone(intervals);
    Object.freeze(intervals);
    intervals.forEach(Object.freeze);
    expect(await extract({ intervals })).toEqual(await extract({ intervals }));
    expect(intervals).toEqual(before);
  });

  it("captures caller inputs before crypto awaits so later edits cannot bypass the receipt", async () => {
    const intervals = intervalsFor();
    const original = await extract({ intervals });
    const workout: EffectivePerformanceWorkout = {
      workoutId: original.workoutId, startedAt: original.observedAt, endedAt: "2026-10-18T12:30:00Z", availableAt: "2026-10-18T13:00:00Z",
      completion: "completed", excluded: false, isRun: true, runKind: "outdoor", distanceMeters: 5400, durationSeconds: 1800,
      averageHrBpm: 190, ascentMeters: 20, environment: { temperatureF: 60, dewPointF: 45, windMph: 3 }, parentDigest: "synthetic-parent",
      telemetry: { state: "complete", verification: "supplied_content", contentDigest: original.telemetryDigest }, provenance: { ...provenance, notes: [...provenance.notes] }, limitations: [],
    };
    const mutablePolicy = { ...policy };
    const pending = extractWorkoutPerformanceFeature({ workout, intervals, sourceSampleCount: intervals.length + 1, asOf, extractedAt: asOf, versions, policy: mutablePolicy });
    intervals.forEach((interval) => { interval.speedMps = 6; });
    workout.telemetry.contentDigest = "changed-while-hashing";
    workout.provenance.notes = ["changed-while-hashing"];
    mutablePolicy.windowSeconds = 3600;
    expect(await pending).toEqual(original);
  });

  it.each(["incomplete", "unknown"] as const)("keeps %s workouts unresolved despite a complete-looking measured stream", async (completion) => {
    const result = await extract({ workout: { completion } });
    expect(result.status).toBe("unresolved");
    expect(result.observations).toEqual([]);
    expect(result.completion).toBe(completion);
  });

  it("does not certify child completeness from parent fields or an unverified digest", async () => {
    const result = await extract({ workout: { telemetry: { state: "complete", verification: "unverified", contentDigest: "parent-cached-value" } } });
    expect(result.status).toBe("unresolved");
    expect(result.reasons).toEqual(expect.arrayContaining(["telemetry_completeness_unverified", "telemetry_content_digest_mismatch"]));
    expect(result.observations).toEqual([]);
  });

  it("detects changed child intervals even if the parent's receipt appears unchanged", async () => {
    const original = intervalsFor();
    const digest = await hashPerformanceValue({ intervals: original, sourceSampleCount: original.length + 1 });
    const changed = intervalsFor(1800, 3.1);
    const result = await extract({ intervals: changed, workout: { telemetry: { state: "complete", verification: "supplied_content", contentDigest: digest } } });
    expect(result.status).toBe("unresolved");
    expect(result.reasons).toContain("telemetry_content_digest_mismatch");
  });

  it.each(["unknown", "pending", "failed", "absent"] as const)("retains %s telemetry state with no accepted observations", async (state) => {
    const result = await extract({ intervals: [], workout: { telemetry: { state, verification: "unverified", contentDigest: null } } });
    expect(result.telemetryState).toBe(state);
    expect(result.status).toBe("unresolved");
    expect(result.observations).toEqual([]);
    if (state === "absent") expect(result.reasons).toContain("telemetry_absence_unverified");
  });

  it("distinguishes verified absence from an unverified absence claim", async () => {
    const contentDigest = await hashPerformanceValue({ intervals: [], sourceSampleCount: 0 });
    const result = await extract({ intervals: [], sourceSampleCount: 0, workout: { telemetry: { state: "absent", verification: "supplied_content", contentDigest } } });
    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain("telemetry_verified_absent");
  });

  it("rejects missing HR instead of substituting whole-workout HR", async () => {
    const result = await extract({ intervals: intervalsFor(1800, 3, null) });
    expect(result.status).toBe("rejected");
    expect(result.quality.hrCoverageFraction).toBe(0);
    expect(result.reasons).toContain("insufficient_measured_hr_coverage");
    expect(result.observations).toEqual([]);
  });

  it("uses a strict plausible HR upper endpoint", async () => {
    const result = await extract({ intervals: intervalsFor(1800, 3, 210) });
    expect(result.reasons).toContain("insufficient_measured_hr_coverage");
  });

  it("rejects excluded, nonrunning and uncalibrated treadmill sources", async () => {
    for (const workout of [{ excluded: true }, { isRun: false }, { runKind: "treadmill" as const }]) {
      const result = await extract({ workout });
      expect(result.status).toBe("rejected");
      expect(result.observations).toEqual([]);
    }
  });

  it("rejects workouts or known availability after the explicit as-of instant", async () => {
    const future = await extract({ extraction: { asOf: "2026-10-18T12:15:00Z" } });
    expect(future.reasons).toContain("invalid_or_future_workout_time");
    const laterAvailable = await extract({ workout: { availableAt: "2026-10-22T00:00:00Z" } });
    expect(laterAvailable.reasons).toContain("source_unavailable_as_of");
    expect(laterAvailable.observations).toEqual([]);
  });

  it("retains unknown source availability as a historical limitation", async () => {
    const result = await extract({ workout: { availableAt: null } });
    expect(result.status).toBe("accepted");
    expect(result.limitations).toContain("source_availability_time_unknown");
  });

  it("rejects insufficient source samples and measured interval gaps", async () => {
    const sparse = await extract({ intervals: intervalsFor().filter((interval) => interval.startSeconds % 20 === 0), sourceSampleCount: 91 });
    expect(sparse.reasons).toContain("insufficient_or_invalid_source_samples");
    expect(sparse.reasons).toContain("insufficient_measured_time_coverage");
  });

  it("rejects overlapping intervals instead of double-counting measured time", async () => {
    const intervals = intervalsFor();
    intervals.push({ ...intervals[120] });
    const result = await extract({ intervals });
    expect(result.reasons).toContain("invalid_or_overlapping_intervals");
    expect(result.quality.acceptedSeconds).toBe(0);
    expect(result.quality.timeCoverageFraction).toBeNull();
    expect(result.reasons).not.toContain("insufficient_measured_time_coverage");
  });

  it("keeps a boundary-invalid hot workout unresolved without inventing measured coverage failures", async () => {
    const intervals = intervalsFor();
    intervals[0].startSeconds = -0.144;
    const contentDigest = await hashPerformanceValue({ intervals, sourceSampleCount: intervals.length + 1 });
    const result = await extract({ intervals, workout: {
      environment: { temperatureF: 85.3, dewPointF: 69.7, windMph: 4.8 },
      telemetry: { state: "unknown", verification: "supplied_content", contentDigest },
    } });

    expect(result.status).toBe("unresolved");
    expect(result.observations).toEqual([]);
    expect(result.reasons).toEqual([
      "invalid_or_overlapping_intervals", "known_extreme_environment", "telemetry_completeness_unverified",
    ]);
    expect(result.quality).toMatchObject({ acceptedSeconds: 0, timeCoverageFraction: null, hrCoverageFraction: null });
    expect(result.limitations).toContain("measured_coverage_and_distance_not_evaluated_due_to_invalid_intervals");
    expect(intervals[0].startSeconds).toBe(-0.144);
  });

  it("preserves the heat rejection and measured coverage when intervals are valid", async () => {
    const result = await extract({ workout: { environment: { temperatureF: 85.3, dewPointF: 69.7, windMph: 4.8 } } });
    expect(result.status).toBe("rejected");
    expect(result.observations).toEqual([]);
    expect(result.reasons).toEqual(["known_extreme_environment"]);
    expect(result.quality).toMatchObject({ acceptedSeconds: 1800, timeCoverageFraction: 1, hrCoverageFraction: 1 });
    expect(result.limitations).not.toContain("measured_coverage_and_distance_not_evaluated_due_to_invalid_intervals");
    expect((await extract({ workout: { environment: { temperatureF: 80, dewPointF: 69.7, windMph: 4.8 } } })).status).toBe("accepted");
  });

  it("rejects nonfinite measurements explicitly", async () => {
    const intervals = intervalsFor();
    intervals[0].speedMps = Number.NaN;
    const result = await extract({ extraction: { intervals } });
    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain("invalid_interval_measurement");
    expect(result.observations).toEqual([]);
    expect(result.quality).toMatchObject({ acceptedSeconds: 0, timeCoverageFraction: null, hrCoverageFraction: null });
    expect(result.reasons).not.toContain("measured_distance_disagreement");
    expect(result.limitations).toContain("measured_coverage_and_distance_not_evaluated_due_to_invalid_intervals");
  });

  it("rejects invalid sample counts without serializing a nonfinite count", async () => {
    const result = await extract({ extraction: { sourceSampleCount: Number.NaN } });
    expect(result.status).toBe("rejected");
    expect(result.quality.sourceSampleCount).toBe(0);
  });

  it("binds the exact quality-policy content even if a caller keeps its version string", async () => {
    const original = await extract();
    const changed = await extract({ extraction: { policy: { ...policy, maximumMinuteSpeedCV: 0.1 } } });
    expect(original.qualityPolicyDigest).not.toBe(changed.qualityPolicyDigest);
  });

  it("reduces reordered measurements chronologically only when their exact content receipt matches", async () => {
    const original = intervalsFor();
    const reversed = [...original].reverse();
    const first = await extract({ intervals: original });
    const second = await extract({ intervals: reversed });
    expect(second.status).toBe("accepted");
    expect(second.observations).toEqual(first.observations);
    expect(second.telemetryDigest).not.toBe(first.telemetryDigest);
    const staleReceipt = await extract({ intervals: original, extraction: { intervals: reversed } });
    expect(staleReceipt.status).toBe("unresolved");
    expect(staleReceipt.reasons).toContain("telemetry_content_digest_mismatch");
  });

  it("bounds policy allocations, workout duration and source size without silent truncation", async () => {
    await expect(extract({ extraction: { policy: { ...policy, windowSeconds: 6_000_000 } } })).rejects.toThrow("policy bounds");
    await expect(extract({ extraction: { policy: { ...policy, minimumMinuteSeconds: undefined as unknown as number } } })).rejects.toThrow("quality policy");
    const enormous = Array.from({ length: 100_001 }, () => intervalsFor(5)[0]);
    await expect(extract({ extraction: { intervals: enormous } })).rejects.toThrow("supported interval count");
    const long = await extract({ workout: { startedAt: "2026-10-16T12:00:00Z", durationSeconds: 174600 } });
    expect(long.reasons).toContain("workout_exceeds_supported_duration");
    const excessiveSamples = await extract({ extraction: { sourceSampleCount: 1_000_001 } });
    expect(excessiveSamples.status).toBe("rejected");
    expect(excessiveSamples.quality.sourceSampleCount).toBe(0);
  });

  it("rejects time-basis discrepancies and excessive implausible-speed coverage", async () => {
    const duration = await extract({ workout: { durationSeconds: 1500 } });
    expect(duration.reasons).toContain("duration_elapsed_discrepancy");
    const intervals = intervalsFor();
    intervals.forEach((interval, index) => { if (index < 80) interval.speedMps = 20; });
    const speeds = await extract({ intervals });
    expect(speeds.reasons).toContain("insufficient_measured_time_coverage");
  });

  it("uses effective corrected distance and rejects disagreement with measured distance", async () => {
    expect((await extract({ workout: { distanceMeters: 9000 } })).reasons).toContain("measured_distance_disagreement");
    expect((await extract({ workout: { distanceMeters: 5400 } })).status).toBe("accepted");
  });

  it("keeps missing terrain unresolved and known excessive terrain rejected", async () => {
    expect((await extract({ workout: { ascentMeters: null } })).status).toBe("unresolved");
    expect((await extract({ workout: { ascentMeters: 200 } })).reasons).toContain("terrain_screen_failed");
  });

  it("retains unknown weather with a limitation and screens known extremes", async () => {
    const missing = await extract({ workout: { environment: { temperatureF: null, dewPointF: null, windMph: null } } });
    expect(missing.status).toBe("accepted");
    expect(missing.quality.environmentKnown).toBe(false);
    expect(missing.limitations).toContain("environment_not_fully_observed");
    const extreme = await extract({ workout: { environment: { temperatureF: 81, dewPointF: null, windMph: null } } });
    expect(extreme.reasons).toContain("known_extreme_environment");
  });

  it("requires complete minutes after warmup rather than accepting whole-run coverage alone", async () => {
    const intervals = intervalsFor().filter((interval) => ![600, 605, 1200, 1205].includes(interval.startSeconds));
    const result = await extract({ intervals });
    expect(result.quality.timeCoverageFraction).toBeGreaterThan(0.98);
    expect(result.reasons).toContain("no_qualifying_steady_windows");
  });

  it("does not label a rising HR profile as steady performance", async () => {
    const intervals = intervalsFor();
    intervals.forEach((interval) => { interval.hrBpm = 120 + Math.floor((interval.startSeconds % 600) / 60) * 3; });
    const result = await extract({ intervals });
    expect(result.reasons).toContain("no_qualifying_steady_windows");
  });

  it("rejects version mismatch and invalid policy bounds before calculation", async () => {
    await expect(extract({ extraction: { versions: { ...versions, qualityPolicy: "another-version" } } })).rejects.toThrow("version mismatch");
    await expect(extract({ extraction: { policy: { ...policy, minimumIndependentWorkouts: 1 } } })).rejects.toThrow("policy bounds");
  });
});

describe("independent workout aerobic trends", () => {
  it("reports descriptive speed changes only with three independent sources on both sides", () => {
    const features = [1, 2, 3].flatMap((index) => [feature(`current-${index}`, `2026-10-${10 + index}`, 3.3), feature(`reference-${index}`, `2026-09-${10 + index}`, 3)]);
    const result = summarize(features);
    expect(result.status).toBe("descriptive");
    expect(result.independentWorkoutCount).toBe(6);
    expect(result.bands[0]).toMatchObject({ currentWorkoutCount: 3, referenceWorkoutCount: 3, currentMedianHrBpm: 147, referenceMedianHrBpm: 147 });
    expect(result.bands[0].speedChangePct).toBeCloseTo(10);
    expect(result.limitations).toContain("descriptive_speed_changes_are_not_race_time_changes");
    expect(result).not.toHaveProperty("estimatedSeconds");
  });

  it("counts many windows and duplicated records from one workout once", () => {
    const current = feature("current", "2026-10-10", 3, 147, 50);
    const reference = feature("reference", "2026-09-10", 3, 147, 50);
    const result = summarize([current, { ...current, extractedAt: "2026-10-21T15:00:00Z" }, reference]);
    expect(result.independentWorkoutCount).toBe(2);
    expect(result.bands[0]).toMatchObject({ currentWorkoutCount: 1, referenceWorkoutCount: 1, speedChangePct: null, status: "insufficient" });
  });

  it("excludes contradictory revisions deterministically rather than selecting by input order", () => {
    const a = feature("same", "2026-10-10", 3);
    const b = feature("same", "2026-10-10", 3.2);
    expect(summarize([a, b])).toEqual(summarize([b, a]));
    expect(summarize([a, b]).independentWorkoutCount).toBe(0);
  });

  it("collapses repeated bands from one source without creating independent votes", () => {
    const current = feature("current", "2026-10-10");
    current.observations = [...current.observations, ...current.observations];
    expect(summarize([current]).bands[0].currentWorkoutCount).toBe(1);
  });

  it("keeps two distinct workouts on the same local date independent", () => {
    const result = summarize([feature("morning", "2026-10-10"), feature("evening", "2026-10-10")]);
    expect(result.independentWorkoutCount).toBe(2);
    expect(result.bands[0].currentWorkoutCount).toBe(2);
    expect(result.bands[0].observationDates).toEqual(["2026-10-10"]);
  });

  it("excludes linked race workouts, rejected or incomplete sources and obsolete quality versions", () => {
    const race = feature("race", "2026-10-10");
    const rejected = { ...feature("rejected", "2026-10-10"), status: "rejected" as const };
    const incomplete = { ...feature("incomplete", "2026-10-10"), completion: "incomplete" as const };
    const obsolete = { ...feature("obsolete", "2026-10-10"), qualityPolicyVersion: "obsolete" };
    expect(summarize([race, rejected, incomplete, obsolete], { excludedWorkoutIds: new Set(["race"]) }).independentWorkoutCount).toBe(0);
  });

  it("does not interpret slower easy-running or different HR composition as reduced maximal fitness", () => {
    const result = summarize([1, 2, 3].flatMap((index) => [feature(`easy-${index}`, `2026-10-${10 + index}`, 2.7, 142), feature(`harder-${index}`, `2026-09-${10 + index}`, 3.1, 162)]));
    expect(result.bands).toHaveLength(2);
    expect(result.bands.every((band) => band.speedChangePct === null && band.status === "insufficient")).toBe(true);
    expect(result.status).toBe("insufficient");
  });

  it("uses nonoverlapping local dates at the comparison boundaries", () => {
    const currentBoundary = feature("local-current", "2026-09-24");
    currentBoundary.observedAt = "2026-09-24T04:00:00Z";
    const referenceBoundary = feature("local-reference", "2026-09-24");
    referenceBoundary.observedAt = "2026-09-24T03:59:59Z";
    const result = summarize([currentBoundary, referenceBoundary]);
    expect(result.currentWindow).toEqual({ startDate: "2026-09-24", endDate: "2026-10-21" });
    expect(result.referenceWindow).toEqual({ startDate: "2026-08-27", endDate: "2026-09-23" });
    expect(result.bands[0]).toMatchObject({ currentWorkoutCount: 1, referenceWorkoutCount: 1 });
  });

  it("preserves local-day membership across the autumn DST transition", () => {
    const beforeFallback = feature("before", "2026-11-01");
    beforeFallback.observedAt = "2026-11-01T05:30:00Z";
    const afterFallback = feature("after", "2026-11-01");
    afterFallback.observedAt = "2026-11-01T06:30:00Z";
    const result = summarize([beforeFallback, afterFallback], { asOf: "2026-11-02T12:00:00Z" });
    expect(result.bands[0].currentWorkoutCount).toBe(2);
    expect(result.bands[0].observationDates).toEqual(["2026-11-01"]);
  });

  it("excludes future observed timestamps even on the current local date", () => {
    const future = feature("future", "2026-10-21");
    future.observedAt = "2026-10-21T23:00:00Z";
    expect(summarize([future]).independentWorkoutCount).toBe(0);
  });

  it("rejects malformed observations and does not mutate supplied features", () => {
    const valid = feature("valid", "2026-10-10");
    const invalid = feature("invalid", "2026-10-10", Number.NaN);
    const before = structuredClone(valid);
    expect(summarize([valid, invalid]).independentWorkoutCount).toBe(1);
    expect(valid).toEqual(before);
  });

  it("rejects oversized or invalid observation bounds instead of counting their values", () => {
    const oversized = feature("oversized", "2026-10-10");
    oversized.observations = Array.from({ length: 31 }, () => oversized.observations[0]);
    const invalidWindow = feature("invalid-window", "2026-10-10");
    invalidWindow.observations = [{ ...invalidWindow.observations[0], representativeEndSeconds: Number.POSITIVE_INFINITY }];
    const result = summarize([oversized, invalidWindow]);
    expect(result.independentWorkoutCount).toBe(0);
    expect(result.limitations).toContain("oversized_workout_features_excluded");
  });

  it("produces identical output regardless of feature ordering", () => {
    const features = [feature("a", "2026-10-12", 3.2), feature("b", "2026-10-11", 3), feature("c", "2026-09-12", 2.8)];
    expect(summarize(features)).toEqual(summarize([...features].reverse()));
  });
});
