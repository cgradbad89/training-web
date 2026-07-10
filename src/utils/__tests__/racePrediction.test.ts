import { describe, it, expect } from "vitest";
import {
  buildQualifyingEfforts,
  fitRiegel,
  predictSeconds,
} from "@/utils/riegelFit";
import {
  predictRaceTime,
  buildPredictionTrend,
  HALF_MARATHON_MILES,
  type PredictionRun,
} from "@/utils/racePrediction";
import { FAST_FINISH_MIN_SEGMENT_MILES, type BestEffortSegment } from "@/utils/bestEffortExtraction";
import { type RunningPlan } from "@/types/plan";

// 5K target keeps the fixtures simple: shorter targets only need ≥4 efforts
// (no half-marathon long-run gate), so fits are easy to make deterministic.
const FIVE_K = 3.10686;
const TEN_K = 10.0;
const MARATHON = 26.219;

function mkRun(
  id: string,
  startDate: Date,
  miles: number,
  paceSecPerMile: number,
): PredictionRun {
  return {
    workoutId: id,
    distanceMiles: miles,
    durationSeconds: miles * paceSecPerMile,
    startDate,
    activityType: "running",
    sourceName: "Apple Watch",
  };
}

function d(iso: string): Date {
  return new Date(iso + "T12:00:00");
}

// A simple 4-run fixture with distance spread, all within 56d of asOf.
const ASOF = d("2026-06-01");
const FIXTURE: PredictionRun[] = [
  mkRun("a", d("2026-05-04"), 2, 500),
  mkRun("b", d("2026-05-11"), 3, 510),
  mkRun("c", d("2026-05-18"), 4, 520),
  mkRun("d", d("2026-05-25"), 5, 525),
];

describe("predictRaceTime", () => {
  it("reproduces the raw buildQualifyingEfforts → fitRiegel → predictSeconds pipeline exactly (regression)", () => {
    const efforts = buildQualifyingEfforts(FIXTURE, {
      daysBack: 56,
      races: [],
      asOf: ASOF,
    });
    const fit = fitRiegel(efforts, FIVE_K, 0, { min: 0.9, max: 1.3 });
    const expected = {
      fit,
      predictedSeconds: fit ? predictSeconds(fit, FIVE_K) : null,
    };

    const got = predictRaceTime(
      FIXTURE,
      { raceDistanceMiles: FIVE_K, races: [] },
      ASOF,
    );

    expect(got).toEqual(expected);
    expect(got.predictedSeconds).toBeGreaterThan(0);
  });

  it("returns null when there are fewer than 4 qualifying runs", () => {
    const sparse = FIXTURE.slice(0, 3);
    const got = predictRaceTime(
      sparse,
      { raceDistanceMiles: FIVE_K, races: [] },
      ASOF,
    );
    expect(got.fit).toBeNull();
    expect(got.predictedSeconds).toBeNull();
  });

  it("returns null for a non-positive race distance", () => {
    expect(
      predictRaceTime(FIXTURE, { raceDistanceMiles: 0, races: [] }, ASOF)
        .predictedSeconds,
    ).toBeNull();
  });

  it("excludes runs after asOf (future-relative runs don't leak in)", () => {
    const earlyAsOf = d("2026-05-12"); // only runs a,b exist on/before this
    const got = predictRaceTime(
      FIXTURE,
      { raceDistanceMiles: FIVE_K, races: [] },
      earlyAsOf,
    );
    // Only 2 runs ≤ earlyAsOf → fewer than 4 efforts → null.
    expect(got.predictedSeconds).toBeNull();
  });

  it("an earlier asOf (slower, older runs only) predicts slower than a later asOf (fresh, faster runs)", () => {
    // Slow block ~early April; fast block ~early June. The 56d ordinary window
    // means the April runs have aged out by the June asOf, isolating each set.
    const slow: PredictionRun[] = [
      mkRun("s2", d("2026-04-02"), 2, 560),
      mkRun("s3", d("2026-04-04"), 3, 560),
      mkRun("s4", d("2026-04-06"), 4, 560),
      mkRun("s5", d("2026-04-08"), 5, 560),
    ];
    const fast: PredictionRun[] = [
      mkRun("f2", d("2026-06-02"), 2, 460),
      mkRun("f3", d("2026-06-04"), 3, 460),
      mkRun("f4", d("2026-06-06"), 4, 460),
      mkRun("f5", d("2026-06-08"), 5, 460),
    ];
    const all = [...slow, ...fast];
    const params = { raceDistanceMiles: FIVE_K, races: [] };

    const early = predictRaceTime(all, params, d("2026-04-15")).predictedSeconds;
    const later = predictRaceTime(all, params, d("2026-06-15")).predictedSeconds;

    expect(early).not.toBeNull();
    expect(later).not.toBeNull();
    expect(early!).toBeGreaterThan(later!); // earlier = slower
  });
});

