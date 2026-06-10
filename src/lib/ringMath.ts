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
