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

// Runs more than 3 miles shorter than planned don't match — prevents a 4-mile
// actual run from matching an 8-mile planned session.
const DISTANCE_SHORTFALL_THRESHOLD = 3.0;

function isDistanceAcceptable(
  actualMiles: number,
  plannedMiles: number
): boolean {
  if (!plannedMiles || plannedMiles <= 0) return true;
  return plannedMiles - actualMiles <= DISTANCE_SHORTFALL_THRESHOLD;
}

/** DST-safe calendar day difference using local date components */
function differenceInCalendarDays(a: string, b: string): number {
  // Parse as local dates (YYYY-MM-DD) to avoid timezone/DST issues
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const aUtcMs = Date.UTC(ay, am - 1, ad);
  const bUtcMs = Date.UTC(by, bm - 1, bd);
  return Math.round((aUtcMs - bUtcMs) / 86400000);
}

function withinOneDay(aDate: string, eDate: string): boolean {
  return Math.abs(differenceInCalendarDays(aDate, eDate)) <= 1;
}

/** ISO week number (week containing Thursday, starts Monday) using UTC components */
function isoWeekNumber(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * When multiple entries compete for the same run within ±1 day,
 * pick the best candidate using tiebreaker rules:
 *   1. Prefer same/past ISO week over future week
 *   2. Prefer closest calendar day
 *   3. Prefer closest planned distance to actual run distance
 *   4. Prefer earlier planned date as final tiebreaker
 */
function pickBestCandidate(
  candidates: { entry: PlannedRunEntry; eDate: string; diffDays: number }[],
  runDateStr: string,
  runDistanceMiles: number
): { entry: PlannedRunEntry; eDate: string; diffDays: number } | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const runWeek = isoWeekNumber(runDateStr);

  // Rule 1: Prefer same/past week over future week
  const sameOrPast = candidates.filter((c) => isoWeekNumber(c.eDate) <= runWeek);
  const pool = sameOrPast.length > 0 ? sameOrPast : candidates;

  // Rule 2: Prefer closest calendar day
  const minDiff = Math.min(...pool.map((c) => c.diffDays));
  const closest = pool.filter((c) => c.diffDays === minDiff);
  if (closest.length === 1) return closest[0];

  // Rule 3: Prefer closest planned mileage
  const withDistDiff = closest.map((c) => ({
    ...c,
    distDiff: Math.abs(c.entry.distanceMiles - runDistanceMiles),
  }));
  const minDistDiff = Math.min(...withDistDiff.map((c) => c.distDiff));
  const byDist = withDistDiff.filter((c) => c.distDiff === minDistDiff);
  if (byDist.length === 1) return byDist[0];

  // Rule 4: Prefer earlier planned date
  byDist.sort((a, b) => a.eDate.localeCompare(b.eDate));
  return byDist[0];
}

/**
 * 4-pass plan vs actual matching with global used-set and tiebreaker rules.
 * Returns a map: entryId → PlanMatch | null
 */
export function matchPlanToActual(
  plan: RunningPlan,
  workouts: HealthWorkout[]
): Map<string, PlanMatch | null> {
  const runs = workouts.filter((w) => w.isRunLike);
  const result = new Map<string, PlanMatch | null>();
  // Global used set — prevents a run from matching entries across different weeks
  const usedGlobal = new Set<string>();

  // Collect all non-rest entries with their planned dates
  const allEntries: { entry: PlannedRunEntry; eDate: string }[] = [];
  for (const week of plan.weeks) {
    for (const e of week.entries) {
      if (e.runType === "rest") continue;
      allEntries.push({ entry: e, eDate: toISODate(plannedEntryDate(plan, e)) });
    }
  }

  // Pass 1: exact day, distance within tolerance → "full"
  for (const { entry: e, eDate } of allEntries) {
    if (result.has(e.id)) continue;
    for (const w of runs) {
      if (usedGlobal.has(w.workoutId)) continue;
      if (workoutDate(w) !== eDate) continue;
      if (withinTolerance(e, w) && isDistanceAcceptable(w.distanceMiles, e.distanceMiles)) {
        result.set(e.id, { activity: w, quality: "full" });
        usedGlobal.add(w.workoutId);
        break;
      }
    }
  }

  // Pass 2: ±1 day, distance within tolerance → "full" (with tiebreaker)
  // Group unmatched entries competing for the same run
  for (const w of runs) {
    if (usedGlobal.has(w.workoutId)) continue;
    const wDate = workoutDate(w);

    const candidates = allEntries
      .filter(({ entry: e, eDate }) => {
        if (result.has(e.id)) return false;
        if (!withinOneDay(wDate, eDate)) return false;
        if (!withinTolerance(e, w)) return false;
        if (!isDistanceAcceptable(w.distanceMiles, e.distanceMiles)) return false;
        return true;
      })
      .map(({ entry, eDate }) => ({
        entry,
        eDate,
        diffDays: Math.abs(differenceInCalendarDays(wDate, eDate)),
      }));

    const best = pickBestCandidate(candidates, wDate, w.distanceMiles);
    if (best) {
      result.set(best.entry.id, { activity: w, quality: "full" });
      usedGlobal.add(w.workoutId);
    }
  }

  // Pass 3: exact day, any distance → "partial"
  for (const { entry: e, eDate } of allEntries) {
    if (result.has(e.id)) continue;
    for (const w of runs) {
      if (usedGlobal.has(w.workoutId)) continue;
      if (workoutDate(w) !== eDate) continue;
      if (!isDistanceAcceptable(w.distanceMiles, e.distanceMiles)) continue;
      result.set(e.id, { activity: w, quality: "partial" });
      usedGlobal.add(w.workoutId);
      break;
    }
  }

  // Pass 4: ±1 day, any distance → "partial" (with tiebreaker)
  for (const w of runs) {
    if (usedGlobal.has(w.workoutId)) continue;
    const wDate = workoutDate(w);

    const candidates = allEntries
      .filter(({ entry: e, eDate }) => {
        if (result.has(e.id)) return false;
        if (!withinOneDay(wDate, eDate)) return false;
        if (!isDistanceAcceptable(w.distanceMiles, e.distanceMiles)) return false;
        return true;
      })
      .map(({ entry, eDate }) => ({
        entry,
        eDate,
        diffDays: Math.abs(differenceInCalendarDays(wDate, eDate)),
      }));

    const best = pickBestCandidate(candidates, wDate, w.distanceMiles);
    if (best) {
      result.set(best.entry.id, { activity: w, quality: "partial" });
      usedGlobal.add(w.workoutId);
    }
  }

  // Mark unmatched entries as null
  for (const { entry: e } of allEntries) {
    if (!result.has(e.id)) result.set(e.id, null);
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