// ─── fastFinishMinMiles wiring (fast-finish bypass of minMilesForFit) ─────────
//
// Half-marathon-gate-satisfying base: 4 BASELINE runs ≥4mi with a recent ≥6mi
// run within 35d, so the half+ "2 medium-long + longest≥6" gate passes without
// a RACE anchor — mirrors riegelFit.test.ts's halfGateBase, as PredictionRuns.
describe("predictRaceTime — fastFinishMinMiles wiring", () => {
  const HALF_ASOF = d("2026-06-01");
  const HALF_FIXTURE: PredictionRun[] = [
    mkRun("h1", d("2026-05-27"), 6, 570),
    mkRun("h2", d("2026-05-22"), 5, 580),
    mkRun("h3", d("2026-05-17"), 4, 590),
    mkRun("h4", d("2026-05-12"), 8, 600),
  ];

  function ffSegment(overrides: Partial<BestEffortSegment> = {}): BestEffortSegment {
    return {
      sourceWorkoutId: "ff1",
      date: "2026-05-30",
      distanceMiles: FAST_FINISH_MIN_SEGMENT_MILES, // 2.0
      paceSecPerMile: 559,
      avgHrrPercent: 0.852,
      segmentType: "fast-finish",
      ...overrides,
    };
  }

  it("a fast-finish segment now genuinely reaches and moves the half-marathon fit (previously entirely inert)", () => {
    const params = { raceDistanceMiles: HALF_MARATHON_MILES, races: [] };
    const without = predictRaceTime(HALF_FIXTURE, params, HALF_ASOF);
    const withSeg = predictRaceTime(
      HALF_FIXTURE,
      { ...params, bestEffortSegments: [ffSegment()] },
      HALF_ASOF,
    );
    expect(without.fit).not.toBeNull();
    expect(withSeg.fit).not.toBeNull();
    expect(withSeg.fit!.n).toBe(without.fit!.n + 1); // the 2mi segment survived
    expect(withSeg.fit!.minMiles).toBe(2);
    expect(withSeg.predictedSeconds).not.toBeNull();
    expect(withSeg.predictedSeconds).not.toBe(without.predictedSeconds); // genuinely moved the fit
  });

  it("a fast-finish segment for a marathon target also reaches the fit (long branch, same minMilesForFit=3.0 as half)", () => {
    const params = { raceDistanceMiles: MARATHON, races: [] };
    const without = predictRaceTime(HALF_FIXTURE, params, HALF_ASOF);
    const withSeg = predictRaceTime(
      HALF_FIXTURE,
      { ...params, bestEffortSegments: [ffSegment()] },
      HALF_ASOF,
    );
    expect(without.fit).not.toBeNull();
    expect(withSeg.fit!.n).toBe(without.fit!.n + 1);
    expect(withSeg.fit!.minMiles).toBe(2);
  });

  it("a full-run best-effort segment (non-fast-finish) is still excluded under 3mi for half+ targets — regression, unaffected by this change", () => {
    const shortFullRun: BestEffortSegment = {
      sourceWorkoutId: "fr1",
      date: "2026-05-30",
      distanceMiles: 2.5, // < minMilesForFit(3.0), NOT fast-finish
      paceSecPerMile: 560,
      avgHrrPercent: 0.85,
      segmentType: "full-run",
    };
    const params = { raceDistanceMiles: HALF_MARATHON_MILES, races: [] };
    const without = predictRaceTime(HALF_FIXTURE, params, HALF_ASOF);
    const withSeg = predictRaceTime(
      HALF_FIXTURE,
      { ...params, bestEffortSegments: [shortFullRun] },
      HALF_ASOF,
    );
    expect(withSeg.fit!.n).toBe(without.fit!.n); // still excluded, n unchanged
  });

  it("5K target predictions are unaffected — exact reproduction of the raw pipeline with no fast-finish segments", () => {
    const efforts = buildQualifyingEfforts(FIXTURE, { daysBack: 56, races: [], asOf: ASOF });
    const expectedFit = fitRiegel(efforts, FIVE_K, 0, { min: 0.9, max: 1.3 }); // pre-fix 4-arg call
    const got = predictRaceTime(FIXTURE, { raceDistanceMiles: FIVE_K, races: [] }, ASOF);
    expect(got.fit).toEqual(expectedFit);
  });

  it("10K target predictions are unaffected — exact reproduction of the raw pipeline with no fast-finish segments", () => {
    const efforts = buildQualifyingEfforts(FIXTURE, { daysBack: 56, races: [], asOf: ASOF });
    const expectedFit = fitRiegel(efforts, TEN_K, 0, { min: 0.9, max: 1.3 });
    const got = predictRaceTime(FIXTURE, { raceDistanceMiles: TEN_K, races: [] }, ASOF);
    expect(got.fit).toEqual(expectedFit);
  });

  it("half-marathon target predictions are unaffected when no fast-finish segments are present — exact reproduction", () => {
    const efforts = buildQualifyingEfforts(HALF_FIXTURE, { daysBack: 56, races: [], asOf: HALF_ASOF });
    const expectedFit = fitRiegel(efforts, HALF_MARATHON_MILES, 3.0, { min: 1.04, max: 1.1 });
    const got = predictRaceTime(HALF_FIXTURE, { raceDistanceMiles: HALF_MARATHON_MILES, races: [] }, HALF_ASOF);
    expect(got.fit).toEqual(expectedFit);
  });

  it("marathon target predictions are unaffected when no fast-finish segments are present — exact reproduction", () => {
    const efforts = buildQualifyingEfforts(HALF_FIXTURE, { daysBack: 56, races: [], asOf: HALF_ASOF });
    const expectedFit = fitRiegel(efforts, MARATHON, 3.0, { min: 1.04, max: 1.1 });
    const got = predictRaceTime(HALF_FIXTURE, { raceDistanceMiles: MARATHON, races: [] }, HALF_ASOF);
    expect(got.fit).toEqual(expectedFit);
  });
});

