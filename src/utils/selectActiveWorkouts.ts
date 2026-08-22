/**
 * Filter out workouts the user has manually excluded via a workoutOverride.
 *
 * AppDataContext deliberately does NOT pre-apply `workoutOverrides` exclusions —
 * each consuming page filters for itself (see AppDataContext.tsx). Both the
 * Workouts page and the Dashboard route their workout lists through this same
 * predicate so an excluded workout (e.g. a dismissed Strava/Apple Health
 * duplicate) is consistently hidden and never counted.
 *
 * A workout is "active" unless its override doc exists AND has isExcluded===true.
 * A missing override, or an override with isExcluded false/undefined, keeps it.
 */
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  applyOverride,
  type WorkoutOverride,
} from "@/types/workoutOverride";

export function selectActiveWorkouts(
  workouts: HealthWorkout[],
  overrides: Record<string, WorkoutOverride>
): HealthWorkout[] {
  return workouts.filter((w) => !overrides[w.workoutId]?.isExcluded);
}

/**
 * Canonical projection for features that operate on the user's actual workout
 * history. Raw AppData workouts remain untouched: exclusions are removed first,
 * then supported field overrides are layered onto each retained workout via the
 * single existing applyOverride implementation.
 */
export function selectEffectiveWorkouts(
  workouts: HealthWorkout[],
  overrides: Record<string, WorkoutOverride> | null | undefined
): HealthWorkout[] {
  const overrideMap = overrides ?? {};
  return workouts.flatMap((workout) => {
    const override = overrideMap[workout.workoutId] ?? null;
    return override?.isExcluded ? [] : [applyOverride(workout, override)];
  });
}
