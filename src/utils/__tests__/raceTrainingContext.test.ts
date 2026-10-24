import { describe, expect, it } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { PlannedRunEntry, RunningPlan } from "@/types/plan";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { buildRaceTrainingContext } from "@/utils/raceTrainingContext";

const asOf = new Date("2026-10-23T16:00:00.000Z");
function run(id: string, date: string, miles = 5, fields: Partial<HealthWorkout> = {}): HealthWorkout {
  const startDate = new Date(`${date}T12:00:00.000Z`);
  return {
    workoutId: id, name: "Run", displayType: "Run", activityType: "running", isRunLike: true,
    startDate, endDate: new Date(startDate.getTime() + miles * 600_000), syncedAt: new Date(startDate.getTime() + miles * 600_000 + 1000),
    distanceMiles: miles, distanceMeters: miles * 1609.344, durationSeconds: miles * 600,
    sourceName: "Watch", hasRoute: true, calories: 0, avgHeartRate: null, avgPaceSecPerMile: 600,
    avgSpeedMPS: null, hrDriftPct: null, cadenceSPM: null, efficiencyRaw: null, efficiencyScore: null, elevationGainM: null,
    ...fields,
  };
}
function override(id: string, fields: Partial<WorkoutOverride>): WorkoutOverride {
  return { workoutId: id, userId: "owner", isExcluded: false, excludedAt: null, excludedReason: null,
    distanceMilesOverride: null, durationSecondsOverride: null, runTypeOverride: null,
    updatedAt: "2026-10-22T12:00:00.000Z", ...fields };
}
function entry(id: string, weekIndex: number, weekday: number, fields: Partial<PlannedRunEntry> = {}): PlannedRunEntry {
  return { id, weekIndex, weekday, dayOfWeek: weekday - 1, distanceMiles: 5, runType: "outdoor", ...fields };
}
function plan(entries: PlannedRunEntry[]): RunningPlan {
  return { id: "p", name: "Plan", startDate: "2026-10-05", weeks: [{ weekNumber: 1, entries }],
    status: "active", isActive: true, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
}
function summarize(workouts: HealthWorkout[], fields: Partial<Parameters<typeof buildRaceTrainingContext>[0]> = {}) {
  return buildRaceTrainingContext({ workouts, asOf, timeZone: "America/New_York", ...fields });
}

describe("race training context", () => {
  it("describes mileage, sessions, durations, long-run frequency and progression without time credits", () => {
    const result = summarize([run("prior", "2026-09-05", 7), run("a", "2026-10-04", 6), run("b", "2026-10-21", 9)]);
    expect(result.recentFourWeeks).toMatchObject({ startDate: "2026-09-26", endDate: "2026-10-23", miles: 15, sessions: 2, durationSeconds: 9000 });
    expect(result.priorFourWeeks).toMatchObject({ startDate: "2026-08-29", endDate: "2026-09-25", miles: 7, sessions: 1 });
    expect(result.mileageChangePct).toBeCloseTo((15 / 7 - 1) * 100);
    expect(result.longestRecentRun).toMatchObject({ workoutId: "b", miles: 9 });
    expect(result.longRuns).toMatchObject({ recentCount: 2, priorCount: 1, progressionMiles: 2 });
    expect(result.recentDurations).toHaveLength(2);
    expect(result).not.toHaveProperty("predictedSeconds");
  });

  it("uses canonical exclusions and absolute overrides and collapses identical duplicate IDs", () => {
    const a = run("a", "2026-10-21");
    const result = summarize([a, { ...a }, run("excluded", "2026-10-22"), run("nonrun", "2026-10-19", 8, { isRunLike: false })], {
      overrides: { a: override("a", { distanceMilesOverride: 8, durationSecondsOverride: 5000 }), excluded: override("excluded", { isExcluded: true }) },
    });
    expect(result.recentFourWeeks).toMatchObject({ miles: 8, sessions: 1, durationSeconds: 5000 });
    expect(a.distanceMiles).toBe(5);
  });

  it("counts exact duplicate activities with different IDs once and excludes conflicting same-ID records", () => {
    const a = run("a", "2026-10-21");
    const result = summarize([a, { ...a, workoutId: "copy" }, run("conflict", "2026-10-20"), run("conflict", "2026-10-20", 7)]);
    expect(result.recentFourWeeks.sessions).toBe(1);
    expect(result.limitations.some((text) => text.includes("Conflicting"))).toBe(true);
  });

  it("excludes future, in-progress, invalid, late-synced and later-corrected summaries", () => {
    const result = summarize([
      run("future", "2026-10-24"), run("open", "2026-10-23", 5, { endDate: new Date("2026-10-23T17:00:00.000Z") }),
      run("invalid", "2026-10-22", 5, { distanceMiles: Number.NaN }),
      run("late", "2026-10-21", 5, { syncedAt: new Date("2026-10-24T00:00:00.000Z") }), run("corrected", "2026-10-20"),
    ], { overrides: { corrected: override("corrected", { updatedAt: "2026-10-24T00:00:00.000Z", distanceMilesOverride: 10 }) } });
    expect(result.recentFourWeeks.sessions).toBe(0);
  });

  it("uses the requested local day across UTC midnight and Monday boundaries", () => {
    const sunday = run("sunday", "2026-10-18", 2, { startDate: new Date("2026-10-19T01:00:00.000Z"), endDate: new Date("2026-10-19T01:20:00.000Z") });
    const monday = run("monday", "2026-10-19", 3, { startDate: new Date("2026-10-19T04:00:00.000Z"), endDate: new Date("2026-10-19T04:30:00.000Z") });
    const result = summarize([sunday, monday]);
    expect(result.weekly.find((week) => week.weekStart === "2026-10-12")?.miles).toBe(2);
    expect(result.weekly.find((week) => week.weekStart === "2026-10-19")?.miles).toBe(3);
    expect(result.weekly.at(-1)?.partialWeek).toBe(true);
    expect(result.weekly).toHaveLength(8);
  });

  it("keeps Monday weeks and target-day arithmetic intact across DST", () => {
    const result = summarize([run("dst", "2026-03-08"), run("next", "2026-03-09")], {
      asOf: new Date("2026-03-09T20:00:00.000Z"), targetRaceDate: "2026-03-20",
    });
    expect(result.daysToTargetRace).toBe(11);
    expect(result.weekly.at(-2)).toMatchObject({ weekStart: "2026-03-02", miles: 5 });
    expect(result.weekly.at(-1)).toMatchObject({ weekStart: "2026-03-09", miles: 5 });
  });

  it("returns unavailable comparisons for insufficient history and no invented long runs", () => {
    const result = summarize([], { targetRaceDate: "2027-03-20" });
    expect(result.mileageChangePct).toBeNull();
    expect(result.longestRecentRun).toBeNull();
    expect(result.longRuns.progressionMiles).toBeNull();
    expect(result.consistency.fraction).toBeNull();
    expect(result.planAdherence).toBeNull();
    expect(result.daysToTargetRace).toBe(148);
  });

  it("counts partial canonical plan matches as completed while excluding future entries", () => {
    const result = summarize([run("partial", "2026-10-05", 2)], { plan: plan([
      entry("due", 0, 1), entry("missed", 1, 1), entry("future", 4, 1, { distanceMiles: 20 }),
    ]) });
    expect(result.planAdherence).toMatchObject({ plannedSessions: 2, completedSessions: 1, completionFraction: 0.5, plannedMiles: 10, actualMiles: 2 });
  });

  it("requires full same-day explicit faster intent and never infers it from fast pace", () => {
    const result = summarize([
      run("tempo", "2026-10-05"), run("partial", "2026-10-07", 2), run("ordinary", "2026-10-09", 5, { durationSeconds: 1500 }),
      run("offset", "2026-10-13"),
    ], { plan: plan([
      entry("tempo", 0, 1, { workoutType: "tempo" }), entry("partial", 0, 3, { workoutType: "tempo" }),
      entry("ordinary", 0, 5), entry("offset", 1, 1, { workoutType: "tempo" }),
    ]) });
    expect(result.fasterSessions).toMatchObject({ count: 1, workoutIds: ["tempo"] });
  });

  it("computes matching in an explicit timezone independently of the execution host", () => {
    const result = summarize([run("local", "2026-10-05", 5, {
      startDate: new Date("2026-10-06T02:00:00.000Z"), endDate: new Date("2026-10-06T02:50:00.000Z"),
    })], { plan: plan([entry("tempo", 0, 1, { workoutType: "tempo" })]) });
    expect(result.fasterSessions.workoutIds).toEqual(["local"]);
  });

  it("never counts synthetic planned mileage as completed training", () => {
    const result = summarize([], { plan: plan([entry("future", 10, 1, { distanceMiles: 100, workoutType: "tempo" })]) });
    expect(result.recentFourWeeks.miles).toBe(0);
    expect(result.fasterSessions.count).toBe(0);
    expect(result.planAdherence?.plannedSessions).toBe(0);
  });
});