// ─── buildPredictionTrend ─────────────────────────────────────────────────────

function mkPlan(startISO: string, numWeeks: number): RunningPlan {
  return {
    id: "plan1",
    name: "Test Plan",
    planType: "running",
    startDate: startISO,
    weeks: Array.from({ length: numWeeks }, (_, i) => ({
      weekNumber: i + 1,
      entries: [],
    })),
  } as unknown as RunningPlan;
}

// Plan starts Mon 2026-04-06; "now" is Wed of week 7 (2026-05-20).
//   W1 Apr6–12 … W6 May11–17 (all past), W7 May18–24 (in-progress), W8 May25–31 (future)
const PLAN = mkPlan("2026-04-06", 8);
const NOW = d("2026-05-20");
// Four runs in early May → ≥4 efforts only from W5's end onward.
const TREND_RUNS: PredictionRun[] = [
  mkRun("r1", d("2026-05-02"), 2, 500),
  mkRun("r2", d("2026-05-05"), 3, 510),
  mkRun("r3", d("2026-05-08"), 4, 520),
  mkRun("r4", d("2026-05-09"), 5, 525),
];
const TREND_PARAMS = {
  raceDistanceMiles: FIVE_K,
  races: [],
  goalSeconds: 1500,
};

describe("buildPredictionTrend", () => {
  const trend = buildPredictionTrend(PLAN, TREND_RUNS, TREND_PARAMS, NOW);

  it("returns exactly one point per plan week, labeled W1..Wn", () => {
    expect(trend).toHaveLength(8);
    expect(trend.map((p) => p.label)).toEqual([
      "W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8",
    ]);
    expect(trend.map((p) => p.weekNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("carries goalSeconds as a constant on every point", () => {
    for (const p of trend) expect(p.goalSeconds).toBe(1500);
  });

  it("is null for weeks before enough data exists (W1–W4)", () => {
    expect(trend[0].predictedSeconds).toBeNull(); // W1
    expect(trend[3].predictedSeconds).toBeNull(); // W4
  });

  it("has predictions once ≥4 runs are in range (W5, W6)", () => {
    expect(trend[4].predictedSeconds).not.toBeNull(); // W5
    expect(trend[5].predictedSeconds).not.toBeNull(); // W6
  });

  it("nulls out future weeks that haven't started (W8)", () => {
    expect(trend[7].predictedSeconds).toBeNull();
  });

  it("the in-progress week (W7) uses asOf=now → matches the live prediction card", () => {
    const live = predictRaceTime(
      TREND_RUNS,
      { raceDistanceMiles: FIVE_K, races: [] },
      NOW,
    ).predictedSeconds;
    expect(trend[6].predictedSeconds).toBe(live);
    expect(trend[6].predictedSeconds).not.toBeNull();
  });

  it("produces ≥2 predicted weeks for the chart to render a trend", () => {
    const predicted = trend.filter((p) => p.predictedSeconds != null);
    expect(predicted.length).toBeGreaterThanOrEqual(2);
  });

  it("passes goalSeconds=null through unchanged (no target set)", () => {
    const noGoal = buildPredictionTrend(
      PLAN,
      TREND_RUNS,
      { ...TREND_PARAMS, goalSeconds: null },
      NOW,
    );
    for (const p of noGoal) expect(p.goalSeconds).toBeNull();
  });
});
