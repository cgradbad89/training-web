/**
 * VO₂ max (Cardio Fitness) history windowing.
 *
 * The personal-insights VO₂ chart reads sparse `vo2_max` readings from
 * users/{uid}/healthMetrics. That query was previously unbounded
 * (`where('vo2_max', '>', 0)` with no date bound), so it grew without limit as
 * healthMetrics accumulated day over day.
 *
 * We bound it to a trailing window using a single `date >= cutoff` inequality
 * (with a matching `orderBy('date')`) — the same shape the fetchHealthMetrics*
 * helpers already use, which only needs Firestore's automatic single-field
 * index. The `vo2_max > 0` condition stays a client-side filter, so no
 * two-field composite index is required.
 */

import { localDateCutoff } from "@/utils/dates";

/** Trailing window (days) for the VO₂ max history chart. */
export const VO2_HISTORY_DAYS = 180;

/**
 * The inclusive lower-bound `date` string (YYYY-MM-DD) for the VO₂ history
 * query, `days` before `now`, as a LOCAL date. Same derivation as
 * `healthMetricsCutoffISO` in services/healthMetrics.ts.
 */
export function vo2HistoryCutoffISO(now: Date, days: number = VO2_HISTORY_DAYS): string {
  // Local calendar date: `toISOString().split("T")[0]` is the UTC date, which is
  // already tomorrow after 19:00 in US Eastern and shifted the cutoff a day.
  return localDateCutoff(days, now);
}

export interface Vo2Entry {
  date: string;
  value: number;
}

export function buildVo2History(
  rawDocs: { id: string; data: { date?: string; vo2_max?: number } }[]
): Vo2Entry[] {
  return rawDocs
    .map((d) => {
      const date = d.data.date ?? d.id;
      const value = typeof d.data.vo2_max === "number" ? d.data.vo2_max : 0;
      return { date, value };
    })
    .filter((e) => e.value > 0 && typeof e.date === "string")
    .sort((a, b) => a.date.localeCompare(b.date));
}

