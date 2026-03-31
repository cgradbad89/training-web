import { type RunningPlan, type PlannedRunEntry } from "@/types/plan";
import { type StravaActivity } from "@/types/activity";

export type MatchQuality = "full" | "partial";

export interface PlanMatch {
  activity: StravaActivity;
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

function activityDate(a: StravaActivity): string {
  return a.start_date_local.split("T")[0];
}

function withinTolerance(e: PlannedRunEntry, a: StravaActivity): boolean {
  return (
    Math.abs(a.distance_miles - e.distanceMiles) <=
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
  activities: StravaActivity[]
): Map<string, PlanMatch | null> {
  const runs = activities.filter(
    (a) => a.type === "Run" || a.type === "TrailRun"
  );
  const result = new Map<string, PlanMatch | null>();

  for (const week of plan.weeks) {
    const entries = week.entries.filter((e) => e.runType !== "rest");
    const used = new Set<number>();

    // Pass 1: exact day, distance within tolerance → "full"
    for (const e of entries) {
      if (result.has(e.id)) continue;
      const eDate = toISODate(plannedEntryDate(plan, e));
      for (const a of runs) {
        if (used.has(a.id)) continue;
        if (activityDate(a) !== eDate) continue;
        if (withinTolerance(e, a)) {
          result.set(e.id, { activity: a, quality: "full" });
          used.add(a.id);
          break;
        }
      }
    }

    // Pass 2: ±1 day, distance within tolerance → "full"
    for (const e of entries) {
      if (result.has(e.id)) continue;
      const eDate = toISODate(plannedEntryDate(plan, e));
      for (const a of runs) {
        if (used.has(a.id)) continue;
        if (!withinOneDay(activityDate(a), eDate)) continue;
        if (withinTolerance(e, a)) {
          result.set(e.id, { activity: a, quality: "full" });
          used.add(a.id);
          break;
        }
      }
    }

    // Pass 3: exact day, any distance → "partial"
    for (const e of entries) {
      if (result.has(e.id)) continue;
      const eDate = toISODate(plannedEntryDate(plan, e));
      for (const a of runs) {
        if (used.has(a.id)) continue;
        if (activityDate(a) !== eDate) continue;
        result.set(e.id, { activity: a, quality: "partial" });
        used.add(a.id);
        break;
      }
    }

    // Pass 4: ±1 day, any distance → "partial"
    for (const e of entries) {
      if (result.has(e.id)) continue;
      const eDate = toISODate(plannedEntryDate(plan, e));
      for (const a of runs) {
        if (used.has(a.id)) continue;
        if (!withinOneDay(activityDate(a), eDate)) continue;
        result.set(e.id, { activity: a, quality: "partial" });
        used.add(a.id);
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
  activities: StravaActivity[]
): WeekMatchResult {
  const week = plan.weeks[weekIndex];
  if (!week) return { planned: 0, actual: 0, status: "upcoming" };

  const matchMap = matchPlanToActual(plan, activities);
  const runEntries = week.entries.filter((e) => e.runType !== "rest");

  const planned = runEntries.reduce((s, e) => s + e.distanceMiles, 0);
  const actual = runEntries.reduce((s, e) => {
    const m = matchMap.get(e.id);
    return s + (m ? m.activity.distance_miles : 0);
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
