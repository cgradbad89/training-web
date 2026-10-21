import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { EffectivePerformanceWorkout, PerformanceAnalysisInput, WorkoutPerformanceFeature } from "@/types/performanceAnalysis";
import { DEFAULT_PERFORMANCE_QUALITY_POLICY as policy, extractWorkoutPerformanceFeature } from "@/utils/aerobicPerformance";
import {
  buildWorkoutInputDigest, canonicalizePerformanceValue, hashPerformanceValue, isPerformanceInstant,
  performanceComparisonWindows, performanceLocalDate, performanceObservationWindow,
  selectWorkoutsForManualAnalysis, shiftPerformanceDate, toEffectivePerformanceWorkout,
} from "@/utils/performanceEvidence";
import { buildPerformanceSnapshotPayload, calculatePerformanceAnalysis, PERFORMANCE_DEFAULTS, PERFORMANCE_VERSIONS as versions, shouldAppendPerformanceSnapshot } from "@/utils/performanceAnalysis";

const asOf = "2026-10-21T14:00:00.000Z";
const timeZone = "America/New_York";

function rawWorkout(fields: Partial<HealthWorkout> = {}): HealthWorkout {
  return {
    workoutId: "run-a", name: "Run", activityType: "running", displayType: "Run",
    startDate: new Date("2026-10-18T12:00:00.000Z"), endDate: new Date("2026-10-18T12:30:00.000Z"),
    durationSeconds: 1800, sourceName: "synthetic-watch", isRunLike: true, hasRoute: true, routeComplete: true,
    syncedAt: new Date("2026-10-18T13:00:00.000Z"), calories: 300, avgHeartRate: 142,
    distanceMiles: 5400 / 1609.344, distanceMeters: 5400, avgPaceSecPerMile: null,
    avgSpeedMPS: 3, hrDriftPct: null, cadenceSPM: null, efficiencyRaw: null, efficiencyScore: null,
    elevationGainM: 20, ...fields,
  };
}

function override(fields: Partial<WorkoutOverride>): WorkoutOverride {
  return { workoutId: "run-a", userId: "synthetic", isExcluded: false, excludedAt: null, excludedReason: null,
    distanceMilesOverride: null, durationSecondsOverride: null, runTypeOverride: null, updatedAt: asOf, ...fields };
}

async function source(fields: Partial<HealthWorkout> = {}): Promise<EffectivePerformanceWorkout> {
  return toEffectivePerformanceWorkout({ workout: rawWorkout(fields), override: null, completion: "completed", availableAt: null });
}

async function extracted(fields: Partial<HealthWorkout> = {}): Promise<{ workout: EffectivePerformanceWorkout; feature: WorkoutPerformanceFeature }> {
  const intervals = Array.from({ length: 180 }, (_, index) => ({ startSeconds: index * 10, endSeconds: (index + 1) * 10, speedMps: 3, hrBpm: 142 }));
  const sourceSampleCount = 181;
  const workout = await source(fields);
  workout.telemetry = { state: "complete", verification: "supplied_content", contentDigest: await hashPerformanceValue({ intervals, sourceSampleCount }) };
  const feature = await extractWorkoutPerformanceFeature({ workout, intervals, sourceSampleCount, asOf, extractedAt: asOf, versions, policy });
  return { workout, feature };
}

function input(fields: Partial<PerformanceAnalysisInput> = {}): PerformanceAnalysisInput {
  return { asOf, timeZone, workouts: [], features: [], linkedRaces: [], deviceVo2: [], versions: { ...versions },
    ...PERFORMANCE_DEFAULTS, qualityPolicy: { ...policy },
    coverage: { window: performanceObservationWindow(asOf, timeZone, 180), workouts: "complete", telemetry: "complete", deviceVo2: "complete", expectedWorkoutCount: null, limitations: [] }, ...fields };
}

async function select(workout: EffectivePerformanceWorkout, features: WorkoutPerformanceFeature[] = [], extra: Partial<Parameters<typeof selectWorkoutsForManualAnalysis>[0]> = {}) {
  return (await selectWorkoutsForManualAnalysis({ workouts: [workout], features, versions, qualityPolicy: policy, asOf, ...extra }))[0];
}

