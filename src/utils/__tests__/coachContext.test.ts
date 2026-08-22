import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCoachContext } from "@/utils/coachContext";
import {
  buildPlanAdherence,
  weekHitsMileageTarget,
} from "@/utils/planAdherence";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type PlannedRunEntry, type RunningPlan } from "@/types/plan";

function entry(
  id: string,
  distanceMiles: number,
  weekday = 1
): PlannedRunEntry {
  return {
    id,
    weekIndex: 0,
    weekday,
    dayOfWeek: weekday - 1,
    distanceMiles,
    runType: "outdoor",
  };
}

function plan(entries: PlannedRunEntry[]): RunningPlan {
  return {
    id: "coach-adherence-plan",
    name: "Coach Adherence Plan",
    planType: "running",
    startDate: "2026-08-03",
    status: "active",
    isActive: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    weeks: [
      { weekNumber: 1, entries },
      { weekNumber: 2, entries: [] },
    ],
  };
}

function run(
  workoutId: string,
  day: number,
  distanceMiles: number
): HealthWorkout {
  return {
    workoutId,
    name: "Run",
    activityType: "running",
    displayType: "Run",
    startDate: new Date(2026, 7, day, 12),
    endDate: new Date(2026, 7, day, 13),
    durationSeconds: distanceMiles * 600,
    sourceName: "Test",
    isRunLike: true,
    hasRoute: false,
    syncedAt: new Date(2026, 7, day, 13),
    calories: 0,
    avgHeartRate: null,
    distanceMiles,
    distanceMeters: null,
    avgPaceSecPerMile: null,
    avgSpeedMPS: null,
    hrDriftPct: null,
    cadenceSPM: null,
    efficiencyRaw: null,
    efficiencyScore: null,
    elevationGainM: null,
    trainingLoadV2: null,
  };
}

function coachAdherence(plannedMiles: number, actualMiles: number) {
  const context = buildCoachContext(
    actualMiles > 0 ? [run("threshold-run", 3, actualMiles)] : [],
    plan(plannedMiles > 0 ? [entry("planned-run", plannedMiles)] : []),
    null
  );
  return context.activePlan;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("buildCoachContext — canonical weekly mileage target", () => {
  it.each([
    { actual: 8, expected: 0, label: "80%" },
    { actual: 8.49, expected: 0, label: "just below 85%" },
    { actual: 8.5, expected: 1, label: "exactly 85%" },
    { actual: 9, expected: 1, label: "above 85%" },
  ])("counts $label through the canonical rule", ({ actual, expected }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 10, 12));

    const coach = coachAdherence(10, actual);

    expect(coach?.weeksHitTarget).toBe(expected);
    expect(coach?.adherencePct).toBe(expected * 100);
  });

  it("preserves canonical zero-planned-mileage behavior", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 10, 12));

    const coach = coachAdherence(0, 0);

    expect(weekHitsMileageTarget(0, 0)).toBe(false);
    expect(coach?.weeksHitTarget).toBe(0);
  });

  it("matches Plan Insights at 82% while completed sessions remain independent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 10, 12));
    const fixturePlan = plan([
      entry("monday", 5, 1),
      entry("tuesday", 5, 2),
    ]);
    const runs = [
      run("monday-run", 3, 4.25),
      run("tuesday-partial", 4, 3.95),
    ];

    const planInsights = buildPlanAdherence(fixturePlan, runs, { maxHr: 185 });
    const coach = buildCoachContext(runs, fixturePlan, null).activePlan;

    expect(planInsights.weeks[0]).toMatchObject({
      plannedMiles: 10,
      actualMiles: 8.2,
      plannedRuns: 2,
      completedRuns: 2,
    });
    expect(planInsights.weeksHitTarget).toBe(0);
    expect(coach).toMatchObject({
      weeksHitTarget: planInsights.weeksHitTarget,
      weeksCompleted: 1,
      adherencePct: 0,
    });
  });
});
