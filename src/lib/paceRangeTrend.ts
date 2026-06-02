/**
 * Pace-range trend computation for the Personal Insights "Pace by distance"
 * section. Pure module — no React, no Firestore. Returns RAW seconds; callers
 * format for display.
 *
 * Week bucketing reuses `weekStart` (Monday-start) from src/utils/dates.ts to
 * match the app-wide convention. Month bucketing is implemented inline here
 * (`new Date(y, m, 1)`) because no shared month-start helper exists (confirmed
 * Phase 1 investigation).
 */

import { weekStart } from "@/utils/dates";

export type TrendWindow = "1m" | "2m" | "3m" | "6m" | "12m" | "ytd";
export type TrendGranularity = "week" | "month";

export interface PaceRangeRun {
  distanceMiles: number;
  durationSeconds: number;
  date: Date; // resolved from the run's startDate by the caller
}

export interface PaceTrendPoint {
  periodStart: Date; // week-start (Monday) or month-start
  label: string; // e.g. "May 5" (week) or "May" (month)
  avgPaceSeconds: number; // distance-weighted avg pace (sec/mi) within the period
  runCount: number;
}

export interface PaceRangeTrendBestRun {
  paceSeconds: number;
  date: Date;
  distanceMiles: number;
}

export interface PaceRangeTrendResult {
  points: PaceTrendPoint[];
  granularity: TrendGranularity;
  windowAvgPaceSeconds: number | null; // distance-weighted avg across all qualifying runs
  bestRun: PaceRangeTrendBestRun | null; // fastest single qualifying run (lowest sec/mi)
  totalRunCount: number; // qualifying runs in the whole window
}

// Pace sanity bounds (sec/mi). Mirrors the guard used elsewhere on this page
// for the fastest-mile computation.
const MIN_VALID_PACE = 180;
const MAX_VALID_PACE = 1200;

/** 1m/2m/3m bucket by week; 6m/12m/ytd bucket by month. */
export function granularityForWindow(window: TrendWindow): TrendGranularity {
  switch (window) {
    case "1m":
    case "2m":
    case "3m":
      return "week";
    case "6m":
    case "12m":
    case "ytd":
      return "month";
  }
}

/**
 * Inclusive start Date of the window relative to `now`.
 * `ytd` -> Jan 1 of now's year (local, midnight).
 * `Nm`  -> now minus N calendar months (same day/time).
 */
export function windowStartDate(window: TrendWindow, now: Date): Date {
  if (window === "ytd") {
    return new Date(now.getFullYear(), 0, 1);
  }
  const months: Record<Exclude<TrendWindow, "ytd">, number> = {
    "1m": 1,
    "2m": 2,
    "3m": 3,
    "6m": 6,
    "12m": 12,
  };
  const n = months[window];
  const d = new Date(now);
  d.setMonth(d.getMonth() - n);
  return d;
}

/** Month-start (local midnight) for the month containing `date`. */
function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function periodStartFor(date: Date, granularity: TrendGranularity): Date {
  return granularity === "week" ? weekStart(date) : monthStart(date);
}

function labelFor(periodStart: Date, granularity: TrendGranularity): string {
  if (granularity === "week") {
    return periodStart.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }
  return periodStart.toLocaleDateString("en-US", { month: "short" });
}

interface BucketAccum {
  periodStart: Date;
  totalSeconds: number;
  totalMiles: number;
  runCount: number;
}

/**
 * Filter runs to those with minMiles <= distanceMiles <= maxMiles AND
 * date >= windowStartDate(window, now), then bucket per granularity and
 * compute a DISTANCE-WEIGHTED per-period avg pace
 * (sum(durationSeconds) / sum(distanceMiles), never the mean of per-run paces).
 *
 * Guards: a run is ignored unless distanceMiles > 0, its pace is finite, and
 * its pace falls within [MIN_VALID_PACE, MAX_VALID_PACE] sec/mi.
 */
export function computePaceRangeTrend(
  runs: PaceRangeRun[],
  minMiles: number,
  maxMiles: number,
  window: TrendWindow,
  now: Date
): PaceRangeTrendResult {
  const granularity = granularityForWindow(window);
  const start = windowStartDate(window, now);

  const buckets = new Map<number, BucketAccum>();
  let windowTotalSeconds = 0;
  let windowTotalMiles = 0;
  let totalRunCount = 0;
  let bestRun: PaceRangeTrendBestRun | null = null;

  for (const run of runs) {
    // In-range = TOTAL distance within [minMiles, maxMiles] inclusive.
    if (run.distanceMiles < minMiles || run.distanceMiles > maxMiles) continue;
    if (run.date < start) continue;
    if (run.distanceMiles <= 0) continue;

    const pace = run.durationSeconds / run.distanceMiles;
    if (!Number.isFinite(pace)) continue;
    if (pace < MIN_VALID_PACE || pace > MAX_VALID_PACE) continue;

    totalRunCount += 1;
    windowTotalSeconds += run.durationSeconds;
    windowTotalMiles += run.distanceMiles;

    if (bestRun === null || pace < bestRun.paceSeconds) {
      bestRun = {
        paceSeconds: pace,
        date: run.date,
        distanceMiles: run.distanceMiles,
      };
    }

    const ps = periodStartFor(run.date, granularity);
    const key = ps.getTime();
    const existing = buckets.get(key);
    if (existing) {
      existing.totalSeconds += run.durationSeconds;
      existing.totalMiles += run.distanceMiles;
      existing.runCount += 1;
    } else {
      buckets.set(key, {
        periodStart: ps,
        totalSeconds: run.durationSeconds,
        totalMiles: run.distanceMiles,
        runCount: 1,
      });
    }
  }

  const points: PaceTrendPoint[] = Array.from(buckets.values())
    .sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime())
    .map((b) => ({
      periodStart: b.periodStart,
      label: labelFor(b.periodStart, granularity),
      avgPaceSeconds: b.totalSeconds / b.totalMiles,
      runCount: b.runCount,
    }));

  const windowAvgPaceSeconds =
    windowTotalMiles > 0 ? windowTotalSeconds / windowTotalMiles : null;

  return {
    points,
    granularity,
    windowAvgPaceSeconds,
    bestRun,
    totalRunCount,
  };
}
