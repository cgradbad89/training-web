/**
 * Pure planned-vs-actual aggregation for workout plans.
 *
 * Everything derives from the plan's own entries — completion lives on the
 * entry (`entry.completed === true`), not on a matched HealthWorkout, so no
 * activity pool is needed. Category (OT / Pilates) is `entry.category`
 * (optional); non-rest entries without a category land in the "uncategorized"
 * bucket rather than being hidden. No Firestore, no React.
 */

import { type WorkoutPlan, type PlannedWorkoutEntry } from "@/types/plan";

export interface WorkoutWeekSummary {
  weekNumber: number;
  label: string;
  plannedSessions: number;
  completedSessions: number;
}

export interface WorkoutPlanSummaryResult {
  totalPlanned: number; // non-rest entries across all weeks
  totalCompleted: number; // entry.completed === true
  otPlanned: number; // category === "orangetheory"
  otCompleted: number;
  pilatesPlanned: number; // category === "pilates"
  pilatesCompleted: number;
  uncategorizedPlanned: number; // non-rest, no category
  uncategorizedCompleted: number;
  weeks: WorkoutWeekSummary[];
}

function isSession(e: PlannedWorkoutEntry): boolean {
  return e.type !== "rest";
}

function isCompleted(e: PlannedWorkoutEntry): boolean {
  return e.completed === true;
}

export function buildWorkoutPlanSummary(
  plan: WorkoutPlan
): WorkoutPlanSummaryResult {
  let totalPlanned = 0;
  let totalCompleted = 0;
  let otPlanned = 0;
  let otCompleted = 0;
  let pilatesPlanned = 0;
  let pilatesCompleted = 0;
  let uncategorizedPlanned = 0;
  let uncategorizedCompleted = 0;
  const weeks: WorkoutWeekSummary[] = [];

  for (const week of plan.weeks) {
    let plannedSessions = 0;
    let completedSessions = 0;
    for (const e of week.entries) {
      if (!isSession(e)) continue;
      const done = isCompleted(e);
      plannedSessions += 1;
      totalPlanned += 1;
      if (done) {
        completedSessions += 1;
        totalCompleted += 1;
      }
      if (e.category === "orangetheory") {
        otPlanned += 1;
        if (done) otCompleted += 1;
      } else if (e.category === "pilates") {
        pilatesPlanned += 1;
        if (done) pilatesCompleted += 1;
      } else if (!e.category) {
        uncategorizedPlanned += 1;
        if (done) uncategorizedCompleted += 1;
      }
    }
    weeks.push({
      weekNumber: week.weekNumber,
      label: `W${week.weekNumber}`,
      plannedSessions,
      completedSessions,
    });
  }

  return {
    totalPlanned,
    totalCompleted,
    otPlanned,
    otCompleted,
    pilatesPlanned,
    pilatesCompleted,
    uncategorizedPlanned,
    uncategorizedCompleted,
    weeks,
  };
}
