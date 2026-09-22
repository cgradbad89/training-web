/** Firestore persistence wrapper around pure workout-plan candidate assignment. */
import type { HealthWorkout } from "@/types/healthWorkout";
import { type Plan, type WorkoutPlan, isWorkoutPlan } from "@/types/plan";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { updatePlan } from "@/services/plans";
import { selectActiveWorkouts } from "@/utils/selectActiveWorkouts";
import { parseLocalDate } from "@/utils/dates";
import { matchWorkoutPlanSessions } from "@/utils/workoutPlanMatching";

export { isPilatesActivity, isStrengthLikeActivity } from "@/utils/workoutPlanMatching";

function plannedSessionDate(planStartDate: string, weekIndex: number, weekday: number): Date {
  const date = parseLocalDate(planStartDate);
  date.setDate(date.getDate() + weekIndex * 7 + weekday - 1);
  return date;
}

export function planNeedsAutoMatch(plan: Plan, today: Date = new Date()): boolean {
  return autoMatchWindowStart([plan], today) !== null;
}

export function autoMatchWindowStart(plans: Plan[], today: Date = new Date()): Date | null {
  let earliest: Date | null = null;
  const todayStart = new Date(today);
  todayStart.setHours(0, 0, 0, 0);
  for (const plan of plans) {
    if (!isWorkoutPlan(plan) || plan.status !== "active") continue;
    for (const week of plan.weeks) {
      for (const entry of week.entries) {
        if (entry.type !== "workout" || entry.completed === true) continue;
        const date = plannedSessionDate(plan.startDate, entry.weekIndex, entry.weekday);
        if (date > todayStart) continue;
        if (!earliest || date < earliest) earliest = date;
      }
    }
  }
  return earliest;
}

export interface AutoMatchResult {
  matched: number;
  updatedPlanIds: string[];
}

export async function autoMatchCrossTrainingSessions(
  uid: string,
  plans: Plan[],
  healthWorkouts: HealthWorkout[],
  overrides: Record<string, WorkoutOverride> = {},
): Promise<{ plans: Plan[]; result: AutoMatchResult }> {
  const activeWorkouts = selectActiveWorkouts(healthWorkouts, overrides);
  const workoutPlans = plans.filter(isWorkoutPlan);
  const assignments = matchWorkoutPlanSessions(workoutPlans, activeWorkouts);
  const result: AutoMatchResult = { matched: assignments.length, updatedPlanIds: [] };
  const byPlan = new Map<string, Map<string, HealthWorkout>>();
  for (const assignment of assignments) {
    const entries = byPlan.get(assignment.planId) ?? new Map<string, HealthWorkout>();
    entries.set(assignment.entryId, assignment.workout);
    byPlan.set(assignment.planId, entries);
  }

  const nextPlans: Plan[] = [];
  for (const plan of plans) {
    if (!isWorkoutPlan(plan) || !byPlan.has(plan.id)) {
      nextPlans.push(plan);
      continue;
    }
    const matches = byPlan.get(plan.id)!;
    const updated: WorkoutPlan = {
      ...plan,
      weeks: plan.weeks.map((week) => ({
        ...week,
        entries: week.entries.map((entry) => {
          const matched = matches.get(entry.id);
          return matched
            ? {
                ...entry,
                completed: true,
                completedAt: matched.startDate.toISOString(),
                matchedWorkoutId: matched.workoutId,
              }
            : entry;
        }),
      })),
    };
    try {
      await updatePlan(uid, updated);
      result.updatedPlanIds.push(plan.id);
      nextPlans.push(updated);
    } catch (error) {
      console.error("[AutoMatch] failed to persist workout plan", plan.id, error);
      nextPlans.push(plan);
    }
  }
  return { plans: nextPlans, result };
}
