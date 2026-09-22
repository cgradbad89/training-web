import type { HealthWorkout } from "@/types/healthWorkout";
import {
  type PlannedWorkoutEntry,
  type WorkoutPlan,
  isDurationOnlyEntry,
  WORKOUT_CATEGORY_HK_TYPES,
} from "@/types/plan";
import { parseLocalDate, toLocalIsoDate } from "@/utils/dates";

const PILATES_ACTIVITY_TYPES = new Set([
  "yoga", "mindandbody", "mind_and_body", "pilates", "flexibility", "cooldown",
]);

export function isPilatesActivity(workout: HealthWorkout): boolean {
  return PILATES_ACTIVITY_TYPES.has(workout.activityType.toLowerCase().trim());
}

export function isStrengthLikeActivity(workout: HealthWorkout): boolean {
  return !workout.isRunLike && !isPilatesActivity(workout);
}

function matchesEntry(entry: PlannedWorkoutEntry, workout: HealthWorkout): boolean {
  if (entry.category === "orangetheory") return !workout.isRunLike;
  if (entry.category) {
    return !workout.isRunLike && WORKOUT_CATEGORY_HK_TYPES[entry.category].some(
      (type) => type.toLowerCase() === workout.activityType.toLowerCase().trim()
    );
  }
  return isDurationOnlyEntry(entry)
    ? isPilatesActivity(workout)
    : isStrengthLikeActivity(workout);
}

function sessionDate(plan: WorkoutPlan, entry: PlannedWorkoutEntry): Date {
  const date = parseLocalDate(plan.startDate);
  date.setDate(date.getDate() + entry.weekIndex * 7 + entry.weekday - 1);
  return date;
}

export interface WorkoutPlanMatchAssignment {
  planId: string;
  entryId: string;
  workout: HealthWorkout;
}

/** Pure candidate assignment; the caller filters exclusions before calling. */
export function matchWorkoutPlanSessions(
  plans: WorkoutPlan[],
  workouts: HealthWorkout[],
  today: Date = new Date(),
): WorkoutPlanMatchAssignment[] {
  const todayStart = new Date(today);
  todayStart.setHours(0, 0, 0, 0);
  const byDate = new Map<string, HealthWorkout[]>();
  for (const workout of workouts) {
    const key = toLocalIsoDate(workout.startDate);
    const bucket = byDate.get(key) ?? [];
    bucket.push(workout);
    byDate.set(key, bucket);
  }
  for (const bucket of byDate.values()) {
    bucket.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
  }

  const assignments: WorkoutPlanMatchAssignment[] = [];
  for (const otfPass of [false, true]) {
    for (const plan of plans) {
      for (const week of plan.weeks) {
        for (const entry of week.entries) {
          if (entry.type !== "workout" || entry.completed === true) continue;
          if ((entry.category === "orangetheory") !== otfPass) continue;
          const date = sessionDate(plan, entry);
          if (date > todayStart) continue;
          const candidates = byDate.get(toLocalIsoDate(date));
          const index = candidates?.findIndex((workout) => matchesEntry(entry, workout)) ?? -1;
          if (index < 0 || !candidates) continue;
          assignments.push({ planId: plan.id, entryId: entry.id, workout: candidates.splice(index, 1)[0] });
        }
      }
    }
  }
  return assignments;
}

export interface CalendarWorkoutAssociations {
  matchedWorkoutIds: Set<string>;
  matchedByEntryId: Map<string, HealthWorkout>;
  unresolvedEntryIds: Set<string>;
}

/** Display-only association: legacy completions require exact, unique evidence. */
export function resolveCalendarWorkoutAssociations(
  plans: WorkoutPlan[],
  workouts: HealthWorkout[],
): CalendarWorkoutAssociations {
  const matchedWorkoutIds = new Set<string>();
  const matchedByEntryId = new Map<string, HealthWorkout>();
  const unresolvedEntryIds = new Set<string>();
  const effectiveWorkouts = workouts.filter((workout) => !workout.isRunLike);
  const byId = new Map(effectiveWorkouts.map((workout) => [workout.workoutId, workout]));
  const legacy: { plan: WorkoutPlan; entry: PlannedWorkoutEntry }[] = [];

  for (const plan of plans) {
    if (plan.status !== "active") continue;
    for (const week of plan.weeks) {
      for (const entry of week.entries) {
        if (entry.type !== "workout" || entry.completed !== true) continue;
        if (entry.matchedWorkoutId) {
          const workout = byId.get(entry.matchedWorkoutId);
          if (workout) {
            matchedWorkoutIds.add(workout.workoutId);
            matchedByEntryId.set(entry.id, workout);
          } else {
            unresolvedEntryIds.add(entry.id);
          }
        } else {
          legacy.push({ plan, entry });
        }
      }
    }
  }

  const candidates = new Map<string, HealthWorkout[]>();
  const claims = new Map<string, number>();
  for (const { plan, entry } of legacy) {
    if (!entry.completedAt) {
      unresolvedEntryIds.add(entry.id);
      continue;
    }
    const completedDate = new Date(entry.completedAt);
    if (Number.isNaN(completedDate.getTime())) {
      unresolvedEntryIds.add(entry.id);
      continue;
    }
    const eligible = effectiveWorkouts.filter((workout) =>
      !matchedWorkoutIds.has(workout.workoutId) &&
      toLocalIsoDate(workout.startDate) === toLocalIsoDate(sessionDate(plan, entry)) &&
      matchesEntry(entry, workout) &&
      workout.startDate.toISOString() === entry.completedAt
    );
    candidates.set(entry.id, eligible);
    for (const workout of eligible) {
      claims.set(workout.workoutId, (claims.get(workout.workoutId) ?? 0) + 1);
    }
  }
  for (const { entry } of legacy) {
    const eligible = candidates.get(entry.id) ?? [];
    if (eligible.length === 1 && claims.get(eligible[0].workoutId) === 1) {
      matchedWorkoutIds.add(eligible[0].workoutId);
      matchedByEntryId.set(entry.id, eligible[0]);
    } else {
      unresolvedEntryIds.add(entry.id);
    }
  }
  return { matchedWorkoutIds, matchedByEntryId, unresolvedEntryIds };
}
