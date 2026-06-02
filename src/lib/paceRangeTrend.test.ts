import { describe, it, expect } from "vitest";
import {
  computePaceRangeTrend,
  granularityForWindow,
  windowStartDate,
  type PaceRangeRun,
} from "./paceRangeTrend";

// Fixed "now" for deterministic windowing — June 1, 2026 (local).
const NOW = new Date(2026, 5, 1);

function run(
  year: number,
  monthIndex: number,
  day: number,
  distanceMiles: number,
  durationSeconds: number
): PaceRangeRun {
  return { distanceMiles, durationSeconds, date: new Date(year, monthIndex, day) };
}

describe("granularityForWindow", () => {
  it("buckets 1m/2m/3m by week", () => {
    expect(granularityForWindow("1m")).toBe("week");
    expect(granularityForWindow("2m")).toBe("week");
    expect(granularityForWindow("3m")).toBe("week");
  });

  it("buckets 6m/12m/ytd by month", () => {
    expect(granularityForWindow("6m")).toBe("month");
    expect(granularityForWindow("12m")).toBe("month");
    expect(granularityForWindow("ytd")).toBe("month");
  });
});

describe("windowStartDate", () => {
  it("ytd returns Jan 1 of now's year", () => {
    const start = windowStartDate("ytd", NOW);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(0);
    expect(start.getDate()).toBe(1);
  });

  it("Nm returns now minus N calendar months", () => {
    const threeMonths = windowStartDate("3m", NOW);
    expect(threeMonths.getFullYear()).toBe(2026);
    expect(threeMonths.getMonth()).toBe(2); // March

    const twelveMonths = windowStartDate("12m", NOW);
    expect(twelveMonths.getFullYear()).toBe(2025);
    expect(twelveMonths.getMonth()).toBe(5); // June (prior year)
  });
});

describe("computePaceRangeTrend", () => {
  it("happy path: runs across several weeks in range produce sorted points", () => {
    // Three runs ~2 weeks apart, all 4 mi, all within [1,10] and the 3m window.
    const runs = [
      run(2026, 4, 4, 4, 1600), // May 4 — 400 s/mi
      run(2026, 3, 20, 4, 1800), // Apr 20 — 450 s/mi
      run(2026, 3, 6, 4, 2000), // Apr 6 — 500 s/mi
    ];
    const res = computePaceRangeTrend(runs, 1, 10, "3m", NOW);
    expect(res.granularity).toBe("week");
    expect(res.points).toHaveLength(3);
    expect(res.totalRunCount).toBe(3);
    // Sorted ascending by periodStart.
    const times = res.points.map((p) => p.periodStart.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("includes runs exactly at minMiles and maxMiles (inclusive bounds)", () => {
    const runs = [
      run(2026, 4, 10, 3, 1500), // exactly minMiles
      run(2026, 4, 11, 5, 2500), // exactly maxMiles
    ];
    const res = computePaceRangeTrend(runs, 3, 5, "3m", NOW);
    expect(res.totalRunCount).toBe(2);
  });

  it("excludes runs just outside the range", () => {
    const runs = [
      run(2026, 4, 10, 2.5, 1250), // below min
      run(2026, 4, 11, 5.5, 2750), // above max
    ];
    const res = computePaceRangeTrend(runs, 3, 5, "3m", NOW);
    expect(res.totalRunCount).toBe(0);
    expect(res.points).toHaveLength(0);
  });

  it("per-period average is distance-weighted, not the mean of per-run paces", () => {
    // Same day -> same bucket. A: 2mi/1000s (500 s/mi). B: 6mi/1800s (300 s/mi).
    // Weighted = (1000+1800)/(2+6) = 350. Arithmetic mean of paces = 400.
    const runs = [
      run(2026, 4, 20, 2, 1000),
      run(2026, 4, 20, 6, 1800),
    ];
    const res = computePaceRangeTrend(runs, 1, 10, "3m", NOW);
    expect(res.points).toHaveLength(1);
    expect(res.points[0].avgPaceSeconds).toBe(350);
    expect(res.points[0].runCount).toBe(2);
    expect(res.windowAvgPaceSeconds).toBe(350);
  });

  it("bestRun is the fastest single qualifying run", () => {
    const runs = [
      run(2026, 4, 4, 4, 1600), // 400 s/mi
      run(2026, 4, 11, 5, 1500), // 300 s/mi  <- fastest
      run(2026, 4, 18, 3, 1500), // 500 s/mi
    ];
    const res = computePaceRangeTrend(runs, 1, 10, "3m", NOW);
    expect(res.bestRun).not.toBeNull();
    expect(res.bestRun?.paceSeconds).toBe(300);
    expect(res.bestRun?.distanceMiles).toBe(5);
  });

  it("YTD includes a run on Jan 1 and excludes Dec 31 of the prior year", () => {
    const runs = [
      run(2026, 0, 1, 4, 1600), // Jan 1, 2026 — included
      run(2025, 11, 31, 4, 1600), // Dec 31, 2025 — excluded
    ];
    const res = computePaceRangeTrend(runs, 1, 10, "ytd", NOW);
    expect(res.granularity).toBe("month");
    expect(res.totalRunCount).toBe(1);
    expect(res.points).toHaveLength(1);
    expect(res.points[0].label).toBe("Jan");
  });

  it("switches granularity: 3m -> week, 6m -> month", () => {
    const runs = [run(2026, 4, 4, 4, 1600)];
    expect(computePaceRangeTrend(runs, 1, 10, "3m", NOW).granularity).toBe(
      "week"
    );
    expect(computePaceRangeTrend(runs, 1, 10, "6m", NOW).granularity).toBe(
      "month"
    );
  });

  it("zero qualifying runs returns empty points with null aggregates", () => {
    const res = computePaceRangeTrend([], 3, 5, "3m", NOW);
    expect(res.points).toHaveLength(0);
    expect(res.windowAvgPaceSeconds).toBeNull();
    expect(res.bestRun).toBeNull();
    expect(res.totalRunCount).toBe(0);
  });

  it("rejects runs with pace below 180 or above 1200 sec/mi", () => {
    const runs = [
      run(2026, 4, 10, 5, 800), // 160 s/mi — too fast
      run(2026, 4, 11, 1, 1300), // 1300 s/mi — too slow
    ];
    const res = computePaceRangeTrend(runs, 0, 15, "3m", NOW);
    expect(res.totalRunCount).toBe(0);
    expect(res.points).toHaveLength(0);
    expect(res.windowAvgPaceSeconds).toBeNull();
    expect(res.bestRun).toBeNull();
  });

  it("ignores runs with non-positive distance", () => {
    const runs = [
      run(2026, 4, 10, 0, 1500), // distance 0 -> skipped
      run(2026, 4, 11, 4, 1600), // valid -> 400 s/mi
    ];
    const res = computePaceRangeTrend(runs, 0, 15, "3m", NOW);
    expect(res.totalRunCount).toBe(1);
    expect(res.bestRun?.paceSeconds).toBe(400);
  });

  it("excludes qualifying-distance runs that fall before the window start", () => {
    const runs = [
      run(2026, 4, 20, 4, 1600), // within 3m window
      run(2026, 0, 15, 4, 1600), // Jan 15 — before March 1 (3m) start
    ];
    const res = computePaceRangeTrend(runs, 1, 10, "3m", NOW);
    expect(res.totalRunCount).toBe(1);
  });
});
