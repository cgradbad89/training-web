import { isRunWorkout, type HealthWorkout } from "@/types/healthWorkout";

/**
 * The ONLY sanctioned way to narrow a workout list to runs for run-only
 * metrics (PRs, pace trends, race-prediction inputs, run YTD figures).
 *
 * "Is a run" is the stored `isRunLike` boolean (written by iOS sync and the
 * manual-entry form; read via workoutModelSummary). Manual run entries count;
 * HIIT/OTF/cycling/etc. never do, even when they carry a distance. Training
 * load metrics must NOT use this — they take the full workout list.
 *
 * Preserves input order; never mutates the input.
 */
export function selectRuns<T extends HealthWorkout>(
  workouts: readonly T[]
): T[] {
  return workouts.filter((w) => isRunWorkout(w));
}
