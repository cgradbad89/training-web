import { describe, it, expect } from "vitest";
import {
  selectActiveWorkouts,
  selectEffectiveWorkouts,
} from "@/utils/selectActiveWorkouts";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type WorkoutOverride } from "@/types/workoutOverride";

/** Minimal HealthWorkout — selectActiveWorkouts only reads `workoutId`. */
function w(workoutId: string): HealthWorkout {
  return { workoutId } as unknown as HealthWorkout;
}

/** Build a WorkoutOverride with a given isExcluded flag. */
function override(workoutId: string, isExcluded: boolean): WorkoutOverride {
  return {
    workoutId,
    userId: "u1",
    isExcluded,
    excludedAt: isExcluded ? new Date().toISOString() : null,
    excludedReason: null,
    distanceMilesOverride: null,
    durationSecondsOverride: null,
    runTypeOverride: null,
    updatedAt: new Date().toISOString(),
  };
}

function effectiveWorkout(workoutId: string): HealthWorkout {
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
  };
}

function fieldOverride(
  workoutId: string,
  fields: Partial<WorkoutOverride>
): WorkoutOverride {
  return { ...override(workoutId, false), ...fields };
}

describe("selectActiveWorkouts", () => {
  it("excludes a workout whose override has isExcluded: true (the dismissed duplicate case)", () => {
    const workouts = [w("otf-hiit"), w("strava-dupe"), w("run-1")];
    const overrides: Record<string, WorkoutOverride> = {
      "strava-dupe": override("strava-dupe", true),
    };

    const result = selectActiveWorkouts(workouts, overrides);

    expect(result.map((x) => x.workoutId)).toEqual(["otf-hiit", "run-1"]);
    expect(result.some((x) => x.workoutId === "strava-dupe")).toBe(false);
  });

  it("passes the array through unchanged when there are no exclusions (regression guard)", () => {
    const workouts = [w("a"), w("b"), w("c")];

    const result = selectActiveWorkouts(workouts, {});

    expect(result.map((x) => x.workoutId)).toEqual(["a", "b", "c"]);
    expect(result).toHaveLength(3);
  });

  it("keeps a workout whose override exists but has isExcluded: false", () => {
    const workouts = [w("a"), w("b")];
    const overrides: Record<string, WorkoutOverride> = {
      // e.g. a distance-only override with no exclusion
      a: override("a", false),
    };

    const result = selectActiveWorkouts(workouts, overrides);

    expect(result.map((x) => x.workoutId)).toEqual(["a", "b"]);
  });

  it("removes every excluded workout when multiple are excluded", () => {
    const workouts = [w("a"), w("b"), w("c"), w("d")];
    const overrides: Record<string, WorkoutOverride> = {
      a: override("a", true),
      c: override("c", true),
    };

    const result = selectActiveWorkouts(workouts, overrides);

    expect(result.map((x) => x.workoutId)).toEqual(["b", "d"]);
  });

  it("returns an empty array when given no workouts", () => {
    expect(selectActiveWorkouts([], {})).toEqual([]);
  });
});

describe("selectEffectiveWorkouts", () => {
  it("keeps identity-equivalent workout values when there is no override", () => {
    const workout = effectiveWorkout("a");
    const result = selectEffectiveWorkouts([workout], null);

    expect(result).toEqual([workout]);
    expect(result[0]).toBe(workout);
  });

  it("applies a distance override through applyOverride", () => {
    const workout = effectiveWorkout("a");
    const result = selectEffectiveWorkouts([workout], {
      a: fieldOverride("a", { distanceMilesOverride: 5 }),
    });

    expect(result[0]).toMatchObject({
      distanceMiles: 5,
      distanceMeters: 8046.72,
      avgPaceSecPerMile: 360,
    });
  });

  it("applies a duration override through applyOverride", () => {
    const workout = effectiveWorkout("a");
    const result = selectEffectiveWorkouts([workout], {
      a: fieldOverride("a", { durationSecondsOverride: 1500 }),
    });

    expect(result[0]).toMatchObject({
      durationSeconds: 1500,
      avgPaceSecPerMile: 500,
    });
  });

  it("applies a runType override through applyOverride", () => {
    const workout = effectiveWorkout("a");
    const result = selectEffectiveWorkouts([workout], {
      a: fieldOverride("a", { runTypeOverride: "Treadmill Run" }),
    });

    expect(result[0]).toMatchObject({
      displayType: "Treadmill Run",
      activityType: "treadmill_run",
    });
  });

  it("omits excluded workouts", () => {
    expect(
      selectEffectiveWorkouts([effectiveWorkout("a")], {
        a: override("a", true),
      })
    ).toEqual([]);
  });

  it("lets exclusion win over field overrides", () => {
    expect(
      selectEffectiveWorkouts([effectiveWorkout("a")], {
        a: fieldOverride("a", {
          isExcluded: true,
          distanceMilesOverride: 5,
          durationSecondsOverride: 1500,
          runTypeOverride: "Treadmill Run",
        }),
      })
    ).toEqual([]);
  });

  it("does not mutate input objects", () => {
    const workout = effectiveWorkout("a");
    const original = { ...workout };

    selectEffectiveWorkouts([workout], {
      a: fieldOverride("a", {
        distanceMilesOverride: 5,
        durationSecondsOverride: 1500,
      }),
    });

    expect(workout).toEqual(original);
  });

  it("preserves input ordering and one row per retained workout ID", () => {
    const workouts = [
      effectiveWorkout("c"),
      effectiveWorkout("b"),
      effectiveWorkout("a"),
    ];
    const result = selectEffectiveWorkouts(workouts, {
      b: override("b", true),
      a: fieldOverride("a", { distanceMilesOverride: 5 }),
    });

    expect(result.map((workout) => workout.workoutId)).toEqual(["c", "a"]);
    expect(new Set(result.map((workout) => workout.workoutId)).size).toBe(2);
  });
});
