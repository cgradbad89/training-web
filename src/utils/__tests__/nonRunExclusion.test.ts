import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HealthWorkout } from "@/types/healthWorkout";
import {
  AGGREGATED_STATS_VERSION,
  buildAggregatedStats,
  computeFreshnessFingerprint,
  computeVo2FreshnessKey,
} from "@/utils/aggregatedStats";
import { buildPersonalRecordsByYear } from "@/utils/personalRecords";
import { buildPaceTrendsByDistanceBucket } from "@/utils/paceTrends";
import { computeGoalProgress } from "@/utils/goalProgress";
import { selectRuns } from "@/utils/runSelection";
import { type RunningGoal } from "@/types/goal";

const NOW = new Date(2026, 10, 12, 12, 0, 0);

function workout(
  workoutId: string,
  start: Date,
  miles: number,
  seconds: number,
  overrides: Partial<HealthWorkout> = {}
): HealthWorkout {
  return {
    workoutId,
    name: "Run",
    activityType: "running",
    displayType: "Run",
    startDate: start,
    endDate: new Date(start.getTime() + seconds * 1000),
    syncedAt: start,
    durationSeconds: seconds,
    distanceMiles: miles,
    distanceMeters: miles * 1609.344,
    sourceName: "Apple Watch",
    isRunLike: true,
    hasRoute: false,
    avgHeartRate: 150,
    trainingLoadV2: 50,
    trainingLoadMethod: "avg-hr-fallback",
    trainingLoadBasisComplete: true,
    ...overrides,
  } as unknown as HealthWorkout;
}

// ── Real runs (recent, so the 56-day race-prediction window sees them) ───────
const realRuns: HealthWorkout[] = [
  workout("run5", new Date(2026, 10, 5, 7), 5.0, 47 * 60),
  workout("runA", new Date(2026, 10, 1, 7), 3.0, 30 * 60),
  workout("runB", new Date(2026, 10, 3, 7), 4.0, 40 * 60),
  workout("runC", new Date(2026, 10, 8, 7), 6.0, 60 * 60),
  workout("runD", new Date(2026, 10, 10, 7), 8.0, 84 * 60),
  workout("runE", new Date(2026, 9, 25, 7), 3.5, 35 * 60),
  workout("marRun", new Date(2026, 2, 26, 18), 1.76, Math.round(1.76 * 584)),
  workout("run2025", new Date(2025, 5, 1, 7), 12.0, 12 * 520),
];

// ── Non-runs that carry distance ─────────────────────────────────────────────
const hiitMar = workout("manual_hiit", new Date(2026, 2, 26, 6), 9.99, 3600, {
  entrySource: "manual",
  sourceName: "Manual Entry",
  activityType: "high_intensity_interval_training",
  displayType: "HIIT",
  isRunLike: false,
});
const rideJun2025 = workout("ride2025", new Date(2025, 5, 19, 7), 30.8, 10943, {
  activityType: "cycling",
  displayType: "Cycling",
  isRunLike: false,
});
// Recent non-runs: inside the 56-day / 8-week windows so prediction and pace
// trends would move if they leaked in.
const hiitRecent = workout("hiit_recent", new Date(2026, 10, 9, 6), 9.99, 3600, {
  activityType: "high_intensity_interval_training",
  displayType: "HIIT",
  isRunLike: false,
});
const rideRecent = workout("ride_recent", new Date(2026, 10, 7, 7), 30.8, 10943, {
  activityType: "cycling",
  displayType: "Cycling",
  isRunLike: false,
});
const nonRuns = [hiitMar, rideJun2025, hiitRecent, rideRecent];
const withNonRuns = [...realRuns, ...nonRuns];

function aggregate(workouts: HealthWorkout[]) {
  return buildAggregatedStats({
    workouts,
    mileSplitsByWorkoutId: {},
    healthMetrics: [],
    maxHr: 185,
    restingHr: 50,
    now: NOW,
    races: [],
    freshnessFingerprint: computeFreshnessFingerprint({
      latestWorkoutId: "x",
      computationVersion: AGGREGATED_STATS_VERSION,
      maxHr: 185,
      restingHr: 50,
      activeRaceId: null,
      activeRaceDate: null,
      overrides: {},
    }),
    vo2FreshnessKey: computeVo2FreshnessKey(null),
  });
}

