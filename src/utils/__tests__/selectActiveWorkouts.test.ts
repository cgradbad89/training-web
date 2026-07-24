import { describe, it, expect } from "vitest";
import { selectActiveWorkouts } from "@/utils/selectActiveWorkouts";
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
