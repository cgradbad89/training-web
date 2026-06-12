/**
 * Trend-window selection + direction for route pace displays (Routes page
 * sparkline and trend drawer). Pure, no Firestore.
 *
 * Window rule (approved product decision):
 *   1. total runs ≤ 30            → all runs
 *   2. else if last-6-months ≤ 20 → last 6 months (min 1 run)
 *   3. else                       → last 10 runs
 * Output is always sorted ascending by date.
 */

import { type MatchedRunSummary } from "@/utils/routePerformance";

export const TREND_ALL_MAX = 30;
export const TREND_SIX_MONTH_MAX = 20;
export const TREND_RECENT_COUNT = 10;

/** ISO "YYYY-MM-DD" for the local date 6 calendar months before `now`. */
function sixMonthsAgoIso(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function selectRouteTrendRuns(
  runs: MatchedRunSummary[],
  now: Date = new Date()
): MatchedRunSummary[] {
  const asc = [...runs].sort((a, b) => a.date.localeCompare(b.date));
  if (asc.length === 0) return [];
  if (asc.length <= TREND_ALL_MAX) return asc;

  const cutoff = sixMonthsAgoIso(now);
  const lastSixMonths = asc.filter((r) => r.date >= cutoff);
  if (lastSixMonths.length <= TREND_SIX_MONTH_MAX) {
    // "min 1 run": a route not run in 6 months still shows its latest point.
    return lastSixMonths.length > 0 ? lastSixMonths : asc.slice(-1);
  }

  return asc.slice(-TREND_RECENT_COUNT);
}

export type PaceTrendDirection = "improving" | "steady";

/**
 * Sparkline direction: "improving" when the most-recent pace in the window is
 * faster (lower sec/mi) than the earliest; "steady" otherwise. Null below 2
 * runs (a single point has no direction). Sorts defensively by date.
 */
export function paceTrendDirection(
  windowRuns: MatchedRunSummary[]
): PaceTrendDirection | null {
  if (windowRuns.length < 2) return null;
  const asc = [...windowRuns].sort((a, b) => a.date.localeCompare(b.date));
  const earliest = asc[0];
  const latest = asc[asc.length - 1];
  return latest.paceSeconds < earliest.paceSeconds ? "improving" : "steady";
}
