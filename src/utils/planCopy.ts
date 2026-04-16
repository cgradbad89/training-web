/**
 * Shared deep-copy utilities for plan copy operations.
 *
 * All copies:
 *   - Generate fresh UUIDs for every entry and nested exercise item.
 *   - Clear `completed` and `completedAt` so copied sessions start fresh.
 *   - Accept an optional targetWeekday override (for copy-day operations).
 */

import type {
  PlannedWorkoutEntry,
  PlannedRunEntry,
  PlanWorkoutWeek,
  PlanWeek,
  WorkoutPlan,
  RunningPlan,
} from "@/types/plan";

// ─── Single entry copies ──────────────────────────────────────────────────────

export function deepCopyWorkoutEntry(
  entry: PlannedWorkoutEntry,
  targetWeekIndex: number,
  targetWeekday?: number
): PlannedWorkoutEntry {
  const wd = targetWeekday ?? entry.weekday;
  return {
    ...entry,
    id: crypto.randomUUID(),
    weekIndex: targetWeekIndex,
    weekday: wd,
    dayOfWeek: wd - 1,
    completed: false,
    completedAt: undefined,
    exercises: (entry.exercises ?? []).map((ex) => ({
      ...ex,
      id: crypto.randomUUID(),
    })),
  };
}

export function deepCopyRunEntry(
  entry: PlannedRunEntry,
  targetWeekIndex: number,
  targetWeekday?: number
): PlannedRunEntry {
  const wd = targetWeekday ?? entry.weekday;
  return {
    ...entry,
    id: crypto.randomUUID(),
    weekIndex: targetWeekIndex,
    weekday: wd,
    dayOfWeek: wd - 1,
  };
}

// ─── Full week copies ─────────────────────────────────────────────────────────

export function deepCopyWorkoutWeek(
  week: PlanWorkoutWeek,
  targetWeekIndex: number
): PlanWorkoutWeek {
  return {
    ...week,
    entries: week.entries.map((e) => deepCopyWorkoutEntry(e, targetWeekIndex)),
  };
}

export function deepCopyRunWeek(
  week: PlanWeek,
  targetWeekIndex: number
): PlanWeek {
  return {
    ...week,
    entries: week.entries.map((e) => deepCopyRunEntry(e, targetWeekIndex)),
  };
}

// ─── Full plan copies ─────────────────────────────────────────────────────────

export function deepCopyWorkoutPlan(
  plan: WorkoutPlan,
  newName: string
): Omit<WorkoutPlan, "id" | "createdAt" | "updatedAt"> {
  return {
    name: newName,
    planType: "workout",
    startDate: plan.startDate,
    isActive: false,
    weeks: plan.weeks.map((week, i) => deepCopyWorkoutWeek(week, i)),
  };
}

export function deepCopyRunningPlan(
  plan: RunningPlan,
  newName: string
): Omit<RunningPlan, "id" | "createdAt" | "updatedAt"> {
  return {
    name: newName,
    planType: "running",
    startDate: plan.startDate,
    isActive: false,
    isBuiltInDefault: false,
    weeks: plan.weeks.map((week, i) => deepCopyRunWeek(week, i)),
  };
}
