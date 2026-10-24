import { describe, expect, it } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { RacePerformanceConfirmation, RacePerformanceInput } from "@/types/racePerformance";
import type { WorkoutOverride } from "@/types/workoutOverride";
import {
  DEFAULT_RACE_PERFORMANCE_POLICY, HALF_MARATHON_METERS, buildRaceEvidence,
  evaluateRacePerformance, nominalRaceDistanceMeters, parseRaceResultSeconds,
  researchRiegelSeconds, researchVdotSeconds,
} from "@/utils/racePerformance";

const asOf = "2026-06-20T16:00:00.000Z";
const timeZone = "America/New_York";
const finishSeconds = 7200;

function workout(fields: Partial<HealthWorkout> = {}): HealthWorkout {
  return { workoutId: "run-a", name: "Run", activityType: "running", displayType: "Run",
    startDate: new Date("2026-06-01T12:00:00.000Z"), endDate: new Date("2026-06-01T14:00:00.000Z"),
    durationSeconds: finishSeconds, sourceName: "synthetic-watch", isRunLike: true, hasRoute: false,
    syncedAt: new Date("2026-06-01T15:00:00.000Z"), calories: 500, avgHeartRate: null,
    distanceMiles: HALF_MARATHON_METERS / 1609.344, distanceMeters: HALF_MARATHON_METERS,
    avgPaceSecPerMile: null, avgSpeedMPS: null, hrDriftPct: null, cadenceSPM: null,
    efficiencyRaw: null, efficiencyScore: null, elevationGainM: null, ...fields };
}
function confirmation(fields: Partial<RacePerformanceConfirmation> = {}): RacePerformanceConfirmation {
  return { status: "verified", kind: "official_race", knownAt: "2026-06-02T16:00:00.000Z",
    raceDate: "2026-06-01", distanceMeters: HALF_MARATHON_METERS, finishSeconds,
    effort: "maximal", conditions: "Level road course, mild weather", source: "https://example.test/official-result", ...fields };
}
function race(fields: Partial<Race> = {}): Race {
  return { id: "race-a", name: "Synthetic half", raceDate: "2026-06-01", raceDistance: "halfMarathon",
    isActive: false, createdAt: "2026-05-01T16:00:00.000Z", actualRunId: "run-a",
    actualRunDate: "2026-06-01", actualRunDurationSeconds: finishSeconds, ...fields };
}
function input(fields: Partial<RacePerformanceInput> = {}): RacePerformanceInput {
  return { races: [race()], workouts: [workout()], asOf, timeZone, ...fields };
}
function override(fields: Partial<WorkoutOverride> = {}): WorkoutOverride {
  return { workoutId: "run-a", userId: "synthetic", isExcluded: false, excludedAt: null, excludedReason: null,
    distanceMilesOverride: null, durationSecondsOverride: null, runTypeOverride: null,
    updatedAt: "2026-06-02T16:00:00.000Z", ...fields };
}

