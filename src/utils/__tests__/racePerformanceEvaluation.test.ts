import { describe, expect, it } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { evaluateRacePerformanceHistory, raceEvaluationCutoff } from "@/utils/racePerformanceEvaluation";
import { HALF_MARATHON_METERS } from "@/utils/racePerformance";

const asOf = "2026-10-23T16:00:00.000Z";
function race(id: string, date: string, seconds: number, fields: Partial<Race> = {}): Race {
  return { id, name: id, raceDate: date, raceDistance: "halfMarathon", isActive: false, createdAt: "2025-01-01T00:00:00.000Z",
    performanceEvidence: { status: "verified", kind: "official_race", knownAt: `${date}T20:00:00.000Z`, raceDate: date,
      distanceMeters: HALF_MARATHON_METERS, finishSeconds: seconds, effort: "maximal", conditions: "Flat course, mild conditions", source: "Owner-provided official result" },
    ...fields };
}
function evaluate(races: Race[], workouts: HealthWorkout[] = [], overrides?: Record<string, WorkoutOverride>) {
  return evaluateRacePerformanceHistory({ races, workouts, overrides, asOf, timeZone: "America/New_York" });
}
function row(result: ReturnType<typeof evaluate>, id: string, method = "recent_same_distance") {
  return result.cases.find((item) => item.targetRaceId === id && item.method === method)!;
}

