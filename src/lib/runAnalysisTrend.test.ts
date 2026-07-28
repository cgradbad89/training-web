import { describe, it, expect } from "vitest";
import {
  buildRunAnalysisTrend,
  runsInBucket,
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

describe("buildRunAnalysisTrend — pace metric (distance-weighted)", () => {
  it("matches computePaceRangeTrend's per-bucket value exactly (parity)", () => {
    // One long run and one short run at different paces, same week bucket
    // (Mon May 4 2026). Both derived paces (dur/miles) sit within
    // computePaceRangeTrend's [180,1200] sanity bounds so the two are comparable.
    const specs = [
      { id: "long", y: 2026, m: 4, d: 4, miles: 10, dur: 5000 }, // 500 s/mi
      { id: "short", y: 2026, m: 4, d: 6, miles: 2, dur: 800 }, //  400 s/mi
    ];
    const runs = specs.map((s) =>
      w(s.id, iso(s.y, s.m, s.d), s.miles, s.dur, { pace: s.dur / s.miles })
    );
    const paceRuns: PaceRangeRun[] = specs.map((s) => ({
      distanceMiles: s.miles,
      durationSeconds: s.dur,
      date: new Date(s.y, s.m, s.d, 12),
    }));

    const pts = buildRunAnalysisTrend(runs, "pace", 1, 15, "3m", RESTING_HR, MAX_HR, NOW);
    const ref = computePaceRangeTrend(paceRuns, 1, 15, "3m", NOW);

    expect(pts).toHaveLength(1);
    expect(ref.points).toHaveLength(1);
    // Identical per-bucket value against REAL computePaceRangeTrend output.
    expect(pts[0].value as number).toBeCloseTo(ref.points[0].avgPaceSeconds, 10);
    expect(pts[0].runCount).toBe(2);
  });

  it("weights by distance so a long+short mix differs from a naive simple mean", () => {
    // long: 10 mi @ 500 s/mi, short: 2 mi @ 400 s/mi in one bucket.
    const runs = [
      w("long", iso(2026, 4, 4), 10, 5000, { pace: 500 }),
      w("short", iso(2026, 4, 6), 2, 800, { pace: 400 }),
    ];
    const pts = buildRunAnalysisTrend(runs, "pace", 1, 15, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    // Distance-weighted = Σdur/Σmiles = (5000+800)/(10+2) = 5800/12 ≈ 483.33 s/mi.
    expect(pts[0].value as number).toBeCloseTo(5800 / 12, 10);
    // NOT the naive simple mean of (500+400)/2 = 450 — regression guard.
    const simpleMean = (500 + 400) / 2;
    expect(Math.abs((pts[0].value as number) - simpleMean)).toBeGreaterThan(10);
    expect(pts[0].runCount).toBe(2);
  });

  it("returns value null when no run has a computable pace (zero duration)", () => {
    const runs = [
      w("a", iso(2026, 4, 4), 4, 0, { pace: null }),
      w("b", iso(2026, 4, 6), 4, 0, { pace: null }),
    ];
    const pts = buildRunAnalysisTrend(runs, "pace", 1, 10, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBeNull(); // null gap, NOT 0
    // runCount still counts ALL distance-matched runs.
    expect(pts[0].runCount).toBe(2);
  });
});

describe("buildRunAnalysisTrend — pace outlier guard ([180,1200] sec/mi)", () => {
  it("excludes a run whose derived pace is below 180 sec/mi (GPS glitch)", () => {
    const runs = [
      w("glitch", iso(2026, 4, 4), 3, 300, { pace: 100 }), // 300/3 = 100 s/mi (<180)
      w("valid", iso(2026, 4, 6), 4, 1600, { pace: 400 }), // 1600/4 = 400 s/mi
    ];
    const pts = buildRunAnalysisTrend(runs, "pace", 1, 10, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    // The sub-3:00/mi glitch is dropped; value = the valid run's pace only.
    expect(pts[0].value).toBe(400);
    // runCount is metric-agnostic (raw distance-filtered set) — unchanged here.
    expect(pts[0].runCount).toBe(2);
  });

  it("excludes a run whose derived pace is above 1200 sec/mi (stopped-clock crawl)", () => {
    const runs = [
      w("crawl", iso(2026, 4, 4), 1, 1500, { pace: 1500 }), // 1500/1 = 1500 s/mi (>1200)
      w("valid", iso(2026, 4, 6), 4, 1600, { pace: 400 }),
    ];
    const pts = buildRunAnalysisTrend(runs, "pace", 1, 10, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBe(400);
    expect(pts[0].runCount).toBe(2);
  });

  it("does NOT apply the pace guard to another metric (heartRate)", () => {
    // Same two outlier-PACE runs, but both carry a valid avgHeartRate. The pace
    // bound is pace-only, so both contribute to the heartRate average.
    const runs = [
      w("glitch", iso(2026, 4, 4), 3, 300, { pace: 100, hr: 190 }),
      w("crawl", iso(2026, 4, 6), 1, 1500, { pace: 1500, hr: 130 }),
    ];
    const pts = buildRunAnalysisTrend(
      runs,
      "heartRate",
      1,
      10,
      "3m",
      RESTING_HR,
      MAX_HR,
      NOW
    );
    expect(pts).toHaveLength(1);
    // Mean of 190 & 130 — neither run is dropped by the pace guard.
    expect(pts[0].value).toBe(160);
    expect(pts[0].runCount).toBe(2);
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
    // Distance-weighted Σdur/Σmiles = (1500+1600+2500)/(3+4+5) = 5600/12.
    expect(pts[0].value as number).toBeCloseTo(5600 / 12, 10);
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
      w("recent", iso(2026, 4, 4), 4, 2000, { pace: 500 }), // May 4 — inside (2000/4=500)
    ];
    // 3m window from NOW (Jun 1) starts Mar 1, so the Feb 1 run is excluded.
    const pts = buildRunAnalysisTrend(runs, "pace", 1, 10, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0].runCount).toBe(1);
    // Single in-window run: distance-weighted pace = 2000/4 = 500 s/mi.
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

// ─── runsInBucket — the drill-down behind a clicked chart point ───────────────
//
// May 11 2026 is a MONDAY (Jan 1 2026 = Thursday; May 11 is day-of-year 131,
// (131-1) mod 7 = 4, Thu+4 = Mon), so May 11/13/16 share the week bucket
// starting 2026-05-11 and May 18 opens the next one.

describe("runsInBucket", () => {
  it("includes runs at BOTH exact distance boundaries and excludes just outside", () => {
    const runs = [
      w("min", iso(2026, 4, 11), 3, 1620, { pace: 540 }), // exactly minMiles
      w("mid", iso(2026, 4, 13), 4, 2160, { pace: 540 }),
      w("max", iso(2026, 4, 16), 5, 2700, { pace: 540 }), // exactly maxMiles
      w("under", iso(2026, 4, 13), 2.99, 1614, { pace: 540 }),
      w("over", iso(2026, 4, 13), 5.01, 2705, { pace: 540 }),
    ];
    const got = runsInBucket(runs, "2026-05-11", "3m", 3, 5, NOW);
    expect(got.map((r) => r.workoutId)).toEqual(["min", "mid", "max"]);
  });

  it("matches a WEEKLY bucket, excluding runs from the adjacent week", () => {
    const runs = [
      w("a", iso(2026, 4, 11), 4, 2160, { pace: 540 }), // Mon — in bucket
      w("b", iso(2026, 4, 16), 4, 2160, { pace: 540 }), // Sat — in bucket
      w("c", iso(2026, 4, 18), 4, 2160, { pace: 540 }), // next Mon — out
    ];
    const got = runsInBucket(runs, "2026-05-11", "3m", 3, 5, NOW);
    expect(got.map((r) => r.workoutId)).toEqual(["a", "b"]);
  });

  it("matches a MONTHLY bucket on a month-granularity window", () => {
    const runs = [
      w("apr1", iso(2026, 3, 2), 4, 2160, { pace: 540 }),
      w("apr2", iso(2026, 3, 28), 4, 2160, { pace: 540 }),
      w("may", iso(2026, 4, 5), 4, 2160, { pace: 540 }),
    ];
    const got = runsInBucket(runs, "2026-04-01", "6m", 3, 5, NOW);
    expect(got.map((r) => r.workoutId)).toEqual(["apr1", "apr2"]);
  });

  it("returns an empty array for a bucket with zero matching runs", () => {
    const runs = [w("a", iso(2026, 4, 11), 4, 2160, { pace: 540 })];
    expect(runsInBucket(runs, "2026-03-02", "3m", 3, 5, NOW)).toEqual([]);
  });

  it("still includes a run whose derived pace is OUTSIDE [MIN,MAX]_VALID_PACE", () => {
    // 4 mi in 400s => 100 s/mi, far below MIN_VALID_PACE (180): excluded from the
    // chart's pace AVERAGE, but it is still one of the bucket's runs.
    const glitch = w("glitch", iso(2026, 4, 13), 4, 400, { pace: 100 });
    const normal = w("normal", iso(2026, 4, 11), 4, 2160, { pace: 540 });
    const got = runsInBucket([normal, glitch], "2026-05-11", "3m", 3, 5, NOW);
    expect(got.map((r) => r.workoutId)).toEqual(["normal", "glitch"]);
  });

  it("includes runs missing every metric (membership is distance+date only)", () => {
    const bare = w("bare", iso(2026, 4, 13), 4, 2160); // no pace/hr/cadence
    const got = runsInBucket([bare], "2026-05-11", "3m", 3, 5, NOW);
    expect(got.map((r) => r.workoutId)).toEqual(["bare"]);
  });

  it("returns runs chronologically ascending regardless of input order", () => {
    const runs = [
      w("late", iso(2026, 4, 16), 4, 2160, { pace: 540 }),
      w("early", iso(2026, 4, 11), 4, 2160, { pace: 540 }),
      w("mid", iso(2026, 4, 13), 4, 2160, { pace: 540 }),
    ];
    const got = runsInBucket(runs, "2026-05-11", "3m", 3, 5, NOW);
    expect(got.map((r) => r.workoutId)).toEqual(["early", "mid", "late"]);
  });

  it("excludes runs before the trailing window start", () => {
    // 3m window from June 1 2026 starts March 1 2026.
    const old = w("old", iso(2026, 0, 12), 4, 2160, { pace: 540 }); // January
    expect(runsInBucket([old], "2026-01-12", "3m", 3, 5, NOW)).toEqual([]);
  });

  it("length matches the SAME bucket's runCount from buildRunAnalysisTrend", () => {
    // The core invariant: the drill-down never disagrees with the chart's count.
    const runs = [
      w("a", iso(2026, 4, 11), 4, 2160, { pace: 540, hr: 150 }),
      w("b", iso(2026, 4, 13), 4, 400, { pace: 100, hr: 150 }), // pace outlier
      w("c", iso(2026, 4, 16), 4, 2160, { pace: 540 }), // no HR
      w("d", iso(2026, 4, 19), 4, 2160, { pace: 540, hr: 150 }),
      w("far", iso(2026, 4, 13), 9, 4860, { pace: 540, hr: 150 }), // out of range
    ];
    const pts = buildRunAnalysisTrend(runs, "pace", 3, 5, "3m", RESTING_HR, MAX_HR, NOW);
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) {
      const inBucket = runsInBucket(runs, p.bucketStartDate, "3m", 3, 5, NOW);
      expect(inBucket.length).toBe(p.runCount);
    }
  });
});
