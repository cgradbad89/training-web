/**
 * Weekly activity selection and grouping (pure — no React, no Firebase).
 *
 * Extracted verbatim from the Dashboard's inline weekly logic so the page and
 * the Hub summary endpoint share one implementation:
 *   - `isWorkoutInWeek`  ← dashboard `isInWeek` (start instant, both bounds inclusive)
 *   - `selectWeekRuns`   ← RunningStatsCard / actualMiles filter `w.isRunLike && isInWeek(…)`
 *   - `selectWeekNonRuns`← WorkoutsStatsCard filter `!w.isRunLike && isInWeek(…)`
 *   - `sumRunMiles`      ← `runs.reduce((s, w) => s + w.distanceMiles, 0)`
 *
 * Week bounds are explicit instants supplied by the caller (the browser passes
 * its host-local `weekStart`/`weekEnd`; the server passes Eastern instants from
 * `zonedWeekFor`), so these functions never consult the host timezone. Only
 * `groupByDay` needs a calendar: with no `timeZone` it buckets by the HOST-LOCAL
 * day (the dashboard's existing behavior); with a named zone it buckets by that
 * zone's civil date.
 *
 * Callers pass the effective projection (`selectEffectiveWorkouts`): exclusions
 * removed and overrides applied.
 */

import { toLocalIsoDate } from "@/utils/dates";
import { zonedDateKey } from "@/lib/hubWeek";

interface HasStart {
  startDate: Date;
}
interface RunFlagged extends HasStart {
  isRunLike: boolean;
}
interface HasMiles {
  distanceMiles: number;
}

/** Start instant within [weekStart, weekEnd], both inclusive. */
export function isWorkoutInWeek(w: HasStart, weekStart: Date, weekEnd: Date): boolean {
  const d = w.startDate;
  return d >= weekStart && d <= weekEnd;
}

/** Effective runs whose start falls in the week (input order preserved). */
export function selectWeekRuns<W extends RunFlagged>(
  workouts: W[],
  weekStart: Date,
  weekEnd: Date
): W[] {
  return workouts.filter((w) => w.isRunLike && isWorkoutInWeek(w, weekStart, weekEnd));
}

/** Effective non-run records whose start falls in the week (input order preserved). */
export function selectWeekNonRuns<W extends RunFlagged>(
  workouts: W[],
  weekStart: Date,
  weekEnd: Date
): W[] {
  return workouts.filter((w) => !w.isRunLike && isWorkoutInWeek(w, weekStart, weekEnd));
}

/** Total run distance in miles (summed in input order, like the dashboard). */
export function sumRunMiles(runs: HasMiles[]): number {
  return runs.reduce((s, w) => s + w.distanceMiles, 0);
}

export interface WeekActivitySummary<W> {
  runs: W[];
  nonRuns: W[];
  runMiles: number;
}

export function summarizeWeekActivity<W extends RunFlagged & HasMiles>(
  workouts: W[],
  weekStart: Date,
  weekEnd: Date
): WeekActivitySummary<W> {
  const runs = selectWeekRuns(workouts, weekStart, weekEnd);
  return {
    runs,
    nonRuns: selectWeekNonRuns(workouts, weekStart, weekEnd),
    runMiles: sumRunMiles(runs),
  };
}

export interface DayGroupingOptions {
  /** IANA zone. Omitted → HOST-LOCAL calendar days (existing dashboard behavior). */
  timeZone?: string;
}

/** "YYYY-MM-DD" key for the instant, in the named zone or (default) host-local. */
export function activityDayKey(instant: Date, options: DayGroupingOptions = {}): string {
  return options.timeZone ? zonedDateKey(instant, options.timeZone) : toLocalIsoDate(instant);
}

/**
 * Group activities by calendar day; each day's list is ordered by start time
 * then workoutId so output is deterministic regardless of query order.
 */
export function groupByDay<W extends HasStart & { workoutId: string }>(
  workouts: W[],
  options: DayGroupingOptions = {}
): Map<string, W[]> {
  const byDay = new Map<string, W[]>();
  for (const w of workouts) {
    const key = activityDayKey(w.startDate, options);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(w);
    else byDay.set(key, [w]);
  }
  for (const bucket of byDay.values()) {
    bucket.sort(
      (a, b) =>
        a.startDate.getTime() - b.startDate.getTime() ||
        (a.workoutId < b.workoutId ? -1 : a.workoutId > b.workoutId ? 1 : 0)
    );
  }
  return byDay;
}
