/**
 * Pure ring-math helpers for the Apple-style health goal rings.
 *
 * No Firestore imports — everything computes in-memory from data the caller
 * already fetched (healthMetrics docs + healthGoals versions).
 *
 * Invariants:
 * - Progress is UNCAPPED everywhere: 1.42 = 142%; rendering wraps past 100%.
 * - Goals are effective-dated: a day is always scored against the goal
 *   version active on that day, so changing goals never re-scores history.
 * - Each goal version stores 7 per-day-of-week values per metric.
 * - Period progress is sum-vs-sum: Σ actual ÷ Σ resolved daily goals over
 *   the same range. Days with no healthMetrics doc contribute 0 to the
 *   numerator but their goal still counts in the denominator.
 * - All date strings are local "YYYY-MM-DD" (the healthMetrics doc format);
 *   weeks are Monday-start, matching src/utils/dates.ts.
 */

import type {
  DayOfWeekGoals,
  HealthGoalDoc,
  RingMetric,
} from "@/types/healthGoal";

export type { DayOfWeekGoals, HealthGoalDoc, RingMetric };

/**
 * Provisional defaults applied when no goal version covers a date — same
 * value all 7 days. Pending product-owner confirmation.
 */
export const DEFAULT_GOALS: Record<RingMetric, number> = {
  steps: 10000,
  exercise_mins: 30,
  move_calories: 500,
  stand_hours: 12,
  sleep_total_hours: 8,
};

/** Ring order, outer → inner. */
export const RING_METRICS: readonly RingMetric[] = [
  "steps",
  "exercise_mins",
  "move_calories",
  "stand_hours",
  "sleep_total_hours",
];

// Indexed by Date.getDay() (0 = Sunday).
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Weekday key ('mon'…'sun') for a local "YYYY-MM-DD" date. */
export function weekdayKey(date: string): keyof DayOfWeekGoals {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAY_KEYS[new Date(y, m - 1, d).getDay()];
}

/** Local "YYYY-MM-DD" for a Date. */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Shift a "YYYY-MM-DD" by N calendar days (local). */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return toIsoDate(new Date(y, m - 1, d + days));
}

/** Every "YYYY-MM-DD" from startDate to endDate inclusive ([] when start > end). */
export function eachDate(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let cur = startDate;
  while (cur <= endDate) {
    dates.push(cur);
    cur = shiftDate(cur, 1);
  }
  return dates;
}

