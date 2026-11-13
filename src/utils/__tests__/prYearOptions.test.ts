import { describe, it, expect } from "vitest";
import { buildPrYearOptions, buildPersonalRecordsByYear } from "@/utils/personalRecords";
import { isStatsYearCurrent, AGGREGATED_STATS_VERSION, buildAggregatedStats, buildFastestMileFromBestEfforts } from "@/utils/aggregatedStats";
import type { HealthWorkout } from "@/types/healthWorkout";

function run(id: string, start: Date, miles = 4, secs = 2400, extra: Partial<HealthWorkout> = {}): HealthWorkout {
  return {
    workoutId: id, name: "Run", displayType: "Run", activityType: "HKWorkoutActivityTypeRunning",
    startDate: start, endDate: new Date(start.getTime() + secs * 1000), durationSeconds: secs,
    distanceMiles: miles, isRunLike: true, sourceName: "Watch", calories: 400, ...extra,
  } as unknown as HealthWorkout;
}

describe("buildPrYearOptions", () => {
  it("on 2027-01-01 with only 2025/2026 runs → [2027 (0), 2026, 2025]", () => {
    const runs = [
      run("a", new Date(2025, 5, 1)),
      run("b", new Date(2026, 0, 10)),
      run("c", new Date(2026, 11, 31, 20)),
    ];
    expect(buildPrYearOptions(runs, 2027)).toEqual([
      { year: 2027, runCount: 0 },
      { year: 2026, runCount: 2 },
      { year: 2025, runCount: 1 },
    ]);
  });
  it("counts the current year's runs and does not duplicate it", () => {
    const runs = [run("a", new Date(2027, 0, 1, 8)), run("b", new Date(2026, 3, 1))];
    expect(buildPrYearOptions(runs, 2027)).toEqual([
      { year: 2027, runCount: 1 },
      { year: 2026, runCount: 1 },
    ]);
  });
  it("lists only the current year when there are no runs at all", () => {
    expect(buildPrYearOptions([], 2027)).toEqual([{ year: 2027, runCount: 0 }]);
  });
  it("ignores non-run workouts and skips gap years", () => {
    const strength = run("s", new Date(2024, 1, 1), 0, 1800, { isRunLike: false });
    const runs = [strength, run("a", new Date(2025, 1, 1))];
    expect(buildPrYearOptions(runs, 2027).map((o) => o.year)).toEqual([2027, 2025]);
  });
  it("buckets a Dec 31 evening run in 2026 using local time", () => {
    const options = buildPrYearOptions([run("a", new Date(2026, 11, 31, 23, 30))], 2027);
    expect(options.find((o) => o.year === 2026)?.runCount).toBe(1);
  });
});

describe("isStatsYearCurrent", () => {
  it("a doc with statsYear 2026 read in 2027 is stale", () => {
    expect(isStatsYearCurrent({ statsYear: 2026 }, 2027)).toBe(false);
  });
  it("matching year is current", () => {
    expect(isStatsYearCurrent({ statsYear: 2027 }, 2027)).toBe(true);
  });
  it("a legacy doc without statsYear is stale", () => {
    expect(isStatsYearCurrent({} as { statsYear: number }, 2027)).toBe(false);
  });
  it("null doc is not current", () => {
    expect(isStatsYearCurrent(null, 2027)).toBe(false);
  });
});

describe("buildAggregatedStats statsYear", () => {
  const fingerprint = {
    latestWorkoutId: "x", computationVersion: AGGREGATED_STATS_VERSION, maxHr: 175, restingHr: 65,
    activeRaceId: null, activeRaceDate: null, overridesRevision: "0:0", localCalendarDate: "2027-01-01", localCalendarYear: 2027,
  };
  const base = {
    mileSplitsByWorkoutId: {}, healthMetrics: [], maxHr: 175, restingHr: 65, races: [],
    freshnessFingerprint: fingerprint, vo2FreshnessKey: { latestVo2SampleDate: null },
  };
  it("stamps the local calendar year of `now` (Dec 31 evening is still 2026)", () => {
    const doc = buildAggregatedStats({ ...base, workouts: [run("a", new Date(2026, 11, 31, 20))], now: new Date(2026, 11, 31, 23, 30) });
    expect(doc.statsYear).toBe(2026);
  });
  it("stamps 2027 after local midnight, including the empty-workouts early return", () => {
    const now = new Date(2027, 0, 1, 0, 30);
    expect(buildAggregatedStats({ ...base, workouts: [run("a", new Date(2026, 11, 30))], now }).statsYear).toBe(2027);
    expect(buildAggregatedStats({ ...base, workouts: [], now }).statsYear).toBe(2027);
  });
  it("bumps the computation version to 5", () => {
    expect(AGGREGATED_STATS_VERSION).toBe(5);
  });
});

describe("selecting a past year computes that year's PRs from live runs", () => {
  it("2026 PRs in 2027 come from 2026 runs only, and 2027 is empty", () => {
    const runs = [
      run("a", new Date(2026, 5, 1), 4, 2400, { bestEfforts: { "1mi": 420 } } as Partial<HealthWorkout>),
      run("b", new Date(2026, 11, 31, 20), 4, 2000, { bestEfforts: { "1mi": 400 } } as Partial<HealthWorkout>),
      run("c", new Date(2027, 0, 2, 9), 3, 1500, { bestEfforts: { "1mi": 480 } } as Partial<HealthWorkout>),
    ];
    const prs2026 = buildPersonalRecordsByYear(runs, 2026);
    const best = prs2026.prs.find((p) => p && p.miles === 4);
    expect(best?.pace).toBe(500); // 2000s / 4mi — the Dec 31 run
    expect(prs2026.prs.every((p) => p === null || p.date.getFullYear() === 2026)).toBe(true);
    expect(buildFastestMileFromBestEfforts(runs, 2026)?.seconds).toBe(400);
    expect(buildFastestMileFromBestEfforts(runs, 2027)?.seconds).toBe(480);
    expect(buildPersonalRecordsByYear(runs.slice(0, 2), 2027).prs.every((p) => p === null)).toBe(true);
  });
});