describe("performance evidence canonical identity", () => {
  it("matches the SHA256 golden value for canonical JSON", async () => {
    expect(await hashPerformanceValue({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });
  it("sorts object keys recursively and normalizes negative zero", () => {
    expect(canonicalizePerformanceValue({ b: { z: -0, a: null }, a: 1 })).toBe('{"a":1,"b":{"a":null,"z":0}}');
  });
  it.each([NaN, Infinity, -Infinity, undefined, new Date(asOf), () => 1, new Map()])("rejects unsupported/nonfinite evidence %#", value => {
    expect(() => canonicalizePerformanceValue({ value })).toThrow();
  });
  it("distinguishes null and zero", async () => { expect(await hashPerformanceValue(null)).not.toBe(await hashPerformanceValue(0)); });
  it("rejects sparse arrays instead of silently deleting missing evidence", () => {
    expect(() => canonicalizePerformanceValue(Array(2))).toThrow();
  });
  it("rejects normalized impossible dates and offset-free instants", () => {
    expect(isPerformanceInstant("2026-02-30T12:00:00Z")).toBe(false);
    expect(isPerformanceInstant("2026-10-21T12:00:00")).toBe(false);
  });
  it("keeps canonical overrides and original sources distinct without mutation", async () => {
    const raw = rawWorkout();
    const original = structuredClone(raw);
    const effective = await toEffectivePerformanceWorkout({ workout: raw, override: override({ distanceMilesOverride: 5, durationSecondsOverride: 2000 }), completion: "completed", availableAt: null });
    expect(effective.distanceMeters).toBe(8046.72);
    expect(effective.durationSeconds).toBe(2000);
    expect(raw).toEqual(original);
    expect(effective.parentDigest).not.toBe((await source()).parentDigest);
  });
  it("preserves canonical isRunLike with a type override", async () => {
    const effective = await toEffectivePerformanceWorkout({ workout: rawWorkout({ isRunLike: false }), override: override({ runTypeOverride: "Treadmill Run" }), completion: "completed", availableAt: null });
    expect(effective.isRun).toBe(false);
    expect(effective.runKind).toBe("treadmill");
  });
  it("parent cache writes do not alter evidence identity", async () => {
    const before = await source();
    const after = await source({ trainingLoadV2: 999, prBadges: ["PR"], gapSecPerMile: 200, routeClusterId: "cache", syncedAt: new Date(asOf) });
    expect(before).toEqual(after);
  });
  it("never upgrades a missing route flag to verified completeness", async () => {
    expect((await source({ routeComplete: undefined })).telemetry).toEqual({ state: "unknown", verification: "unverified", contentDigest: null });
    expect((await source({ routeComplete: false })).telemetry.state).toBe("pending");
    expect((await source()).telemetry.state).toBe("unknown");
  });
  it("an explicitly partial parent cannot be overridden by a child content hash", async () => {
    const workout = await toEffectivePerformanceWorkout({ workout: rawWorkout({ routeComplete: false }), override: null, completion: "completed", availableAt: null,
      telemetry: { state: "complete", contentDigest: "a".repeat(64), verification: "supplied_content" } });
    expect(workout.telemetry).toMatchObject({ state: "pending", verification: "unverified" });
  });
});

describe("manual feature selection and invalidation", () => {
  it("identifies a new run for extraction", async () => { expect(await select(await source())).toMatchObject({ action: "extract", reason: "missing_feature", requireFreshTelemetry: true }); });
  it("reuses a valid compact feature only with matching verified content and versions", async () => {
    const { workout, feature } = await extracted();
    expect(feature.status).toBe("accepted");
    expect(await select(workout, [feature])).toMatchObject({ action: "reuse", requireFreshTelemetry: false });
  });
  it("forces fresh child extraction despite unchanged parent", async () => {
    const { workout, feature } = await extracted();
    expect(await select(workout, [feature], { forcedWorkoutIds: [workout.workoutId] })).toMatchObject({ action: "extract", reason: "forced_reprocess", requireFreshTelemetry: true });
  });
  it("invalidates a changed parent", async () => {
    const { workout, feature } = await extracted();
    expect(await select({ ...workout, parentDigest: "corrected" }, [feature])).toMatchObject({ action: "extract", reason: "changed_parent_evidence" });
  });
  it("does not certify child-only changes absent from matching parent fields", async () => {
    const { workout, feature } = await extracted();
    expect(await select({ ...workout, telemetry: { ...workout.telemetry, verification: "unverified" } }, [feature])).toMatchObject({ action: "review", reason: "child_content_unverified" });
    expect(await select({ ...workout, telemetry: { ...workout.telemetry, contentDigest: "a".repeat(64) } }, [feature])).toMatchObject({ action: "extract", reason: "changed_source_inputs" });
  });
  it("invalidates changed policy versions", async () => {
    const { workout, feature } = await extracted();
    expect(await select(workout, [feature], { versions: { ...versions, qualityPolicy: "observational-v2" }, qualityPolicy: { ...policy, version: "observational-v2" } })).toMatchObject({ action: "extract", reason: "incompatible_feature_version" });
  });
  it("invalidates different thresholds even if a caller forgot the policy version bump", async () => {
    const { workout, feature } = await extracted();
    expect(await select(workout, [feature], { qualityPolicy: { ...policy, maximumTemperatureF: 70 } })).toMatchObject({ action: "extract", reason: "incompatible_feature_version" });
  });
  it("keeps incomplete workouts unresolved even with formerly valid features", async () => {
    const { workout, feature } = await extracted();
    expect(await select({ ...workout, completion: "incomplete" }, [feature])).toMatchObject({ action: "review" });
  });
  it("excludes explicitly excluded runs before any forced reprocessing", async () => {
    expect(await select({ ...await source(), excluded: true }, [], { forcedWorkoutIds: ["run-a"] })).toMatchObject({ action: "exclude" });
  });
  it("collapses identical duplicates and surfaces conflicting IDs", async () => {
    const workout = await source();
    expect(await selectWorkoutsForManualAnalysis({ workouts: [workout, workout], features: [], versions, qualityPolicy: policy, asOf })).toHaveLength(1);
    expect(await select(workout, [], { workouts: [workout, { ...workout, distanceMeters: 6000 }] })).toMatchObject({ action: "review", reason: "conflicting_workout_evidence" });
  });
  it("equivalent features with different extraction timestamps remain one reusable source", async () => {
    const { workout, feature } = await extracted();
    expect(await select(workout, [feature, { ...feature, extractedAt: "2026-10-21T14:01:00Z" }])).toMatchObject({ action: "reuse" });
  });
});

describe("explicit local calendar semantics", () => {
  it.each([
    ["2026-03-08T06:59:00Z", "2026-03-08"], ["2026-03-08T07:01:00Z", "2026-03-08"],
    ["2026-11-01T05:30:00Z", "2026-11-01"], ["2026-11-01T06:30:00Z", "2026-11-01"],
    ["2026-10-21T03:59:00Z", "2026-10-20"], ["2026-10-21T04:00:00Z", "2026-10-21"],
  ])("buckets %s in explicit Eastern timezone", (instant, date) => { expect(performanceLocalDate(instant, timeZone)).toBe(date); });
  it("uses nonoverlapping inclusive 28-local-date comparisons through DST", () => {
    expect(performanceComparisonWindows("2026-11-15T14:00:00Z", timeZone, 28)).toEqual({ currentWindow: { startDate: "2026-10-19", endDate: "2026-11-15" }, referenceWindow: { startDate: "2026-09-21", endDate: "2026-10-18" } });
    expect(shiftPerformanceDate("2026-03-08", 1)).toBe("2026-03-09");
  });
});

describe("calculation composition and scientific boundaries", () => {
  it("is deterministic and does not mutate inputs", async () => {
    const { workout, feature } = await extracted();
    const data = input({ workouts: [workout], features: [feature] });
    const before = structuredClone(data);
    expect(await calculatePerformanceAnalysis(data)).toEqual(await calculatePerformanceAnalysis(data));
    expect(data).toEqual(before);
  });
  it("adds a new completed run once, including two separate same-day runs", async () => {
    const a = await source(); const b = await source({ workoutId: "run-b" });
    const result = await calculatePerformanceAnalysis(input({ workouts: [a, a, b] }));
    expect(result.completeness.effectiveWorkoutCount).toBe(2);
    expect(result.preparation.recent.runCount).toBe(2);
    expect(result.preparation.recent.runDays).toBe(1);
  });
  it("reversing query order preserves output and digest", async () => {
    const a = await extracted(); const b = await extracted({ workoutId: "run-b" });
    const one = await calculatePerformanceAnalysis(input({ workouts: [a.workout, b.workout], features: [a.feature, b.feature] }));
    const two = await calculatePerformanceAnalysis(input({ workouts: [b.workout, a.workout], features: [b.feature, a.feature] }));
    expect(two).toEqual(one);
  });
  it("excludes a user-excluded source from all evidence", async () => {
    const { workout, feature } = await extracted();
    const result = await calculatePerformanceAnalysis(input({ workouts: [{ ...workout, excluded: true }], features: [feature] }));
    expect(result.completeness.effectiveWorkoutCount).toBe(0);
    expect(result.aerobic.independentWorkoutCount).toBe(0);
    expect(result.preparation.recent.runCount).toBe(0);
  });
  it("missing HR/features does not erase completed-run volume", async () => {
    const result = await calculatePerformanceAnalysis(input({ workouts: [await source({ avgHeartRate: null })] }));
    expect(result.preparation.recent.meters).toBe(5400);
    expect(result.aerobic.status).toBe("insufficient");
    expect(result.completeness.unresolvedWorkoutIds).toEqual(["run-a"]);
  });
  it("incomplete summaries cannot appear complete even when caller coverage claims complete", async () => {
    const result = await calculatePerformanceAnalysis(input({ workouts: [{ ...await source(), completion: "incomplete" }] }));
    expect(result.completeness.effectiveWorkoutCount).toBe(0);
    expect(result.completeness.coverage.workouts).toBe("partial");
    expect(result.preparation.recent.runCount).toBeNull();
  });
  it("an unresolvable running date cannot turn missing evidence into verified zeros", async () => {
    const result = await calculatePerformanceAnalysis(input({ workouts: [{ ...await source(), startedAt: "invalid" }] }));
    expect(result.completeness.coverage.workouts).toBe("partial");
    expect(result.preparation.recent.runCount).toBeNull();
  });
  it("future and out-of-scope conflicts do not alter an as-of calculation", async () => {
    const future = await source({ startDate: new Date("2026-10-22T12:00:00Z"), endDate: new Date("2026-10-22T12:30:00Z") });
    const before = await calculatePerformanceAnalysis(input());
    const after = await calculatePerformanceAnalysis(input({ workouts: [future, { ...future, distanceMeters: 9999 }] }));
    expect(after).toEqual(before);
  });
  it("unused future features and future race links do not change evidence identity", async () => {
    const { workout, feature } = await extracted();
    const before = await calculatePerformanceAnalysis(input());
    const after = await calculatePerformanceAnalysis(input({ features: [feature, { ...feature, parentDigest: "conflict" }], linkedRaces: [{ raceId: "future", workoutId: workout.workoutId, raceDate: "2027-01-01", nominalDistanceMeters: 21097.5, copiedDurationSeconds: null, provenance: workout.provenance, limitations: [] }] }));
    expect(after).toEqual(before);
  });
  it("future workout end and known future availability never enter", async () => {
    const workout = await source();
    const future = { ...workout, workoutId: "future", endedAt: "2026-10-22T12:00:00Z" };
    const later = { ...workout, workoutId: "late", availableAt: "2026-10-21T15:00:00Z" };
    const result = await calculatePerformanceAnalysis(input({ workouts: [future, later] }));
    expect(result.completeness.effectiveWorkoutCount).toBe(0);
  });
  it("rejects nonfinite values before calculation", async () => {
    await expect(calculatePerformanceAnalysis(input({ workouts: [{ ...await source(), distanceMeters: Infinity }] }))).rejects.toThrow();
  });
  it("filters features with no matching effective completed workout", async () => {
    const { feature } = await extracted();
    const result = await calculatePerformanceAnalysis(input({ features: [feature] }));
    expect(result.aerobic.independentWorkoutCount).toBe(0);
  });
  it("does not count many steady windows as independent workouts", async () => {
    const { workout, feature } = await extracted();
    expect(feature.observations.length).toBeGreaterThan(0);
    const result = await calculatePerformanceAnalysis(input({ workouts: [workout], features: [feature] }));
    expect(result.aerobic.independentWorkoutCount).toBe(1);
    expect(result.aerobic.bands[0].speedChangePct).toBeNull();
  });
  it("retains the dated September benchmark, unverified official time and GPS overdistance without VO2", async () => {
    const workout = await source({ startDate: new Date("2026-09-20T12:00:00Z"), endDate: new Date("2026-09-20T14:11:11Z"), durationSeconds: 7871, distanceMeters: 21409 });
    const result = await calculatePerformanceAnalysis(input({ workouts: [workout], linkedRaces: [{ raceId: "synthetic-race", workoutId: workout.workoutId, raceDate: "2026-09-20", nominalDistanceMeters: 21097.5, copiedDurationSeconds: 7871, provenance: workout.provenance, limitations: [] }] }));
    expect(result.demonstratedRaces[0]).toMatchObject({ durationSeconds: 7871, nominalDistanceMeters: 21097.5, recordedDistanceMeters: 21409, raceDate: "2026-09-20", officialChipTimeVerified: false });
    expect(result.deviceVo2.status).toBe("insufficient");
    expect(result.capability).toMatchObject({ estimatedSeconds: null, status: "unavailable" });
  });
  it("surfaces elapsed/copy timing disagreement without speeding up the benchmark", async () => {
    const workout = await source({ startDate: new Date("2026-09-20T12:00:00Z"), endDate: new Date("2026-09-20T14:20:00Z"), durationSeconds: 7871 });
    const result = await calculatePerformanceAnalysis(input({ workouts: [workout], linkedRaces: [{ raceId: "race", workoutId: workout.workoutId, raceDate: "2026-09-20", nominalDistanceMeters: 21097.5, copiedDurationSeconds: 7000, provenance: workout.provenance, limitations: [] }] }));
    expect(result.demonstratedRaces[0]).toMatchObject({ timingAgreement: "discrepant", durationSeconds: 7871 });
  });
  it("linked race observations are excluded from aerobic cohorts", async () => {
    const { workout, feature } = await extracted();
    const result = await calculatePerformanceAnalysis(input({ workouts: [workout], features: [feature], linkedRaces: [{ raceId: "race", workoutId: workout.workoutId, raceDate: "2026-10-18", nominalDistanceMeters: 5000, copiedDurationSeconds: null, provenance: workout.provenance, limitations: [] }] }));
    expect(result.aerobic.independentWorkoutCount).toBe(0);
    expect(result.demonstratedRaces).toHaveLength(1);
  });
  it("changed model and quality versions produce distinct evidence identities", async () => {
    const initial = await calculatePerformanceAnalysis(input());
    const model = await calculatePerformanceAnalysis(input({ versions: { ...versions, model: "manual-v2" } }));
    const quality = await calculatePerformanceAnalysis(input({ versions: { ...versions, qualityPolicy: "observational-v2" }, qualityPolicy: { ...policy, version: "observational-v2" } }));
    expect(new Set([initial.evidenceDigest, model.evidenceDigest, quality.evidenceDigest]).size).toBe(3);
  });
  it("ignores goals and synthetic future prescriptions outside the input contract", async () => {
    const data = input();
    const contaminated = { ...data, goals: { raceSeconds: 6000 }, trainingPlans: [{ speedMps: 9 }] };
    expect(await calculatePerformanceAnalysis(contaminated)).toEqual(await calculatePerformanceAnalysis(data));
  });
  it("changed extraction time alone does not create a scientific snapshot", async () => {
    const { workout, feature } = await extracted();
    const before = await calculatePerformanceAnalysis(input({ workouts: [workout], features: [feature] }));
    const after = await calculatePerformanceAnalysis(input({ workouts: [workout], features: [{ ...feature, extractedAt: "2026-10-21T14:01:00Z" }] }));
    expect(shouldAppendPerformanceSnapshot(before, after)).toBe(false);
    expect(shouldAppendPerformanceSnapshot(null, after)).toBe(true);
  });
  it("a new independent source changes evidence even with identical medians", async () => {
    const a = await extracted(); const b = await extracted({ workoutId: "run-b" });
    const before = await calculatePerformanceAnalysis(input({ workouts: [a.workout], features: [a.feature] }));
    const after = await calculatePerformanceAnalysis(input({ workouts: [a.workout, b.workout], features: [a.feature, b.feature] }));
    expect(shouldAppendPerformanceSnapshot(before, after)).toBe(true);
  });
});

describe("publication drafts and integration boundaries", () => {
  it("preserves explicit calculation and evidence timestamps without inventing a server timestamp", async () => {
    const result = await calculatePerformanceAnalysis(input());
    const draft = buildPerformanceSnapshotPayload({ result, reason: "analyze_new_workouts", calculationStartedAt: asOf, calculationCompletedAt: "2026-10-21T14:00:01.000Z", provenance: [] });
    expect(draft.historyBasis).toBe("actual_calculation");
    expect(draft.evidenceAsOf).toBe(asOf);
    expect(draft).not.toHaveProperty("committedAt");
    expect(draft).not.toHaveProperty("calculatedAt");
    expect(JSON.parse(JSON.stringify(draft)).result.capability.estimatedSeconds).toBeNull();
  });
  it("labels historical reconstruction as reconstruction even if caller selected ordinary update reason", async () => {
    const result = await calculatePerformanceAnalysis(input());
    expect(buildPerformanceSnapshotPayload({ result, reason: "analyze_new_workouts", calculationStartedAt: "2026-10-22T14:00:00Z", calculationCompletedAt: "2026-10-22T14:01:00Z", provenance: [] }).historyBasis).toBe("reconstruction_current_metadata");
  });
  it("labels same-day earlier as-of reconstruction explicitly", async () => {
    const result = await calculatePerformanceAnalysis(input());
    expect(buildPerformanceSnapshotPayload({ result, reason: "analyze_new_workouts", calculationStartedAt: "2026-10-21T18:00:00Z", calculationCompletedAt: "2026-10-21T18:01:00Z", provenance: [] }).historyBasis).toBe("reconstruction_current_metadata");
  });
  it("rejects out-of-order calculation timestamps", async () => {
    const result = await calculatePerformanceAnalysis(input());
    expect(() => buildPerformanceSnapshotPayload({ result, reason: "analyze_new_workouts", calculationStartedAt: asOf, calculationCompletedAt: "2026-10-20T14:00:00Z", provenance: [] })).toThrow();
  });
  it("performs no network activity and requires no auth/session", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Forbidden IO"));
    try { await calculatePerformanceAnalysis(input()); expect(network).not.toHaveBeenCalled(); }
    finally { network.mockRestore(); }
  });
  it("has no runtime imports from Firebase, auth, pages, enrichment, legacy predictors or service modules", () => {
    const files = ["performanceEvidence", "performanceAnalysis", "aerobicPerformance", "endurancePreparation", "deviceVo2Trend"];
    for (const name of files) {
      const source = readFileSync(resolve(process.cwd(), `src/utils/${name}.ts`), "utf8");
      const imports = [...source.matchAll(/(?:import|export)\s+(?!type\b)[\s\S]*?from\s+["']([^"']+)["']/g)].map(match => match[1]);
      expect(imports.some(path => /firebase|services\/|contexts\/|hooks\/|app\/|racePrediction|riegel|enrich/i.test(path))).toBe(false);
      expect(source).not.toMatch(/\b(?:fetch|setInterval|setTimeout)\s*\(|Date\.now\s*\(|new Date\(\)/);
    }
  });
  it("binds compact features to exact input values", async () => {
    const { workout, feature } = await extracted();
    expect(feature.sourceInputDigest).toBe(await buildWorkoutInputDigest(workout));
    expect(JSON.stringify(feature)).not.toContain("intervals");
  });
});
