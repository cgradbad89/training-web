import { type HealthWorkout } from "./healthWorkout";

/**
 * User-applied overrides and exclusions for a single workout.
 * Stored at: users/{uid}/workoutOverrides/{workoutId}
 *
 * The healthWorkouts document is never modified — overrides are
 * layered on top at display time. Deleting this document fully
 * restores the original HealthKit data.
 */
export interface WorkoutOverride {
  workoutId: string;
  userId: string;

  // Exclusion
  isExcluded: boolean;
  excludedAt: string | null; // ISO string
  excludedReason: string | null; // optional note

  // Field overrides — null means "use original value"
  distanceMilesOverride: number | null;
  durationSecondsOverride: number | null;
  runTypeOverride: string | null; // e.g. "outdoor", "treadmill"

  updatedAt: string;
}

/**
 * Merge a WorkoutOverride onto a HealthWorkout for display.
 * Returns the workout with overrides applied.
 * Original workout object is not mutated.
 */
export function applyOverride(
  workout: HealthWorkout,
  override: WorkoutOverride | null
): HealthWorkout {
  if (!override) return workout;

  const overridden = { ...workout };

  if (override.distanceMilesOverride != null) {
    overridden.distanceMiles = override.distanceMilesOverride;
    overridden.distanceMeters = override.distanceMilesOverride * 1609.344;
    // Recompute pace from overridden distance
    const duration =
      override.durationSecondsOverride ?? workout.durationSeconds;
    overridden.avgPaceSecPerMile = duration / override.distanceMilesOverride;
  }

  if (override.durationSecondsOverride != null) {
    overridden.durationSeconds = override.durationSecondsOverride;
    // Recompute pace from overridden duration
    const distance = override.distanceMilesOverride ?? workout.distanceMiles;
    if (distance && distance > 0) {
      overridden.avgPaceSecPerMile =
        override.durationSecondsOverride / distance;
    }
  }

  if (override.runTypeOverride != null) {
    overridden.displayType = override.runTypeOverride;
    overridden.activityType = override.runTypeOverride
      .toLowerCase()
      .replace(" ", "_");
  }

  return overridden;
}