describe("Phase 3A race evidence hierarchy", () => {
  it("displays verified same-distance time directly without claiming current or future fitness", () => {
    const result = evaluateRacePerformance(input({ races: [race({ performanceEvidence: confirmation() })] }));
    expect(result.latestBenchmark).toMatchObject({ finishSeconds, status: "verified", tier: "official_result", eligibleSameDistanceBenchmark: true });
    expect(result.currentCapability).toEqual({ status: "unavailable", estimatedSeconds: null, confidenceInterval: null, reason: "no_validated_estimator" });
    expect(result.raceDayForecast).toEqual({ status: "unavailable", estimatedSeconds: null, confidenceInterval: null, reason: "no_validated_forecast" });
    expect(result.researchEquivalences).toEqual([]);
  });
  it("keeps a consistent linked workout provisional without upgrading to official or maximal", () => {
    const result = evaluateRacePerformance(input());
    expect(result.latestBenchmark).toMatchObject({ finishSeconds, status: "recorded_unverified", timingAgreement: "consistent", effort: "unknown", eligibleSameDistanceBenchmark: false });
    expect(result.latestBenchmark?.reasons).toContain("official_result_and_effort_unverified");
    expect(result.researchEquivalences).toEqual([]);
  });
  it("supports an explicit owner-confirmed time trial after evidence checks", () => {
    const result = evaluateRacePerformance(input({ races: [race({ performanceEvidence: confirmation({ status: "owner_confirmed", kind: "time_trial", source: "Owner confirmed time, date, distance, effort and conditions" }) })] }));
    expect(result.latestBenchmark).toMatchObject({ status: "owner_confirmed", tier: "confirmed_race_or_time_trial", eligibleSameDistanceBenchmark: true });
  });
  it("retains an official observation without requiring a GPS workout", () => {
    const result = evaluateRacePerformance(input({ races: [race({ actualRunId: undefined, performanceEvidence: confirmation() })], workouts: [] }));
    expect(result.latestBenchmark).toMatchObject({ finishSeconds, status: "verified", timingBasis: "confirmed_result", eligibleSameDistanceBenchmark: true });
  });
  it("marks entered results as unverified even if they look precise", () => {
    const result = evaluateRacePerformance(input({ races: [race({ actualRunId: undefined, result: "2:00:00" })], workouts: [] }));
    expect(result.latestBenchmark).toMatchObject({ status: "recorded_unverified", finishSeconds, timingBasis: "unverified_entered_result", eligibleForEquivalence: false });
  });
  it("rejects April-style duration versus elapsed discrepancies", () => {
    const result = evaluateRacePerformance(input({ workouts: [workout({ endDate: new Date("2026-06-01T14:11:00.000Z") })] }));
    expect(result.evidence[0]).toMatchObject({ status: "inconsistent", durationSeconds: 7200, elapsedSeconds: 7860, timingAgreement: "discrepant", eligibleForEquivalence: false });
    expect(result.latestBenchmark).toBeNull();
  });
  it("requires explicit official reconciliation before accepting discrepant workout timing", () => {
    const fields = { races: [race({ performanceEvidence: confirmation() })], workouts: [workout({ endDate: new Date("2026-06-01T14:11:00.000Z") })] };
    expect(evaluateRacePerformance(input(fields)).latestBenchmark).toBeNull();
    const result = evaluateRacePerformance(input({ ...fields, races: [race({ performanceEvidence: confirmation({ timingReconciliation: "Official chip time confirmed; watch included a stopped interval" }) })] }));
    expect(result.latestBenchmark).toMatchObject({ finishSeconds, timingAgreement: "reconciled", status: "verified" });
  });
  it("rejects a linked workout on the wrong local date", () => {
    const result = evaluateRacePerformance(input({ workouts: [workout({ startDate: new Date("2026-06-02T12:00:00.000Z"), endDate: new Date("2026-06-02T14:00:00.000Z") })] }));
    expect(result.evidence[0].reasons).toContain("race_workout_date_or_type_mismatch");
    expect(result.latestBenchmark).toBeNull();
  });
  it("rejects a nonrunning linked workout", () => {
    expect(evaluateRacePerformance(input({ workouts: [workout({ isRunLike: false })] })).evidence[0].status).toBe("inconsistent");
  });
  it("rejects wrong distance rather than scaling GPS distance into a faster time", () => {
    const result = evaluateRacePerformance(input({ workouts: [workout({ distanceMeters: 10_000, distanceMiles: 10_000 / 1609.344 })] }));
    expect(result.evidence[0].reasons).toContain("race_workout_distance_mismatch");
    expect(result.latestBenchmark).toBeNull();
  });
  it("never normalizes an overlong GPS recording to a faster nominal race time", () => {
    const result = evaluateRacePerformance(input({ workouts: [workout({ distanceMeters: HALF_MARATHON_METERS * 1.03 })] }));
    expect(result.latestBenchmark?.finishSeconds).toBe(finishSeconds);
    expect(result.latestBenchmark?.distanceMeters).toBe(HALF_MARATHON_METERS);
  });
  it("does not turn ordinary fast training runs into race evidence", () => {
    expect(evaluateRacePerformance(input({ races: [] })).evidence).toEqual([]);
    expect(evaluateRacePerformance(input({ races: [] })).latestBenchmark).toBeNull();
  });
  it("excludes an explicitly nonmaximal result from benchmarks and equivalences", () => {
    const result = evaluateRacePerformance(input({ races: [race({ performanceEvidence: confirmation({ effort: "nonmaximal" }) })] }));
    expect(result.evidence[0]).toMatchObject({ effort: "nonmaximal", eligibleForEquivalence: false });
    expect(result.historicalBenchmarks).toEqual([]);
    expect(result.latestBenchmark).toBeNull();
  });
  it("withholds equivalence without confirmed conditions", () => {
    const evidence = buildRaceEvidence(input({ races: [race({ performanceEvidence: confirmation({ conditions: null }) })] }))[0];
    expect(evidence.eligibleForEquivalence).toBe(false);
    expect(evidence.reasons).toContain("conditions_not_confirmed");
  });
  it("does not attach confirmed results to a different race identity", () => {
    const evidence = buildRaceEvidence(input({ races: [race({ performanceEvidence: confirmation({ raceDate: "2026-05-31" }) })] }))[0];
    expect(evidence.status).toBe("inconsistent");
    expect(evidence.reasons).toContain("confirmation_race_identity_mismatch");
  });
  it("preserves a stale verified observation as history with an explicit age", () => {
    const result = evaluateRacePerformance(input({ races: [race({ performanceEvidence: confirmation() })], asOf: "2026-10-01T16:00:00.000Z" }));
    expect(result.latestBenchmark).toMatchObject({ stale: true, ageDays: 122, finishSeconds, eligibleSameDistanceBenchmark: true });
    expect(result.currentCapability.estimatedSeconds).toBeNull();
  });
  it("selects the latest eligible same-distance observation deterministically", () => {
    const earlier = race({ id: "earlier", actualRunId: undefined, raceDate: "2026-05-01", performanceEvidence: confirmation({ raceDate: "2026-05-01", finishSeconds: 7300 }) });
    const later = race({ id: "later", performanceEvidence: confirmation() });
    const first = evaluateRacePerformance(input({ races: [later, earlier] }));
    const second = evaluateRacePerformance(input({ races: [earlier, later] }));
    expect(first).toEqual(second);
    expect(first.latestBenchmark?.raceId).toBe("later");
    expect(first.historicalBenchmarks.map(e => e.raceId)).toEqual(["earlier", "later"]);
  });
  it("prefers verified official evidence over a newer owner-confirmed time trial", () => {
    const official = race({ id: "official", actualRunId: undefined, raceDate: "2026-05-01",
      performanceEvidence: confirmation({ raceDate: "2026-05-01", finishSeconds: 7300 }) });
    const trial = race({ performanceEvidence: confirmation({ status: "owner_confirmed", kind: "time_trial" }) });
    const result = evaluateRacePerformance(input({ races: [trial, official] }));
    expect(result.latestBenchmark?.raceId).toBe("official");
    expect(result.historicalBenchmarks.map(e => e.raceId)).toEqual(["official", "race-a"]);
  });
  it("prefers a confirmed race over a newer specifically identified high effort", () => {
    const confirmedRace = race({ id: "confirmed-race", actualRunId: undefined, raceDate: "2026-05-01",
      performanceEvidence: confirmation({ raceDate: "2026-05-01", status: "owner_confirmed", kind: "race", finishSeconds: 7300 }) });
    const effort = race({ performanceEvidence: confirmation({ status: "owner_confirmed", kind: "high_effort" }) });
    expect(evaluateRacePerformance(input({ races: [effort, confirmedRace] })).latestBenchmark?.raceId).toBe("confirmed-race");
  });
  it("abstains for missing results rather than fabricating zero or a flat forecast", () => {
    const result = evaluateRacePerformance(input({ races: [race({ actualRunId: undefined })], workouts: [] }));
    expect(result.latestBenchmark).toBeNull();
    expect(result.evidence[0].status).toBe("insufficient_evidence");
    expect(result.currentCapability.estimatedSeconds).toBeNull();
    expect(result.raceDayForecast.estimatedSeconds).toBeNull();
  });
  it("removes excluded linked workouts and refuses an excluded numerical benchmark", () => {
    const result = evaluateRacePerformance(input({ overrides: { "run-a": override({ isExcluded: true }) } }));
    expect(result.latestBenchmark).toBeNull();
    expect(result.evidence[0].reasons).toContain("linked_workout_excluded");
  });
  it("collapses identical duplicates and rejects conflicting duplicates independent of order", () => {
    expect(evaluateRacePerformance(input({ workouts: [workout(), workout()] })).latestBenchmark?.finishSeconds).toBe(finishSeconds);
    const one = input({ workouts: [workout(), workout({ durationSeconds: 6000 })] });
    expect(buildRaceEvidence(one)[0]).toMatchObject({ status: "inconsistent", eligibleForEquivalence: false });
    expect(buildRaceEvidence({ ...one, workouts: [...one.workouts].reverse() })[0].status).toBe("inconsistent");
  });
  it("rejects linking one workout to two race identities", () => {
    const result = evaluateRacePerformance(input({ races: [race(), race({ id: "second-race" })] }));
    expect(result.evidence.every(e => e.status === "inconsistent")).toBe(true);
    expect(result.latestBenchmark).toBeNull();
  });
  it("uses canonical overrides without mutating the parent workout", () => {
    const original = workout({ distanceMeters: 10_000, distanceMiles: 10_000 / 1609.344 });
    const result = evaluateRacePerformance(input({ workouts: [original], overrides: { "run-a": override({ distanceMilesOverride: HALF_MARATHON_METERS / 1609.344 }) } }));
    expect(result.latestBenchmark?.recordedDistanceMeters).toBeCloseTo(HALF_MARATHON_METERS);
    expect(original.distanceMeters).toBe(10_000);
  });
});

