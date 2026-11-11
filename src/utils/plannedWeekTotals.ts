/**
 * Planned-week totals for the selected week (pure — no React, no Firebase).
 *
 * Extracted verbatim from the Dashboard's `plannedMiles` and
 * `{ sessionsCompleted, sessionsPlanned }` memos. "Which plan week" is derived
 * ONLY by `planWeekIndexFor(plan.startDate, weekStart)` (PRD invariant #2);
 * `weekStart` is a Date whose LOCAL year/month/day identify the Monday, so a
 * caller on any host timezone can pass `parseLocalDate("YYYY-MM-DD")`.
 */

import type { RunningPlan, WorkoutPlan, PlannedWorkoutEntry } from "@/types/plan";
import { planWeekIndexFor } from "@/utils/planMatching";

export interface PlannedRunningWeek {
  /** Sum of `distanceMiles` over ALL entries of the week — rest entries included, as the dashboard does. */
  miles: number;
  /** Entries whose `runType` is not "rest" (the calendar's own planned-run rule). */
  runs: number;
}

export function plannedRunningWeek(
  plan: RunningPlan | null,
  weekStart: Date
): PlannedRunningWeek {
  if (!plan) return { miles: 0, runs: 0 };
  const weekIndex = planWeekIndexFor(plan.startDate, weekStart);
  if (weekIndex < 0 || weekIndex >= plan.weeks.length) return { miles: 0, runs: 0 };
  const entries = plan.weeks[weekIndex].entries;
  return {
    miles: entries.reduce((s, e) => s + e.distanceMiles, 0),
    runs: entries.filter((e) => e.runType !== "rest").length,
  };
}

export function workoutPlanSessions(
  plan: WorkoutPlan | null,
  weekStart: Date
): { sessionsCompleted: number; sessionsPlanned: number } {
  if (!plan) {
    return { sessionsCompleted: 0, sessionsPlanned: 0 };
  }
  const weekIndex = planWeekIndexFor(plan.startDate, weekStart);
  if (weekIndex < 0 || weekIndex >= plan.weeks.length) {
    return { sessionsCompleted: 0, sessionsPlanned: 0 };
  }
  const sessionEntries = plan.weeks[weekIndex].entries.filter(
    (e): e is PlannedWorkoutEntry => e.type === "workout"
  );
  return {
    sessionsCompleted: sessionEntries.filter((e) => e.completed === true).length,
    sessionsPlanned: sessionEntries.length,
  };
}
