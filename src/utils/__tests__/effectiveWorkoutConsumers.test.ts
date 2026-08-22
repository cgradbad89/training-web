import { describe, expect, it, vi } from "vitest";
import { selectEffectiveWorkouts } from "@/utils/selectActiveWorkouts";
import { buildRunTitleMap } from "@/utils/runPlanTitle";
import { evaluateAutoAssignRules } from "@/utils/shoeAutoAssign";
import { shoeAssignedRuns, totalShoeMileage } from "@/utils/shoeMileage";
import { buildCoachContext } from "@/utils/coachContext";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type WorkoutOverride } from "@/types/workoutOverride";
import { type RunningPlan } from "@/types/plan";
import { type RunningShoe } from "@/types/shoe";

function workout(
  workoutId: string,
  partial: Partial<HealthWorkout> = {}
): HealthWorkout {
  return {
    workoutId,
    name: "Run",
    activityType: "running",
    displayType: "Run",
    startDate: new Date("2026-08-20T12:00:00Z"),
    endDate: new Date("2026-08-20T12:30:00Z"),
    durationSeconds: 1800,
    sourceName: "Health",
    isRunLike: true,
    hasRoute: false,
    syncedAt: new Date("2026-08-20T12:31:00Z"),
    calories: 300,
    avgHeartRate: 140,
    distanceMiles: 3,
    distanceMeters: 4828.032,
    avgPaceSecPerMile: 600,
    avgSpeedMPS: null,
    hrDriftPct: null,
    cadenceSPM: null,
    efficiencyRaw: null,
    efficiencyScore: null,
    elevationGainM: null,
    trainingLoadV2: 97,
    trainingLoadMethod: "streamed",
    trainingLoadBasisComplete: true,
    ...partial,
  };
}

function override(
  workoutId: string,
  partial: Partial<WorkoutOverride> = {}
): WorkoutOverride {
  return {
    workoutId,
    userId: "u1",
    isExcluded: false,
    excludedAt: null,
    excludedReason: null,
    distanceMilesOverride: null,
    durationSecondsOverride: null,
    runTypeOverride: null,
    updatedAt: "2026-08-22T00:00:00Z",
    ...partial,
  };
}

const plan: RunningPlan = {
  id: "plan",
  name: "Plan",
  planType: "running",
  startDate: "2026-08-17",
  status: "active",
  isActive: true,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  weeks: [
    {
      weekNumber: 1,
      entries: [
        {
          id: "entry",
          weekIndex: 0,
          weekday: 4,
          dayOfWeek: 3,
          distanceMiles: 5,
          runType: "longRun",
        },
      ],
    },
  ],
};

const shoe: RunningShoe = {
  id: "shoe",
  name: "Trainer",
  brand: "Test",
  model: "One",
  colorway: "Blue",
  startMileageOffset: 1,
  retirementMileageTarget: 400,
  isRetired: false,
  addedAt: "2026-01-01T00:00:00Z",
  autoAssignRules: [
    {
      id: "rule",
      shoeId: "shoe",
      scope: "any",
      minDistance: 4,
      isEnabled: true,
    },
  ],
};

describe("canonical effective-workout consumer pipelines", () => {
  it("keeps an excluded competitor from stealing the Runs/Run Detail plan label", () => {
    const raw = [workout("excluded", { distanceMiles: 5 }), workout("visible")];
    const effective = selectEffectiveWorkouts(raw, {
      excluded: override("excluded", { isExcluded: true }),
      visible: override("visible", { distanceMilesOverride: 5 }),
    });

    const titleMap = buildRunTitleMap(plan, effective);

    expect(titleMap.has("excluded")).toBe(false);
    expect(titleMap.get("visible")).toEqual({
      label: "Long Run",
      distanceMiles: 5,
    });
  });

  it("uses corrected mileage, removes excluded assignments, and preserves manual-null priority", () => {
    const effective = selectEffectiveWorkouts(
      [workout("visible"), workout("excluded", { distanceMiles: 9 })],
      {
        visible: override("visible", { distanceMilesOverride: 5 }),
        excluded: override("excluded", { isExcluded: true }),
      }
    );
    const assigned = { visible: "shoe", excluded: "shoe" };

    expect(shoeAssignedRuns(shoe, effective, assigned).map((run) => run.workoutId))
      .toEqual(["visible"]);
    expect(totalShoeMileage(shoe, effective, assigned)).toBe(6);
    expect(evaluateAutoAssignRules(effective, [shoe], {})).toEqual({
      visible: "shoe",
    });
    expect(evaluateAutoAssignRules(effective, [shoe], { visible: null })).toEqual(
      {}
    );
  });

  it("serializes only effective distance/duration/run type/load into Coach context", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T12:00:00Z"));
    const effective = selectEffectiveWorkouts(
      [workout("visible"), workout("excluded")],
      {
        visible: override("visible", {
          distanceMilesOverride: 5,
          durationSecondsOverride: 2500,
          runTypeOverride: "Treadmill Run",
        }),
        excluded: override("excluded", { isExcluded: true }),
      }
    );

    const context = buildCoachContext(effective, null, null, [], 175, 65);

    expect(context.stats).toMatchObject({
      totalRuns: 1,
      totalMiles: 5,
      maxHeartRate: 175,
    });
    expect(context.runs).toHaveLength(1);
    expect(context.runs[0]).toMatchObject({
      distance: 5,
      pace: "8:20",
      trainingLoad: 97,
    });
    expect(context.runs[0].runType).toContain("Treadmill");
    vi.useRealTimers();
  });
});