describe("known-then evaluation and local dates", () => {
  it("uses local calendar date even when UTC date is already the next day", () => {
    const result = evaluateRacePerformance(input({ workouts: [workout({ startDate: new Date("2026-06-02T01:00:00.000Z"), endDate: new Date("2026-06-02T03:00:00.000Z"), syncedAt: new Date("2026-06-02T04:00:00.000Z") })] }));
    expect(result.latestBenchmark).toMatchObject({ raceDate: "2026-06-01", timingAgreement: "consistent" });
  });
  it("does not include a race on tomorrow's local date", () => {
    expect(evaluateRacePerformance(input({ races: [race({ raceDate: "2026-06-21" })] })).evidence).toEqual([]);
  });
  it("strict retrospective evaluation abstains on unknown legacy revision timing", () => {
    const result = evaluateRacePerformance(input({ asOfMode: "historical" }));
    expect(result.latestBenchmark).toBeNull();
    expect(result.evidence[0].reasons).toContain("unversioned_race_metadata");
    expect(result.evidence[0].availableAsOf).toBe(false);
  });
  it("accepts explicit confirmed evidence already known before the cutoff", () => {
    const result = evaluateRacePerformance(input({ asOfMode: "historical", races: [race({ performanceEvidence: confirmation() })] }));
    expect(result.latestBenchmark?.eligibleSameDistanceBenchmark).toBe(true);
  });
  it("does not leak a later correction, effort confirmation or status into a historical baseline", () => {
    const result = evaluateRacePerformance(input({ asOfMode: "historical", races: [race({ result: "1:55:00", performanceEvidence: confirmation({ knownAt: "2026-06-21T16:00:00.000Z", finishSeconds: 6900 }) })] }));
    expect(result.latestBenchmark).toBeNull();
    expect(result.researchEquivalences).toEqual([]);
    expect(result.evidence[0]).toMatchObject({ knownAt: null, effort: "unknown", availableAsOf: false, eligibleForEquivalence: false });
  });
  it("rejects confirmation timestamps before the performance occurred", () => {
    const result = evaluateRacePerformance(input({ races: [race({ performanceEvidence: confirmation({ knownAt: "2026-05-31T16:00:00.000Z" }) })] }));
    expect(result.evidence[0].eligibleForEquivalence).toBe(false);
    expect(result.evidence[0].reasons).toContain("invalid_confirmation");
  });
  it("rejects parent revisions synchronized after the historical cutoff", () => {
    const result = evaluateRacePerformance(input({ asOfMode: "historical", races: [race({ performanceEvidence: confirmation() })], workouts: [workout({ syncedAt: new Date("2026-06-21T16:00:00.000Z") })] }));
    expect(result.latestBenchmark).toBeNull();
    expect(result.evidence[0].reasons).toContain("workout_not_available_as_of");
  });
  it("does not apply a later override to a numerical historical baseline", () => {
    const result = evaluateRacePerformance(input({ asOfMode: "historical", races: [race({ performanceEvidence: confirmation() })], overrides: { "run-a": override({ updatedAt: "2026-06-21T16:00:00.000Z", durationSecondsOverride: 7190 }) } }));
    expect(result.latestBenchmark).toBeNull();
  });
  it("requires completed workouts instead of including the future part of race day", () => {
    const result = evaluateRacePerformance(input({ asOf: "2026-06-01T13:00:00.000Z" }));
    expect(result.latestBenchmark).toBeNull();
    expect(result.evidence[0].availableAsOf).toBe(false);
  });
  it("does not read route flags, GPS splits or HR stream fields", () => {
    const parent = workout();
    for (const key of ["hasRoute", "hasHRStream", "mileSplits", "bestEfforts"]) Object.defineProperty(parent, key, { get() { throw new Error(`Unexpected child-dependent field: ${key}`); } });
    expect(() => evaluateRacePerformance(input({ workouts: [parent] }))).not.toThrow();
  });
});