describe("chronological race research evaluation", () => {
  it("evaluates only prior known same-distance results and reports signed/absolute/large errors and abstentions", () => {
    const report = evaluate([race("first", "2026-04-26", 8100), race("second", "2026-09-20", 7800)]);
    expect(row(report, "first").predictedSeconds).toBeNull();
    expect(row(report, "second")).toMatchObject({ predictedSeconds: 8100, signedErrorSeconds: 300, absoluteErrorSeconds: 300, largeError: true });
    expect(report.methods.recent_same_distance).toMatchObject({ attempts: 2, predictions: 1, abstentions: 1, abstentionRate: 0.5,
      meanAbsoluteErrorSeconds: 300, meanSignedErrorSeconds: 300, largeErrors: 1 });
  });

  it("never backdates a corrected confirmation that became known after the target", () => {
    const old = race("old", "2026-04-26", 7000);
    old.performanceEvidence!.knownAt = "2026-10-01T00:00:00.000Z";
    const report = evaluate([old, race("target", "2026-09-20", 7800)]);
    expect(row(report, "target").predictedSeconds).toBeNull();
    expect(row(report, "target").eligiblePriorRaces).toBe(0);
  });

  it("does not use later races or another result from the target's own local race day", () => {
    const report = evaluate([race("same-day", "2026-09-20", 7600), race("target", "2026-09-20", 7800), race("later", "2026-10-01", 7700)]);
    expect(row(report, "target").predictedSeconds).toBeNull();
    expect(row(report, "later").eligiblePriorRaces).toBe(2);
  });

  it("evaluates Riegel and VDOT only from a qualifying different-distance maximal result", () => {
    const tenK = race("10K", "2026-08-01", 3600, { raceDistance: "10K" });
    tenK.performanceEvidence!.distanceMeters = 10_000;
    const report = evaluate([tenK, race("target", "2026-09-20", 8000)]);
    expect(row(report, "target").predictedSeconds).toBeNull();
    expect(row(report, "target", "riegel_fixed_1_06").predictedSeconds).toBeCloseTo(3600 * (HALF_MARATHON_METERS / 10_000) ** 1.06);
    expect(row(report, "target", "vdot_style").predictedSeconds).toBeGreaterThan(7200);
    expect(row(report, "target", "vdot_style").sourceRaceId).toBe("10K");
  });

  it("excludes unverified outcomes and shows the verification and age sample limitations", () => {
    const owner = race("owner", "2026-01-01", 8100);
    owner.performanceEvidence!.status = "owner_confirmed";
    const report = evaluate([owner, race("target", "2026-09-20", 7800), race("unverified", "2026-08-01", 7700, { performanceEvidence: undefined, result: "2:08:20" })]);
    expect(report.eligibleOutcomeCount).toBe(2);
    expect(report.evidenceStatusCounts.recorded_unverified).toBe(1);
    expect(report.verificationSensitivity[0].methods.recent_same_distance.predictions).toBe(0);
    expect(report.verificationSensitivity[1].methods.recent_same_distance.predictions).toBe(1);
    expect(report.raceAgeSensitivity[2].methods.recent_same_distance.predictions).toBe(1);
    expect(report.limitations.some((text) => text.includes("Only 2"))).toBe(true);
  });

  it("reports unavailable metrics rather than zero error or zero abstention for an empty labeled sample", () => {
    const report = evaluate([]);
    expect(report.eligibleOutcomeCount).toBe(0);
    expect(report.methods.recent_same_distance).toMatchObject({ attempts: 0, abstentionRate: null, meanAbsoluteErrorSeconds: null });
    expect(report.limitations.some((text) => text.includes("No race identity"))).toBe(true);
  });

  it("reproduces a summary-only legacy comparator and ignores later workouts and corrections", () => {
    const workouts = [4, 5, 6, 7].map((miles, index) => {
      const startDate = new Date(`2026-09-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`);
      return { workoutId: `w${index}`, isRunLike: true, activityType: "running", distanceMiles: miles, durationSeconds: miles * 600,
        startDate, endDate: new Date(startDate.getTime() + miles * 600_000), syncedAt: new Date(startDate.getTime() + miles * 600_000 + 1000), sourceName: "Watch" } as HealthWorkout;
    });
    const target = race("target", "2026-09-20", 7800);
    const base = evaluate([target], workouts);
    expect(row(base, "target", "legacy_summary_only").predictedSeconds).not.toBeNull();
    const duplicate = { ...workouts[0], workoutId: "copy" };
    expect(row(evaluate([target], [...workouts.slice(0, 3), duplicate]), "target", "legacy_summary_only").predictedSeconds).toBeNull();
    expect(row(evaluate([target], [...workouts, duplicate]), "target", "legacy_summary_only").predictedSeconds)
      .toBe(row(base, "target", "legacy_summary_only").predictedSeconds);
    expect(row(evaluate([target], [...workouts, { ...workouts[0], durationSeconds: 3000 }]), "target", "legacy_summary_only").predictedSeconds).toBeNull();
    const future = { ...workouts[0], workoutId: "future", startDate: new Date("2026-09-21T12:00:00.000Z"), endDate: new Date("2026-09-21T13:00:00.000Z"), syncedAt: new Date("2026-09-21T14:00:00.000Z"), durationSeconds: 1000 };
    expect(row(evaluate([target], [...workouts, future]), "target", "legacy_summary_only").predictedSeconds)
      .toBe(row(base, "target", "legacy_summary_only").predictedSeconds);
    const laterOverrides = { w0: { workoutId: "w0", updatedAt: "2026-10-01T00:00:00.000Z", distanceMilesOverride: 20 } as WorkoutOverride };
    expect(row(evaluate([target], workouts, laterOverrides), "target", "legacy_summary_only").predictedSeconds).toBeNull();
  });

  it("withholds legacy comparison for unknown parent availability or conflicting revisions", () => {
    const target = race("target", "2026-09-20", 7800);
    expect(row(evaluate([target], [{ workoutId: "unknown", isRunLike: true, startDate: new Date("2026-09-01"), endDate: new Date("2026-09-01T01:00:00.000Z") } as HealthWorkout]), "target", "legacy_summary_only").predictedSeconds).toBeNull();
  });

  it("resolves exact local pre-race cutoffs in Eastern, DST, and extreme positive offsets", () => {
    expect(raceEvaluationCutoff("2026-09-20", "America/New_York")).toBe("2026-09-20T03:59:59.999Z");
    expect(raceEvaluationCutoff("2026-03-09", "America/New_York")).toBe("2026-03-09T03:59:59.999Z");
    expect(raceEvaluationCutoff("2026-09-20", "Pacific/Kiritimati")).toBe("2026-09-19T09:59:59.999Z");
  });
});
