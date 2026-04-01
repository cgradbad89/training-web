import { type RunningPlan, type PlannedRunEntry } from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";

export type MatchQuality = "full" | "partial";

export interface PlanMatch {
  activity: HealthWorkout;
  quality: MatchQuality;
}

export type WeekMatchStatus = "met" | "partial" | "missed" | "upcoming";

export interface WeekMatchResult {
  planned: number;
  actual: number;
  status: WeekMatchStatus;
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function plannedEntryDate(plan: RunningPlan, entry: PlannedRunEntry): Date {
  const [year, month, day] = plan.startDate.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const daysOffset = entry.weekIndex * 7 + (entry.weekday - 1);
  const d = new Date(start);
  d.setDate(start.getDate() + daysOffset);
  return d;
}

function workoutDate(w: HealthWorkout): string {
  return w.startDate.toISOString().split("T")[0];
}

function withinTolerance(e: PlannedRunEntry, w: HealthWorkout): boolean {
  return (
    Math.abs(w.distanceMiles - e.distanceMiles) <=
    Math.max(0.5, e.distanceMiles * 0.3)
  );
}

function withinOneDay(aDate: string, eDate: string): boolean {
  return (
    Math.abs(
      (new Date(aDate).getTime() - new Date(eDate).getTime()) / 86400000
    ) <= 1
  );
}

/**
 * 4-pass plan vs actual matching (no type matching; per-week used-set).
 * Returns a map: entryId → PlanMatch | null
 */
export function matchPlanToActual(
  plan: RunningPlan,
  workouts: HealthWorkout[]
): Map<string, PlanMatch | null> {
  const runs = workouts.filter((w) => w.isRunLike);
  const result = new Map<string, PlanMatch | null>();

  for (const week of plan.weeks) {
    const entries = week.entries.filter((e) => e.runType !== "rest");
    const used = new Set<string>();

    // Pass 1: exact day, distance within tolerance → "full"
    for (const e of entries) {
      if (result.has(e.id)) continue;
      const eDate = toISODate(plannedEntryDate(plan, e));
      for (const w of runs) {
        if (used.has(w.workoutId)) continue;
        if (workoutDate(w) !== eDate) continue;
        if (withinTolerance(e, w)) {
          result.set(e.id, { activity: w, quality: "full" });
          used.add(w.workoutId);
          break;
        }
      }
    }

    // Pass 2: ±1 day, distance within tolerance → "full"
    for (const e of entries) {
      if (result.has(e.id)) continue;
      const eDate = toISODate(plannedEntryDate(plan, e));
      for (const w of runs) {
        if (used.has(w.workoutId)) continue;
        if (!withinOneDay(workoutDate(w), eDate)) continue;
        if (withinTolerance(e, w)) {
          result.set(e.id, { activity: w, quality: "full" });
          used.add(w.workoutId);
          break;
        }
      }
    }

    // Pass 3: exact day, any distance → "partial"
    for (const e of entries) {
      if (result.has(e.id)) continue;
      const eDate = toISODate(plannedEntryDate(plan, e));
      for (const w of runs) {
        if (used.has(w.workoutId)) continue;
        if (workoutDate(w) !== eDate) continue;
        result.set(e.id, { activity: w, quality: "partial" });
        used.add(w.workoutId);
        break;
      }
    }

    // Pass 4: ±1 day, any distance → "partial"
    for (const e of entries) {
      if (result.has(e.id)) continue;
      const eDate = toISODate(plannedEntryDate(plan, e));
      for (const w of runs) {
        if (used.has(w.workoutId)) continue;
        if (!withinOneDay(workoutDate(w), eDate)) continue;
        result.set(e.id, { activity: w, quality: "partial" });
        used.add(w.workoutId);
        break;
      }
    }

    for (const e of entries) {
      if (!result.has(e.id)) result.set(e.id, null);
    }
  }

  return result;
}

/**
 * Compute week-level completion result for a given week index.
 */
export function matchWeekRuns(
  plan: RunningPlan,
  weekIndex: number,
  workouts: HealthWorkout[]
): WeekMatchResult {
  const week = plan.weeks[weekIndex];
  if (!week) return { planned: 0, actual: 0, status: "upcoming" };

  const matchMap = matchPlanToActual(plan, workouts);
  const runEntries = week.entries.filter((e) => e.runType !== "rest");

  const planned = runEntries.reduce((s, e) => s + e.distanceMiles, 0);
  const actual = runEntries.reduce((s, e) => {
    const m = matchMap.get(e.id);
    return s + (m ? m.activity.distanceMiles : 0);
  }, 0);

  // Determine status
  const weekStart = new Date(plan.startDate + "T00:00:00");
  weekStart.setDate(weekStart.getDate() + weekIndex * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const now = new Date();

  if (weekEnd > now) return { planned, actual, status: "upcoming" };
  if (planned === 0) return { planned, actual, status: "upcoming" };
  if (actual >= planned * 0.85) return { planned, actual, status: "met" };
  if (actual > 0) return { planned, actual, status: "partial" };
  return { planned, actual, status: "missed" };
}
