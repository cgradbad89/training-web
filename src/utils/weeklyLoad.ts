/**
 * Weekly Training Load tile — selection + classification logic (pure, no
 * Firestore). Powers the Personal Insights tile that replaced the 16-week
 * stacked bar chart.
 *
 * - Weeks are Monday-start (PRD §4.2) via the shared weekStart helper; all
 *   date keys are LOCAL "YYYY-MM-DD" strings (PRD invariant #12 — no UTC
 *   parsing anywhere in this module).
 * - Every displayed load resolves through resolveDisplayLoad (single source
 *   of truth); null loads stay null on rows and are SKIPPED in totals (never
 *   coerced to 0).
 */

import { type HealthWorkout } from "@/types/healthWorkout";
import { resolveDisplayLoad } from "@/utils/trainingLoad";
import { weekStart } from "@/utils/dates";

export interface WeekActivity {
  id: string;
  kind: "run" | "workout";
  /** Existing display-name logic: HealthWorkout.name (== displayType). */
  name: string;
  /** Total distance in miles (for the distance-qualified auto-title); may be
   *  absent/0 for non-distance workouts. In-memory only — no extra read. */
  distanceMiles?: number;
  /** ISO "YYYY-MM-DD" (local calendar date). */
  date: string;
  elapsedSeconds: number;
  /** Via resolveDisplayLoad; null if unavailable (renders "—"). */
  load: number | null;
}

export interface WeekLoadSummary {
  /** ISO Monday "YYYY-MM-DD" (local). */
  weekStart: string;
  /** Sum of resolveDisplayLoad across the week's activities (nulls skipped). */
  total: number;
  /** Newest first. */
  activities: WeekActivity[];
}

export type LoadBand = "below" | "typical" | "above" | "wellAbove";

// Band thresholds as fractions of the 6-month median weekly load.
// TUNABLE — flagged for product-owner calibration against real data.
export const LOAD_BAND_BELOW_MAX = 0.75; // below:    total <  75% of median
export const LOAD_BAND_TYPICAL_MAX = 1.15; // typical: 75% – 115% (inclusive)
export const LOAD_BAND_ABOVE_MAX = 1.45; // above:   >115% – 145% (inclusive)
// wellAbove: > 145%

/**
 * Classify a week's total against the 6-month MEDIAN weekly load. Zero/absent
 * median (new user, no baseline) → "typical" — no division, no blowup; the
 * tile shows a "no baseline yet" state instead of a band label in that case.
 */
export function classifyWeekLoad(
  total: number,
  medianWeekly: number
): LoadBand {
  if (medianWeekly <= 0) return "typical";
  const ratio = total / medianWeekly;
  if (ratio < LOAD_BAND_BELOW_MAX) return "below";
  if (ratio <= LOAD_BAND_TYPICAL_MAX) return "typical";
  if (ratio <= LOAD_BAND_ABOVE_MAX) return "above";
  return "wellAbove";
}

/** Display window: one point per week, consistent with the replaced chart. */
export const WEEKLY_LOAD_WEEKS_BACK = 16;
/** Median baseline window in calendar months. */
export const WEEKLY_LOAD_MEDIAN_MONTHS = 6;

export interface WeeklyLoadModel {
  /** Oldest → newest; always WEEKLY_LOAD_WEEKS_BACK entries, zero-activity
   *  weeks included (total 0, empty activities). Last entry = current week. */
  weeks: WeekLoadSummary[];
  /** 6-month median weekly load. COMPLETED weeks only (the in-progress week
   *  would bias the baseline down) and weeks with ≥1 activity only (per
   *  spec, zero-activity weeks are excluded from the median). 0 = no
   *  baseline yet. */
  medianWeekly: number;
}

/** YYYY-MM-DD from a Date using its local components. */
function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Build the tile's full model from already-loaded workouts (runs AND non-run
 * workouts — matching the stacked chart this replaces). One pass buckets
 * every workout by its week's Monday; the display series and the median
 * baseline read from the same buckets, so they can never disagree.
 */
export function buildWeeklyLoadModel(
  workouts: HealthWorkout[],
  maxHr: number,
  restingHr: number,
  now: Date = new Date()
): WeeklyLoadModel {
  const currentMonday = weekStart(now);
  const currentMondayIso = toLocalIsoDate(currentMonday);

  // Median lookback: Mondays on/after the week containing (now − 6 months).
  const medianFloor = new Date(now);
  medianFloor.setMonth(medianFloor.getMonth() - WEEKLY_LOAD_MEDIAN_MONTHS);
  const medianFloorIso = toLocalIsoDate(weekStart(medianFloor));

  // Bucket every workout by its Monday (covers both windows in one pass).
  const buckets = new Map<string, WeekActivity[]>();
  for (const w of workouts) {
    const mondayIso = toLocalIsoDate(weekStart(w.startDate));
    const activity: WeekActivity = {
      id: w.workoutId,
      kind: w.isRunLike ? "run" : "workout",
      name: w.name || w.displayType,
      distanceMiles: w.distanceMiles,
      date: toLocalIsoDate(w.startDate),
      elapsedSeconds: w.durationSeconds,
      load: resolveDisplayLoad(w, maxHr, restingHr),
    };
    const list = buckets.get(mondayIso);
    if (list) list.push(activity);
    else buckets.set(mondayIso, [activity]);
  }

  const totalFor = (activities: WeekActivity[]): number =>
    activities.reduce((sum, a) => (a.load != null ? sum + a.load : sum), 0);

  // Display series: last N weeks, oldest → newest, empty weeks included.
  const weeks: WeekLoadSummary[] = Array.from(
    { length: WEEKLY_LOAD_WEEKS_BACK },
    (_, i) => {
      const monday = new Date(currentMonday);
      monday.setDate(
        currentMonday.getDate() - (WEEKLY_LOAD_WEEKS_BACK - 1 - i) * 7
      );
      const iso = toLocalIsoDate(monday);
      const activities = [...(buckets.get(iso) ?? [])].sort((a, b) =>
        b.date.localeCompare(a.date)
      );
      return { weekStart: iso, total: totalFor(activities), activities };
    }
  );

  // Median baseline: completed (pre-current) weeks with ≥1 activity, within
  // the 6-month lookback.
  const medianTotals: number[] = [];
  for (const [mondayIso, activities] of buckets) {
    if (mondayIso >= currentMondayIso) continue; // in-progress / future
    if (mondayIso < medianFloorIso) continue; // older than 6 months
    if (activities.length === 0) continue;
    medianTotals.push(totalFor(activities));
  }

  return { weeks, medianWeekly: median(medianTotals) };
}

/**
 * Week-navigation step with hard bounds: index 0 = oldest week in the window,
 * weekCount−1 = current week. ‹/› can never step outside [0, weekCount−1].
 */
export function stepWeekIndex(
  current: number,
  delta: number,
  weekCount: number
): number {
  if (weekCount <= 0) return 0;
  return Math.min(Math.max(current + delta, 0), weekCount - 1);
}
