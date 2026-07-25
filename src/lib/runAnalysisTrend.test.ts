import { describe, it, expect } from "vitest";
import {
  buildRunAnalysisTrend,
  type RunAnalysisWorkout,
} from "./runAnalysisTrend";
import { computePaceRangeTrend, type PaceRangeRun } from "./paceRangeTrend";
import { computeTrainingLoadV2 } from "@/utils/trainingLoad";
import { scoreWorkoutsEfficiency } from "@/utils/efficiencyScore";

// Fixed "now" for deterministic windowing — June 1, 2026 (local).
const NOW = new Date(2026, 5, 1);

const RESTING_HR = 50;
const MAX_HR = 190;

// Local-time ISO (no trailing Z) so getFullYear/getMonth/getDate for bucketing
// are timezone-stable at noon regardless of the test host's zone.
function iso(year: number, monthIndex: number, day: number): string {
  const m = String(monthIndex + 1).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}T12:00:00`;
}

function w(
  id: string,
  date: string,
  distanceMiles: number,
  durationSeconds: number,
  opts: {
    pace?: number | null;
    hr?: number | null;
    cadence?: number | null;
    activityType?: string;
  } = {}
): RunAnalysisWorkout {
  return {
    workoutId: id,
    date,
    distanceMiles,
    durationSeconds,
    avgPaceSecPerMile: opts.pace ?? null,
    avgHeartRate: opts.hr ?? null,
    cadenceSPM: opts.cadence ?? null,
    activityType: opts.activityType ?? "running",
  };
}

describe("buildRunAnalysisTrend — pace metric", () => {
  it("averages avgPaceSecPerMile (simple mean) of in-range runs per bucket", () => {
    // Two runs in the same Mon-Sun week (Mon May 4 2026): paces 400 & 500.
    const runs = [
      w("a", iso(2026, 4, 4), 4, 1600, { pace: 400 }),
      w("b", iso(2026, 4, 6), 4, 2200, { pace: 500 }),
    ];
    const pts = buildRunAnalysisTrend(runs, "pace", 1, 10, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBe(450);
    expect(pts[0].runCount).toBe(2);
  });

  it("excludes runs with null/invalid pace from the average", () => {
    const runs = [
      w("a", iso(2026, 4, 4), 4, 1600, { pace: 400 }),
      w("b", iso(2026, 4, 5), 4, 2000, { pace: null }),
      w("c", iso(2026, 4, 6), 4, 2200, { pace: 500 }),
    ];
    const pts = buildRunAnalysisTrend(runs, "pace", 1, 10, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    // Mean of 400 & 500 only; the null-pace run doesn't dilute it.
    expect(pts[0].value).toBe(450);
    // runCount still counts ALL distance-matched runs, incl. the null-pace one.
    expect(pts[0].runCount).toBe(3);
  });
});

describe("buildRunAnalysisTrend — cadence metric", () => {
  it("averages cadenceSPM, ignoring null cadence", () => {
    const runs = [
      w("a", iso(2026, 4, 4), 4, 1600, { cadence: 170 }),
      w("b", iso(2026, 4, 5), 4, 1600, { cadence: null }),
      w("c", iso(2026, 4, 6), 4, 1600, { cadence: 180 }),
    ];
    const pts = buildRunAnalysisTrend(runs, "cadence", 1, 10, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBe(175);
    expect(pts[0].runCount).toBe(3);
  });

  it("returns value null when every run in the bucket has null cadence", () => {
    const runs = [
      w("a", iso(2026, 4, 4), 4, 1600, { cadence: null }),
      w("b", iso(2026, 4, 6), 4, 1600, { cadence: null }),
    ];
    const pts = buildRunAnalysisTrend(runs, "cadence", 1, 10, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBeNull();
    expect(pts[0].runCount).toBe(2);
  });
});

describe("buildRunAnalysisTrend — heartRate metric", () => {
  it("averages avgHeartRate, ignoring null HR", () => {
    const runs = [
      w("a", iso(2026, 4, 4), 4, 1600, { hr: 140 }),
      w("b", iso(2026, 4, 5), 4, 1600, { hr: null }),
      w("c", iso(2026, 4, 6), 4, 1600, { hr: 160 }),
    ];
    const pts = buildRunAnalysisTrend(runs, "heartRate", 1, 10, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBe(150);
    expect(pts[0].runCount).toBe(3);
  });
});

describe("buildRunAnalysisTrend — load metric", () => {
  it("averages computeTrainingLoadV2 per run, excluding null-load runs", () => {
    const runs = [
      w("a", iso(2026, 4, 4), 4, 1800, { hr: 150 }),
      w("b", iso(2026, 4, 5), 4, 1800, { hr: null }), // no HR → load null
      w("c", iso(2026, 4, 6), 4, 1800, { hr: 160 }),
    ];
    const l1 = computeTrainingLoadV2(1800, 150, MAX_HR, RESTING_HR, "running")!;
    const l3 = computeTrainingLoadV2(1800, 160, MAX_HR, RESTING_HR, "running")!;
    const pts = buildRunAnalysisTrend(runs, "load", 1, 10, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBeCloseTo((l1 + l3) / 2, 10);
    // The null-load run is still counted in runCount.
    expect(pts[0].runCount).toBe(3);
  });

  it("returns value null when every run's load is un-computable", () => {
    const runs = [
      w("a", iso(2026, 4, 4), 4, 1800, { hr: null }),
      w("b", iso(2026, 4, 6), 4, 1800, { hr: null }),
    ];
    const pts = buildRunAnalysisTrend(runs, "load", 1, 10, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBeNull();
    expect(pts[0].runCount).toBe(2);
  });
});

describe("buildRunAnalysisTrend — efficiencyScore metric", () => {
  // 6 EF-backed runs on consecutive days in one Mon-Sun week (Mon May 4 2026).
  // Only the 6th run has ≥5 preceding EF-backed runs → 'scored'; the first five
  // are 'building_baseline'.
  function sixRuns(): RunAnalysisWorkout[] {
    return [
      w("r1", iso(2026, 4, 4), 4, 2000, { pace: 500, hr: 140, cadence: 170 }),
      w("r2", iso(2026, 4, 5), 5, 2400, { pace: 480, hr: 150, cadence: 172 }),
      w("r3", iso(2026, 4, 6), 4, 2100, { pace: 525, hr: 145, cadence: 168 }),
      w("r4", iso(2026, 4, 7), 6, 3000, { pace: 500, hr: 160, cadence: 174 }),
      w("r5", iso(2026, 4, 8), 4, 1950, { pace: 488, hr: 138, cadence: 176 }),
      w("r6", iso(2026, 4, 9), 5, 2500, { pace: 500, hr: 152, cadence: 170 }),
    ];
  }

  it("averages only 'scored' runs; 'building_baseline' runs are excluded (not 0)", () => {
    const runs = sixRuns();
    // Independently compute what the single scored run (r6) should score.
    const scores = scoreWorkoutsEfficiency(
      runs.map((r) => ({
        workoutId: r.workoutId,
        startDate: r.date,
        distanceMiles: r.distanceMiles,
        durationSeconds: r.durationSeconds,
        avgPaceSecPerMile: r.avgPaceSecPerMile,
        avgHeartRate: r.avgHeartRate,
        cadenceSPM: r.cadenceSPM,
      })),
      RESTING_HR,
      MAX_HR
    );
    const r6 = scores.get("r6")!;
    expect(r6.status).toBe("scored");
    expect(r6.score).not.toBeNull();

    const pts = buildRunAnalysisTrend(
      runs,
      "efficiencyScore",
      1,
      10,
      "3m",
      RESTING_HR,
      MAX_HR,
      NOW
    );
    expect(pts).toHaveLength(1);
    // Bucket value equals r6's score EXACTLY — the five building runs contribute
    // nothing (had they been treated as 0 the mean would be r6.score / 6).
    expect(pts[0].value).toBeCloseTo(r6.score as number, 10);
    expect(pts[0].runCount).toBe(6);
  });

  it("returns value null for a bucket whose runs are all still building_baseline", () => {
    // Only three EF-backed runs — none has ≥5 predecessors, so all are building.
    const runs = [
      w("r1", iso(2026, 4, 4), 4, 2000, { pace: 500, hr: 140 }),
      w("r2", iso(2026, 4, 5), 4, 2000, { pace: 490, hr: 150 }),
      w("r3", iso(2026, 4, 6), 4, 2000, { pace: 510, hr: 145 }),
    ];
    const pts = buildRunAnalysisTrend(
      runs,
      "efficiencyScore",
      1,
      10,
      "3m",
      RESTING_HR,
      MAX_HR,
      NOW
    );
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBeNull(); // null gap, NOT 0
    expect(pts[0].runCount).toBe(3);
  });
});

describe("buildRunAnalysisTrend — distance-range filtering", () => {
  it("includes runs at the exact min and max boundaries (inclusive)", () => {
    const runs = [
      w("min", iso(2026, 4, 4), 3, 1500, { pace: 500 }), // exactly minMiles
      w("mid", iso(2026, 4, 5), 4, 1600, { pace: 400 }),
      w("max", iso(2026, 4, 6), 5, 2500, { pace: 500 }), // exactly maxMiles
    ];
    const pts = buildRunAnalysisTrend(runs, "pace", 3, 5, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0].runCount).toBe(3);
    expect(pts[0].value).toBeCloseTo((500 + 400 + 500) / 3, 10);
  });

  it("excludes runs just below min and just above max", () => {
    const runs = [
      w("below", iso(2026, 4, 4), 2.99, 1500, { pace: 500 }),
      w("in", iso(2026, 4, 5), 4, 1600, { pace: 400 }),
      w("above", iso(2026, 4, 6), 5.01, 2500, { pace: 500 }),
    ];
    const pts = buildRunAnalysisTrend(runs, "pace", 3, 5, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0].runCount).toBe(1);
    expect(pts[0].value).toBe(400);
  });
});

describe("buildRunAnalysisTrend — window + granularity parity with paceRangeTrend", () => {
  it("uses weekly buckets for 3m with labels matching computePaceRangeTrend", () => {
    const dates: [number, number, number][] = [
      [2026, 4, 4], // May 4
      [2026, 3, 20], // Apr 20
      [2026, 3, 6], // Apr 6
    ];
    const runs = dates.map(([y, m, d], i) =>
      w(`r${i}`, iso(y, m, d), 4, 1600, { pace: 400 + i })
    );
    const paceRuns: PaceRangeRun[] = dates.map(([y, m, d]) => ({
      distanceMiles: 4,
      durationSeconds: 1600,
      date: new Date(y, m, d, 12),
    }));

    const pts = buildRunAnalysisTrend(runs, "pace", 1, 10, "3m", RESTING_HR, MAX_HR, NOW);
    const ref = computePaceRangeTrend(paceRuns, 1, 10, "3m", NOW);

    expect(ref.granularity).toBe("week");
    expect(pts.map((p) => p.bucketLabel)).toEqual(ref.points.map((p) => p.label));
    expect(pts).toHaveLength(3);
  });

  it("uses monthly buckets for 6m with labels matching computePaceRangeTrend", () => {
    const dates: [number, number, number][] = [
      [2026, 4, 15], // May
      [2026, 3, 10], // Apr
      [2026, 2, 5], // Mar
    ];
    const runs = dates.map(([y, m, d], i) =>
      w(`r${i}`, iso(y, m, d), 4, 1600, { pace: 400 + i })
    );
    const paceRuns: PaceRangeRun[] = dates.map(([y, m, d]) => ({
      distanceMiles: 4,
      durationSeconds: 1600,
      date: new Date(y, m, d, 12),
    }));

    const pts = buildRunAnalysisTrend(runs, "pace", 1, 10, "6m", RESTING_HR, MAX_HR, NOW);
    const ref = computePaceRangeTrend(paceRuns, 1, 10, "6m", NOW);

    expect(ref.granularity).toBe("month");
    expect(pts.map((p) => p.bucketLabel)).toEqual(ref.points.map((p) => p.label));
    expect(pts.map((p) => p.bucketLabel)).toEqual(["Mar", "Apr", "May"]);
  });

  it("excludes runs before the trailing-window start", () => {
    const runs = [
      w("old", iso(2026, 1, 1), 4, 1600, { pace: 400 }), // Feb 1 — outside 3m
      w("recent", iso(2026, 4, 4), 4, 1600, { pace: 500 }), // May 4 — inside
    ];
    // 3m window from NOW (Jun 1) starts Mar 1, so the Feb 1 run is excluded.
    const pts = buildRunAnalysisTrend(runs, "pace", 1, 10, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0].runCount).toBe(1);
    expect(pts[0].value).toBe(500);
  });
});

describe("buildRunAnalysisTrend — misc", () => {
  it("returns an empty array for no workouts", () => {
    expect(
      buildRunAnalysisTrend([], "pace", 1, 10, "3m", RESTING_HR, MAX_HR, NOW)
    ).toEqual([]);
  });

  it("returns buckets in chronological order", () => {
    // Three runs in three distinct months, provided out of order.
    const runs = [
      w("may", iso(2026, 4, 15), 4, 1600, { pace: 400 }),
      w("mar", iso(2026, 2, 15), 4, 1600, { pace: 400 }),
      w("apr", iso(2026, 3, 15), 4, 1600, { pace: 400 }),
    ];
    const pts = buildRunAnalysisTrend(runs, "pace", 1, 10, "6m", RESTING_HR, MAX_HR, NOW);
    const starts = pts.map((p) => p.bucketStartDate);
    expect(starts).toEqual([...starts].sort());
    expect(pts.map((p) => p.bucketLabel)).toEqual(["Mar", "Apr", "May"]);
  });
});
