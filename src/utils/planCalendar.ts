import type { RunningPlan, WorkoutPlan, WorkoutCategory } from "@/types/plan";
import {
  matchPlanToActual,
  statusForRunEntry,
  isPlanEntryCompleted,
  type RunEntryStatus,
} from "@/utils/planMatching";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { parseLocalDate } from "@/utils/dates";
import { resolveActivityTitle } from "@/utils/resolveActivityTitle";
import { resolveCalendarWorkoutAssociations } from "@/utils/workoutPlanMatching";

export interface PlannedCalendarEventBase {
  date: Date;
  entryId: string;
  planId: string;
  planName: string;
  weekIndex: number;
  dayIndex: number;
  weekday: number;
  sessionIndex: number;
  label: string;
  completed: boolean;
  isRestDay: false;
}

export interface PlannedRunningCalendarEvent extends PlannedCalendarEventBase {
  kind: "planned-running";
  planType: "running";
  distanceMiles?: number;
  status: RunEntryStatus;
  activity: HealthWorkout | null;
}

export interface PlannedWorkoutCalendarEvent extends PlannedCalendarEventBase {
  kind: "planned-workout";
  planType: "workout";
  category?: WorkoutCategory;
}

export interface ActualRunCalendarEvent {
  kind: "actual-run";
  date: Date;
  label: string;
  activity: HealthWorkout;
  distanceMiles?: number;
}

export interface ActualWorkoutCalendarEvent {
  kind: "actual-workout";
  date: Date;
  label: string;
  activity: HealthWorkout;
}

export type CalendarEvent =
  | PlannedRunningCalendarEvent
  | PlannedWorkoutCalendarEvent
  | ActualRunCalendarEvent
  | ActualWorkoutCalendarEvent;

export interface BuildCalendarEventsOptions {
  includeActualOnly?: boolean;
}

const RUN_TYPE_LABELS: Record<string, string> = {
  outdoor: "Outdoor", treadmill: "Treadmill", otf: "OTF", longRun: "Long Run",
};

function sessionDate(startDate: string, weekIndex: number, dayIndex: number): Date {
  const date = parseLocalDate(startDate);
  date.setDate(date.getDate() + weekIndex * 7 + dayIndex);
  return date;
}

/** Planned events retain plan/entry order. Actual-only events follow in local-time order. */
export function buildCalendarEvents(
  plans: (RunningPlan | WorkoutPlan)[],
  actualWorkouts: HealthWorkout[] = [],
  overrides?: Record<string, WorkoutOverride>,
  options: BuildCalendarEventsOptions = {},
): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const matchedRunIds = new Set<string>();
  const activeWorkoutPlans: WorkoutPlan[] = [];

  for (const plan of plans) {
    if (plan.status !== "active") continue;
    const counters = new Map<string, number>();
    if (plan.planType === "workout") {
      activeWorkoutPlans.push(plan);
      for (const week of plan.weeks) {
        for (const entry of week.entries) {
          if (entry.type === "rest") continue;
          const dayIndex = entry.weekday - 1;
          const key = `${entry.weekIndex}-${entry.weekday}`;
          const sessionIndex = counters.get(key) ?? 0;
          counters.set(key, sessionIndex + 1);
          events.push({
            kind: "planned-workout",
            date: sessionDate(plan.startDate, entry.weekIndex, dayIndex),
            entryId: entry.id, planId: plan.id, planName: plan.name,
            planType: "workout", weekIndex: entry.weekIndex, dayIndex,
            weekday: entry.weekday, sessionIndex,
            label: entry.label ?? "Workout", category: entry.category,
            completed: entry.completed ?? false, isRestDay: false,
          });
        }
      }
    } else {
      const matchMap = matchPlanToActual(plan, actualWorkouts, overrides);
      for (const match of matchMap.values()) {
        if (match?.activity.workoutId) matchedRunIds.add(match.activity.workoutId);
      }
      for (const week of plan.weeks) {
        for (const entry of week.entries) {
          if (entry.runType === "rest") continue;
          const dayIndex = entry.weekday - 1;
          const key = `${entry.weekIndex}-${entry.weekday}`;
          const sessionIndex = counters.get(key) ?? 0;
          counters.set(key, sessionIndex + 1);
          const match = matchMap.get(entry.id) ?? null;
          const status = statusForRunEntry(plan, entry, matchMap);
          events.push({
            kind: "planned-running",
            date: sessionDate(plan.startDate, entry.weekIndex, dayIndex),
            entryId: entry.id, planId: plan.id, planName: plan.name,
            planType: "running", weekIndex: entry.weekIndex, dayIndex,
            weekday: entry.weekday, sessionIndex,
            label: entry.description ??
              (entry.runType ? (RUN_TYPE_LABELS[entry.runType] ?? entry.runType) : "Run"),
            distanceMiles: entry.distanceMiles,
            completed: isPlanEntryCompleted(status), isRestDay: false,
            status, activity: match?.activity ?? null,
          });
        }
      }
    }
  }

  if (!options.includeActualOnly) return events;

  const matchedWorkoutIds = resolveCalendarWorkoutAssociations(
    activeWorkoutPlans, actualWorkouts
  ).matchedWorkoutIds;
  const emitted = new Set<string>();
  const actualEvents: (ActualRunCalendarEvent | ActualWorkoutCalendarEvent)[] = [];
  for (const workout of actualWorkouts) {
    if (emitted.has(workout.workoutId)) continue;
    emitted.add(workout.workoutId);
    if (workout.isRunLike) {
      if (matchedRunIds.has(workout.workoutId)) continue;
      actualEvents.push({
        kind: "actual-run", date: workout.startDate, activity: workout,
        label: resolveActivityTitle({
          activityType: workout.displayType,
          distanceMiles: workout.distanceMiles,
        }),
        distanceMiles: workout.distanceMiles,
      });
    } else {
      if (matchedWorkoutIds.has(workout.workoutId)) continue;
      actualEvents.push({
        kind: "actual-workout", date: workout.startDate, activity: workout,
        label: resolveActivityTitle({
          activityType: workout.displayType,
          rawActivityType: workout.activityType,
          distanceMiles: workout.distanceMiles,
        }),
      });
    }
  }
  actualEvents.sort((a, b) => {
    return a.date.getTime() - b.date.getTime() ||
      a.activity.workoutId.localeCompare(b.activity.workoutId);
  });
  return [...events, ...actualEvents];
}
