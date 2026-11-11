/**
 * Active-plan selection (pure). Extracted verbatim from the Dashboard:
 * the FIRST plan of each type whose `status === "active"`, in the order the
 * plans array was read. Normally at most one is active per type; legacy data
 * can carry two, and `.find` in array order keeps every surface agreeing on
 * which one wins. Do not add a tie-break here without changing the dashboard.
 */

import {
  isRunningPlan,
  isWorkoutPlan,
  type Plan,
  type RunningPlan,
  type WorkoutPlan,
} from "@/types/plan";

export function selectActiveRunningPlan(plans: Plan[]): RunningPlan | null {
  return plans.filter(isRunningPlan).find((p) => p.status === "active") ?? null;
}

export function selectActiveWorkoutPlan(plans: Plan[]): WorkoutPlan | null {
  return plans.filter(isWorkoutPlan).find((p) => p.status === "active") ?? null;
}