/** Inclusive day count between two local ISO dates; 0 when start > end. */
function inclusiveDays(startDate: string, endDate: string): number {
  if (startDate > endDate) return 0;
  const [y1, m1, d1] = startDate.split("-").map(Number);
  const [y2, m2, d2] = endDate.split("-").map(Number);
  const ms =
    new Date(y2, m2 - 1, d2).getTime() - new Date(y1, m1 - 1, d1).getTime();
  // Math.round absorbs the ±1h DST offset in local-date diffs.
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * Where progress SHOULD be at this point in a period: elapsedDays/totalDays,
 * clamped to [0, 1]. totalDays spans the FULL period [startDate..endDate]
 * (e.g. 7 for a week, even when actuals are capped at today); elapsedDays
 * spans [startDate..min(today, endDate)], inclusive — Wednesday of a Mon–Sun
 * week → 3/7. Before the period starts → 0. Renderers hide the tick at 0
 * and 1, so completed periods and single-day periods show no marker.
 */
export function onPaceFraction(
  startDate: string,
  endDate: string,
  today: string
): number {
  const total = inclusiveDays(startDate, endDate);
  if (total <= 0) return 0;
  if (today < startDate) return 0;
  const cappedEnd = today > endDate ? endDate : today;
  const elapsed = inclusiveDays(startDate, cappedEnd);
  return Math.min(1, Math.max(0, elapsed / total));
}

/**
 * Daily-average view of a multi-day ring period (Total ↔ Daily Avg toggle).
 *
 * The ring FILL never changes — this only reshapes the displayed value/goal:
 * - daysElapsed = inclusive days from periodStart through min(today, periodEnd)
 *   (current week on a Thursday → 4; a completed month → its full day count;
 *   YTD → day-of-year). Before the period starts → 0.
 * - avgValue = periodTotal / daysElapsed
 * - avgGoal  = (Σ resolved per-day goals over the SAME daysElapsed window) /
 *   daysElapsed — `dailyGoals` are the per-day resolved goals (already
 *   per-day-of-week aware); only the first daysElapsed entries are summed, so
 *   the goal average respects the elapsed window rather than the full period.
 *
 * Zero daysElapsed (period starts in the future) returns zeros — no divide.
 */
export function ringDailyAverage(args: {
  periodTotal: number;
  periodStart: Date;
  periodEnd: Date;
  dailyGoals: number[];
  today: Date;
}): { avgValue: number; avgGoal: number; daysElapsed: number } {
  const { periodTotal, periodStart, periodEnd, dailyGoals, today } = args;
  const startIso = toIsoDate(periodStart);
  const endIso = toIsoDate(periodEnd);
  const todayIso = toIsoDate(today);

  // Period hasn't started yet → nothing elapsed, guard divide-by-zero.
  if (todayIso < startIso) return { avgValue: 0, avgGoal: 0, daysElapsed: 0 };

  const cappedEnd = todayIso > endIso ? endIso : todayIso;
  const daysElapsed = inclusiveDays(startIso, cappedEnd);
  if (daysElapsed <= 0) return { avgValue: 0, avgGoal: 0, daysElapsed: 0 };

  const goalSum = dailyGoals
    .slice(0, daysElapsed)
    .reduce((s, g) => s + (Number.isFinite(g) ? g : 0), 0);

  return {
    avgValue: periodTotal / daysElapsed,
    avgGoal: goalSum / daysElapsed,
    daysElapsed,
  };
}

/**
 * Resolve the goal for one metric on one date: pick the goal version with
 * the LATEST effectiveFrom <= date (createdAt breaks same-day ties); within
 * it, the value for that date's weekday. Falls back to DEFAULT_GOALS when no
 * version qualifies (or the qualifying doc is missing the metric).
 */
export function resolveGoalForDate(
  goals: HealthGoalDoc[],
  metric: RingMetric,
  date: string
): number {
  let active: HealthGoalDoc | null = null;
  for (const g of goals) {
    if (g.effectiveFrom > date) continue;
    if (
      active === null ||
      g.effectiveFrom > active.effectiveFrom ||
      (g.effectiveFrom === active.effectiveFrom &&
        g.createdAt > active.createdAt)
    ) {
      active = g;
    }
  }
  const value = active?.metrics?.[metric]?.[weekdayKey(date)];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : DEFAULT_GOALS[metric];
}

/**
 * Daily ring progress, UNCAPPED (1.42 = 142%; the ring wraps past 100%).
 * null/undefined/0 value → 0. Non-positive goal → 0 (guard, not an error).
 */
export function dailyRingProgress(
  value: number | null | undefined,
  goal: number
): number {
  if (value == null || value <= 0 || !Number.isFinite(value)) return 0;
  if (!(goal > 0) || !Number.isFinite(goal)) return 0;
  return value / goal;
}

/**
 * Period ring progress, sum-vs-sum: Σ actual over [startDate..endDate] ÷
 * Σ resolved daily goals over the SAME range. Dates in `days` outside the
 * range are ignored; dates in the range missing from `days` (or with a null
 * value) contribute 0 to the numerator while their goal still counts in the
 * denominator. Callers must clamp endDate to today for to-date periods.
 */
export function periodRingProgress(
  days: { date: string; value: number | null }[],
  goals: HealthGoalDoc[],
  metric: RingMetric,
  startDate: string,
  endDate: string
): number {
  const valueByDate = new Map<string, number>();
  for (const d of days) {
    if (d.value != null && d.value > 0 && Number.isFinite(d.value)) {
      valueByDate.set(d.date, d.value);
    }
  }

  let actualSum = 0;
  let goalSum = 0;
  for (const date of eachDate(startDate, endDate)) {
    actualSum += valueByDate.get(date) ?? 0;
    goalSum += resolveGoalForDate(goals, metric, date);
  }

  if (!(goalSum > 0)) return 0;
  return actualSum / goalSum;
}
