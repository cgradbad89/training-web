import { type HealthWorkout } from "@/types/healthWorkout";
import { type RunningShoe } from "@/types/shoe";

export function shoeAssignedRuns(
  shoe: RunningShoe,
  workouts: HealthWorkout[],
  assignments: Record<string, string | null>
): HealthWorkout[] {
  return workouts.filter(
    (workout) =>
      workout.isRunLike && assignments[workout.workoutId] === shoe.id
  );
}

export function totalShoeMileage(
  shoe: RunningShoe,
  workouts: HealthWorkout[],
  assignments: Record<string, string | null>
): number {
  return (
    shoe.startMileageOffset +
    shoeAssignedRuns(shoe, workouts, assignments).reduce(
      (total, run) => total + run.distanceMiles,
      0
    )
  );
}
