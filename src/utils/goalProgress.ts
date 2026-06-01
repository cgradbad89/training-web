/**
 * Pure progress computation for custom running Goals.
 *
 * Runs are typed as HealthWorkout (the app's run/workout document); only
 * startDate, distanceMiles, and durationSeconds are read here.
 */

import { type RunningGoal } from "@/types/goal";
import { type HealthWorkout } from "@/types/healthWorkout";

export type GoalPaceStatus =
  | "ahead"
  | "on_track"
  | "behind"
  | "completed"
  | "upcoming";

export type GoalStatus = "active" | "upcoming" | "completed";

export interface GoalProgress {
  /** Same unit as the goal's metric (miles | seconds | count) */
  actual: number;
  target: number;
  /** True percent (0..100+); callers clamp the DISPLAY at 100. */
  percent: number;
  daysElapsed: number;
  daysTotal: number;
  paceStatus: GoalPaceStatus;
  /** By date range vs. today */
  status: GoalStatus;
}

const MS_PER_DAY = 86_400_000;

/** Local calendar date as 'YYYY-MM-DD' (TZ-stable comparison key). */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a 'YYYY-MM-DD' string as a local midnight Date. */
function parseLocal(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Whole-day difference (b - a), rounded to absorb any DST drift. */
function diffDays(aStr: string, bStr: string): number {
  return Math.round(
    (parseLocal(bStr).getTime() - parseLocal(aStr).getTime()) / MS_PER_DAY
  );
}

export function computeGoalProgress(
  goal: RunningGoal,
  runs: HealthWorkout[],
  today: Date
): GoalProgress {
  const todayStr = localDateStr(today);
  const { startDate: start, endDate: end, target, metric } = goal;

  // ─── Status by date range ──────────────────────────────────────────────
  let status: GoalStatus;
  if (todayStr < start) status = "upcoming";
  else if (todayStr > end) status = "completed";
  else status = "active";

  // ─── Day counts (guard divide-by-zero: single-day range → daysTotal 1) ──
  const daysTotal = Math.max(1, diffDays(start, end) + 1);
  let daysElapsed: number;
  if (status === "upcoming") {
    daysElapsed = 0;
  } else if (status === "completed") {
    daysElapsed = daysTotal;
  } else {
    // Inclusive of the start day → today === startDate is day 1.
    daysElapsed = Math.min(daysTotal, Math.max(1, diffDays(start, todayStr) + 1));
  }

  // ─── Actual: sum runs whose date falls within [startDate, endDate] ──────
  let actual = 0;
  for (const r of runs) {
    const ds = localDateStr(new Date(r.startDate));
    if (ds < start || ds > end) continue;
    if (metric === "distance") actual += r.distanceMiles ?? 0;
    else if (metric === "time") actual += r.durationSeconds ?? 0;
    else actual += 1; // count
  }

  const percent = target > 0 ? (actual / target) * 100 : 0;

  // ─── Pace status ───────────────────────────────────────────────────────
  let paceStatus: GoalPaceStatus;
  if (status === "completed") {
    paceStatus = "completed"; // met-or-not is reported via percent
  } else if (status === "upcoming") {
    paceStatus = "upcoming";
  } else {
    const expected = target * (daysElapsed / daysTotal);
    if (actual >= expected * 1.02) paceStatus = "ahead";
    else if (actual <= expected * 0.98) paceStatus = "behind";
    else paceStatus = "on_track";
  }

  return { actual, target, percent, daysElapsed, daysTotal, paceStatus, status };
}