describe("research-only distance equivalences", () => {
  it("evaluates fixed Riegel and VDOT style equivalence only for qualifying cross-distance evidence", () => {
    const confirmedTenK = race({ raceDistance: "10K", actualRunId: undefined, actualRunDurationSeconds: undefined,
      performanceEvidence: confirmation({ distanceMeters: 10_000, finishSeconds: 3300 }) });
    const result = evaluateRacePerformance(input({ races: [confirmedTenK], workouts: [] }));
    expect(result.researchEquivalences.map(e => e.method)).toEqual(["riegel_fixed_1_06", "vdot_style"]);
    expect(result.researchEquivalences.every(e => e.purpose === "research_only" && e.equivalentSeconds > 6900 && e.equivalentSeconds < 7500)).toBe(true);
    expect(result.latestBenchmark).toBeNull();
    expect(result.currentCapability.estimatedSeconds).toBeNull();
    expect(result.raceDayForecast.estimatedSeconds).toBeNull();
  });
  it("matches fixed Riegel's dimensional identity and independent 5K to 10K golden calculation", () => {
    expect(researchRiegelSeconds(1200, 5000, 5000)).toBe(1200);
    expect(researchRiegelSeconds(1200, 5000, 10000)).toBeCloseTo(2501.917825, 5);
  });
  it("keeps VDOT same-distance identity and reciprocal equivalence numerically stable", () => {
    expect(researchVdotSeconds(1200, 5000, 5000)).toBeCloseTo(1200, 7);
    const tenK = researchVdotSeconds(1200, 5000, 10000)!;
    expect(tenK).toBeGreaterThan(2480);
    expect(tenK).toBeLessThan(2510);
    expect(researchVdotSeconds(tenK, 10000, 5000)).toBeCloseTo(1200, 7);
  });
  it.each([0, -1, NaN, Infinity])("abstains on invalid equivalence inputs %s", value => {
    expect(researchRiegelSeconds(value, 5000, HALF_MARATHON_METERS)).toBeNull();
    expect(researchVdotSeconds(1200, value, HALF_MARATHON_METERS)).toBeNull();
  });
  it("abstains outside the VDOT numerical domain", () => {
    expect(researchVdotSeconds(180, 800, HALF_MARATHON_METERS)).toBeNull();
    expect(researchVdotSeconds(22000, 42195, 5000)).toBeNull();
  });
  it("does not allow policy edits to authorize an unvalidated numerical estimate", () => {
    expect(() => evaluateRacePerformance(input({ policy: { ...DEFAULT_RACE_PERFORMANCE_POLICY, currentEstimator: "validated" as "unvalidated" } }))).toThrow("unsupported race performance policy");
  });
  it("uses exact nominal standard distances rather than rounded GPS or mile labels", () => {
    expect(nominalRaceDistanceMeters({ raceDistance: "halfMarathon" })).toBe(21097.5);
    expect(nominalRaceDistanceMeters({ raceDistance: "10K" })).toBe(10000);
    expect(nominalRaceDistanceMeters({ raceDistance: "custom", customDistanceMiles: 10 })).toBe(16093.44);
  });
  it.each([["2:00:00", 7200], ["59:59", 3599], ["2:99:00", null], ["1:00:99", null], ["not a time", null], ["0:00", null]])("parses entered result %s strictly", (text, expected) => {
    expect(parseRaceResultSeconds(text as string)).toBe(expected);
  });
});
