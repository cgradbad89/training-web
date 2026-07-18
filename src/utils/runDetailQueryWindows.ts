/**
 * Query-window math for the Run Detail page's narrowed Firestore reads.
 *
 * Pure, timezone-safe date arithmetic (no Firestore, no React). Extracted so
 * each window's ANCHOR (today vs. the viewed run's date) and SIZE are unit-
 * testable independently of the query plumbing — getting an anchor backwards
 * silently reintroduces the old-run bugs these windows exist to fix.
 */

import { BEST_EFFORT_RECENCY_DAYS } from "@/utils/bestEffortExtraction";
import { CTL_IMPACT_SEED_DAYS } from "@/utils/runImpact";

/** ±days the plan-title matcher needs around the viewed run to catch its entry
 *  (the matcher's own gate is ±1 day; ±2 gives a safe margin). */
export const PLAN_TITLE_WINDOW_DAYS = 2;

function shiftDays(from: Date, days: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Start of the Race-Prediction-Impact recency window: `now − 56d`. Anchored to
 * TODAY (matches BEST_EFFORT_RECENCY_DAYS, the window the impact model already
 * caps itself to — a run older than this contributes nothing to the projection).
 */
export function recentImpactWindowStart(now: Date): Date {
  return shiftDays(now, -BEST_EFFORT_RECENCY_DAYS);
}

/**
 * Start of the CTL live-fallback seed window: `now − 179d` (a 180-day inclusive
 * span). Anchored to TODAY. Used ONLY when the cached aggregatedStats series is
 * stale/absent, so the live computeCtlImpact keeps its full 42-day-EWMA seed
 * (feeding it the 56-day impact list instead would starve the EWMA).
 */
export function ctlSeedWindowStart(now: Date): Date {
  return shiftDays(now, -(CTL_IMPACT_SEED_DAYS - 1));
}

/**
 * Plan-title match window: `[runDate − 2d, runDate + 2d]`. Anchored to the
 * VIEWED RUN's date, NOT today — this is what fixes plan-title labels for runs
 * outside the account's most recent 500 workouts (the old query dropped them by
 * date). `end` is in the future for a run viewed today, which is harmless.
 */
export function planTitleWindow(runDate: Date): { start: Date; end: Date } {
  return {
    start: shiftDays(runDate, -PLAN_TITLE_WINDOW_DAYS),
    end: shiftDays(runDate, PLAN_TITLE_WINDOW_DAYS),
  };
}