describe("non-run workouts never reach run-only metrics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("is on aggregate version 5", () => {
    expect(AGGREGATED_STATS_VERSION).toBe(5);
  });

  describe("personal records", () => {
    it("2026 PR rows equal the runs-only result with a manual HIIT present", () => {
      const clean = buildPersonalRecordsByYear(realRuns, 2026);
      const dirty = buildPersonalRecordsByYear(withNonRuns, 2026);
      expect(dirty).toEqual(clean);
    });

    it("7–10 mi, 15K and 10 Miles (2026) are never the manual HIIT", () => {
      const { prs, specificPrs } = buildPersonalRecordsByYear(withNonRuns, 2026);
      const sevenToTen = prs[3];
      const fifteenK = specificPrs[3];
      const tenMiles = specificPrs[4];
      for (const row of [sevenToTen, fifteenK, tenMiles]) {
        expect(row?.pace).not.toBe(3600 / 9.99);
        expect(row?.miles).not.toBe(9.99);
      }
      expect(sevenToTen?.miles).toBe(8);
    });

    it("10+ mi (2025) comes from the real run, not the 30.8 mi non-run", () => {
      const { prs } = buildPersonalRecordsByYear(withNonRuns, 2025);
      expect(prs[4]?.miles).toBe(12);
      expect(prs[4]).toEqual(buildPersonalRecordsByYear(realRuns, 2025).prs[4]);
    });

    it("counts a manual run entry toward PRs", () => {
      const manualRun = workout("manual_run", new Date(2026, 5, 1, 7), 11, 11 * 450, {
        entrySource: "manual",
        sourceName: "Manual Entry",
        activityType: "treadmill_running",
        displayType: "Treadmill Run",
        isRunLike: true,
      });
      const { prs } = buildPersonalRecordsByYear([...withNonRuns, manualRun], 2026);
      expect(prs[4]?.miles).toBe(11);
    });

    it("the persisted aggregate's PRs equal the runs-only aggregate", () => {
      expect(aggregate(withNonRuns).personalRecordsByYear).toEqual(
        aggregate(realRuns).personalRecordsByYear
      );
    });
  });

  describe("cached race prediction", () => {
    it("is identical with and without the non-runs (n, k, r², times)", () => {
      const clean = aggregate(realRuns).racePredictions;
      const dirty = aggregate(withNonRuns).racePredictions;
      expect(dirty.modelFit?.n).toBe(clean.modelFit?.n);
      expect(dirty.modelFit?.k).toBe(clean.modelFit?.k);
      expect(dirty.modelFit?.r2).toBe(clean.modelFit?.r2);
      expect(dirty.tHalf).toBe(clean.tHalf);
      expect(dirty).toEqual(clean);
    });

    it("has a real fit to compare (guards against a vacuous null === null)", () => {
      const clean = aggregate(realRuns).racePredictions;
      expect(clean.modelFit).not.toBeNull();
      expect(clean.tHalf).not.toBeNull();
    });
  });

  describe("pace trends", () => {
    it("are identical with and without the non-runs (aggregate)", () => {
      expect(aggregate(withNonRuns).paceTrends).toEqual(
        aggregate(realRuns).paceTrends
      );
    });

    it("are identical when the builder is called directly with all workouts", () => {
      expect(buildPaceTrendsByDistanceBucket(withNonRuns, 8, NOW)).toEqual(
        buildPaceTrendsByDistanceBucket(realRuns, 8, NOW)
      );
    });
  });

  describe("training load stays unfiltered", () => {
    it("changes when the HIIT is added", () => {
      const clean = aggregate(realRuns).trainingLoad.series;
      const dirty = aggregate([...realRuns, hiitRecent]).trainingLoad.series;
      expect(dirty.at(-1)?.ctl).not.toBe(clean.at(-1)?.ctl);
      expect(dirty.at(-1)?.atl).not.toBe(clean.at(-1)?.atl);
    });
  });

  describe("goal progress call-site contract", () => {
    const goal = {
      startDate: "2026-11-01",
      endDate: "2026-11-30",
      target: 100,
      metric: "distance",
    } as unknown as RunningGoal;

    it("run goals sum runs only when narrowed with selectRuns", () => {
      const today = new Date(2026, 10, 12);
      const gated = computeGoalProgress(goal, selectRuns(withNonRuns), today);
      const runsOnly = computeGoalProgress(goal, realRuns, today);
      expect(gated.actual).toBe(runsOnly.actual);
      const ungated = computeGoalProgress(goal, withNonRuns, today);
      expect(ungated.actual).toBeGreaterThan(gated.actual);
    });
  });
});
