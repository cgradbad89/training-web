import { describe, it, expect } from "vitest";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  buildDailyLoadMap,
  buildLoadEwmaSeries,
} from "@/utils/trainingLoadSeries";

/**
 * Regression guard for the personal-insights CTL/ATL compute cleanup.
 *
 * The `trainingLoadData` useMemo now filters the workouts handed to
 * buildDailyLoadMap to `startDate >= seedStart` (the same boundary the EWMA
 * walk starts from) instead of passing the full array. This test proves that
 * filter is OUTPUT-NEUTRAL: the CTL/ATL/TSB series is byte-identical whether we
 * bucket the full history or only the seedable window — because
 * buildLoadEwmaSeries never reads days before seedStart anyway.
 */

/** Minimal HealthWorkout fixture — only the fields resolveDisplayLoad /
 *  buildDailyLoadMap actually read. Cast through unknown to keep it terse. */
function wk(
  id: string,
  startDate: Date,
  trainingLoadV2: number,
  isRunLike: boolean
): HealthWorkout {
  return {
    workoutId: id,
    startDate,
    durationSeconds: 3600,
    avgHeartRate: 150,
    activityType: isRunLike ? "running" : "traditionalStrengthTraining",
    isRunLike,
    trainingLoadV2,
  } as unknown as HealthWorkout;
}

/** Local-midnight of `d`, mirroring startOfLocalDay in the page/series code. */
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Reproduces the page's seedStart derivation: later of (earliest workout day)
 *  or (SEED_DAYS-1 before today). */
function deriveSeedStart(
  workouts: HealthWorkout[],
  today: Date,
  seedDays: number
): Date {
  const earliest = workouts.reduce(
    (min, w) => Math.min(min, w.startDate.getTime()),
    Infinity
  );
  const seedFromHistory = isFinite(earliest) ? new Date(earliest) : null;
  const seedFromWindow = new Date(today);
  seedFromWindow.setDate(today.getDate() - (seedDays - 1));
  return seedFromHistory && seedFromHistory > seedFromWindow
    ? startOfLocalDay(seedFromHistory)
    : seedFromWindow;
}

describe("trainingLoadData seedStart bounding is output-neutral", () => {
  const SEED_DAYS = 180;
  // Fixed anchor so the test is deterministic (no reliance on wall clock).
  const today = new Date(2026, 6, 11); // 2026-07-11, local midnight

  // Workouts spanning >200 days, including several OLDER than the 180-day
  // seedStart boundary (which the EWMA walk must ignore).
  const workouts: HealthWorkout[] = [];
  for (let daysAgo = 320; daysAgo >= 0; daysAgo -= 4) {
    const d = new Date(today);
    d.setDate(today.getDate() - daysAgo);
    const isRun = daysAgo % 8 === 0;
    workouts.push(wk(`w-${daysAgo}`, d, 40 + (daysAgo % 100), isRun));
  }

  const seedStart = deriveSeedStart(workouts, today, SEED_DAYS);

  it("has fixtures on both sides of the seedStart boundary", () => {
    const older = workouts.filter((w) => w.startDate < seedStart);
    const seedable = workouts.filter((w) => w.startDate >= seedStart);
    expect(older.length).toBeGreaterThan(0); // proves the filter drops entries
    expect(seedable.length).toBeGreaterThan(0);
  });

  it("produces an identical CTL/ATL/TSB series with vs without the pre-seedStart workouts", () => {
    // OLD behavior: bucket the full array.
    const fullMap = buildDailyLoadMap(workouts);
    const fullSeries = buildLoadEwmaSeries(fullMap, seedStart, today);

    // NEW behavior: bucket only workouts the walk will read.
    const seedable = workouts.filter((w) => w.startDate >= seedStart);
    const boundMap = buildDailyLoadMap(seedable);
    const boundSeries = buildLoadEwmaSeries(boundMap, seedStart, today);

    // Same length and byte-identical per-day CTL/ATL/TSB/load.
    expect(boundSeries.length).toBe(fullSeries.length);
    expect(boundSeries).toEqual(fullSeries);

    // And the latest converged values match exactly (the numbers the cards show).
    const lastFull = fullSeries[fullSeries.length - 1];
    const lastBound = boundSeries[boundSeries.length - 1];
    expect(lastBound.ctl).toBe(lastFull.ctl);
    expect(lastBound.atl).toBe(lastFull.atl);
    expect(lastBound.tsb).toBe(lastFull.tsb);
  });
});
