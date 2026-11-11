/**
 * Planned-session construction for one active plan (pure — no matching, no
 * `now`, no React/Firebase). Extracted verbatim from `buildCalendarEvents` so
 * the plan calendar and the Hub summary derive session dates, same-day indexes
 * and labels from one place.
 *
 * `date` is HOST-LOCAL midnight of the session's plan date (`parseLocalDate` +
 * `setDate`). It is built and read in the same zone, so its local Y/M/D is the
 * plan's civil date on any host — callers key it with `toLocalIsoDate(date)`.
 *
 * The caller decides whether the plan is active; this function does not look
 * at `plan.status`. Rest entries are skipped, as the calendar does.
 */

import type {
  PlannedRunEntry,
  PlannedWorkoutEntry,
  RunningPlan,
  WorkoutCategory,
  WorkoutPlan,
} from "@/types/plan";
import { parseLocalDate } from "@/utils/dates";

export const RUN_TYPE_LABELS: Record<string, string> = {
  outdoor: "Outdoor", treadmill: "Treadmill", otf: "OTF", longRun: "Long Run",
};

export interface PlannedSessionBase {
  date: Date;
  entryId: string;
  planId: string;
  planName: string;
  weekIndex: number;
  dayIndex: number;
  weekday: number;
  sessionIndex: number;
  label: string;
}

export interface PlannedRunSession extends PlannedSessionBase {
  planType: "running";
  entry: PlannedRunEntry;
  distanceMiles: number;
}

export interface PlannedWorkoutSession extends PlannedSessionBase {
  planType: "workout";
  entry: PlannedWorkoutEntry;
  category?: WorkoutCategory;
  completed: boolean;
}

function sessionDate(startDate: string, weekIndex: number, dayIndex: number): Date {
  const date = parseLocalDate(startDate);
  date.setDate(date.getDate() + weekIndex * 7 + dayIndex);
  return date;
}

export function plannedSessionsForPlan(plan: WorkoutPlan): PlannedWorkoutSession[];
export function plannedSessionsForPlan(plan: RunningPlan): PlannedRunSession[];
export function plannedSessionsForPlan(
  plan: RunningPlan | WorkoutPlan
): PlannedRunSession[] | PlannedWorkoutSession[] {
  const counters = new Map<string, number>();
  if (plan.planType === "workout") {
    const sessions: PlannedWorkoutSession[] = [];
    for (const week of plan.weeks) {
      for (const entry of week.entries) {
        if (entry.type === "rest") continue;
        const dayIndex = entry.weekday - 1;
        const key = `${entry.weekIndex}-${entry.weekday}`;
        const sessionIndex = counters.get(key) ?? 0;
        counters.set(key, sessionIndex + 1);
        sessions.push({
          planType: "workout",
          entry,
          date: sessionDate(plan.startDate, entry.weekIndex, dayIndex),
          entryId: entry.id, planId: plan.id, planName: plan.name,
          weekIndex: entry.weekIndex, dayIndex,
          weekday: entry.weekday, sessionIndex,
          label: entry.label ?? "Workout", category: entry.category,
          completed: entry.completed ?? false,
        });
      }
    }
    return sessions;
  }
  const sessions: PlannedRunSession[] = [];
  for (const week of plan.weeks) {
    for (const entry of week.entries) {
      if (entry.runType === "rest") continue;
      const dayIndex = entry.weekday - 1;
      const key = `${entry.weekIndex}-${entry.weekday}`;
      const sessionIndex = counters.get(key) ?? 0;
      counters.set(key, sessionIndex + 1);
      sessions.push({
        planType: "running",
        entry,
        date: sessionDate(plan.startDate, entry.weekIndex, dayIndex),
        entryId: entry.id, planId: plan.id, planName: plan.name,
        weekIndex: entry.weekIndex, dayIndex,
        weekday: entry.weekday, sessionIndex,
        label: entry.description ??
          (entry.runType ? (RUN_TYPE_LABELS[entry.runType] ?? entry.runType) : "Run"),
        distanceMiles: entry.distanceMiles,
      });
    }
  }
  return sessions;
}
