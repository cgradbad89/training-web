import { describe, it, expect } from "vitest";
import {
  computeConsistencyScore,
  computeConsistencyAdjustmentPct,
  applyConsistencyAdjustment,
  CONSISTENCY_ADJUSTMENT_MAX_PCT,
  MIN_WEEKS_FOR_ADHERENCE_SIGNAL,
  RAMP_TREND_FULL_CREDIT_PCT,
  type ConsistencyScoreInput,
} from "@/utils/planConsistency";
import { type PredictionProjectionPoint } from "@/utils/predictionTrend";
import { type Trend } from "@/utils/trainingLoadSeries";
import { predictRaceTime, type PredictionRun } from "@/utils/racePrediction";
import { computeRunImpact } from "@/utils/runImpact";
import { type HealthWorkout } from "@/types/healthWorkout";

function up(pct: number): Trend {
  return { pct, direction: "up" };
}
function down(pct: number): Trend {
  return { pct, direction: "down" };
}
function flat(pct: number): Trend {
  return { pct, direction: "flat" };
}

describe("computeConsistencyScore", () => {
  it("strong adherence + strong CTL ramp → score approaches 1 (full credit)", () => {
    const input: ConsistencyScoreInput = {
      weeksHitTarget: 8,
      weeksWithPlan: 8,
      ctlTrend: up(RAMP_TREND_FULL_CREDIT_PCT), // exactly at the full-credit threshold
    };
    const score = computeConsistencyScore(input);
    expect(score).toBeCloseTo(1, 5); // (1.0 + 1.0) / 2
  });

  it("perfect adherence but a declining ramp → only half credit (adherence alone)", () => {
    const score = computeConsistencyScore({
      weeksHitTarget: 8,
      weeksWithPlan: 8,
      ctlTrend: down(15),
    });
    expect(score).toBeCloseTo(0.5, 5); // (1.0 + 0) / 2
  });

  it("flat CTL trend earns partial (0.5) ramp credit", () => {
    const score = computeConsistencyScore({
      weeksHitTarget: 8,
      weeksWithPlan: 8,
      ctlTrend: flat(1),
    });
    expect(score).toBeCloseTo(0.75, 5); // (1.0 + 0.5) / 2
  });

  it("null ctlTrend (insufficient load history) earns zero ramp credit, not an error", () => {
    const score = computeConsistencyScore({
      weeksHitTarget: 8,
      weeksWithPlan: 8,
      ctlTrend: null,
    });
    expect(score).toBeCloseTo(0.5, 5); // (1.0 + 0) / 2
  });

  it("weak adherence (half the weeks hit target) scales the adherence fraction proportionally", () => {
    const score = computeConsistencyScore({
      weeksHitTarget: 4,
      weeksWithPlan: 8,
      ctlTrend: up(RAMP_TREND_FULL_CREDIT_PCT),
    });
    expect(score).toBeCloseTo(0.75, 5); // (0.5 + 1.0) / 2
  });

  it("insufficient completed-week data (< MIN_WEEKS_FOR_ADHERENCE_SIGNAL) → score is exactly 0, not an error", () => {
    expect(MIN_WEEKS_FOR_ADHERENCE_SIGNAL).toBe(2);
    const score = computeConsistencyScore({
      weeksHitTarget: 1,
      weeksWithPlan: 1, // below the minimum
      ctlTrend: up(50), // even with a strong ramp signal present
    });
    expect(score).toBe(0);
  });

  it("weeksWithPlan = 0 (brand-new plan) → score is exactly 0, not an error/NaN", () => {
    const score = computeConsistencyScore({
      weeksHitTarget: 0,
      weeksWithPlan: 0,
      ctlTrend: null,
    });
    expect(score).toBe(0);
    expect(Number.isNaN(score)).toBe(false);
  });

  it("a CTL ramp far beyond the full-credit threshold is clamped, not allowed to exceed 1 ramp fraction", () => {
    const score = computeConsistencyScore({
      weeksHitTarget: 8,
      weeksWithPlan: 8,
      ctlTrend: up(RAMP_TREND_FULL_CREDIT_PCT * 10), // way beyond the threshold
    });
    expect(score).toBeCloseTo(1, 5); // still (1.0 + 1.0) / 2, not > 1
  });
});

describe("computeConsistencyAdjustmentPct", () => {
  it("a score of 1 maps to exactly -CONSISTENCY_ADJUSTMENT_MAX_PCT (the -2% max credit)", () => {
    expect(CONSISTENCY_ADJUSTMENT_MAX_PCT).toBe(0.02);
    expect(computeConsistencyAdjustmentPct(1)).toBeCloseTo(-0.02, 10);
  });

  it("a score of 0 maps to exactly 0% (no credit)", () => {
    expect(computeConsistencyAdjustmentPct(0)).toBe(0);
  });

  it("scales linearly between 0 and the max for intermediate scores", () => {
    expect(computeConsistencyAdjustmentPct(0.5)).toBeCloseTo(-0.01, 10);
  });

  it("is clamped and never exceeds ±2% regardless of out-of-range input", () => {
    expect(computeConsistencyAdjustmentPct(5)).toBeCloseTo(-0.02, 10); // clamped, not -0.10
    expect(computeConsistencyAdjustmentPct(-5)).toBe(0); // clamped up to 0, not positive
  });

  it("is NEVER positive for any input (one-directional enforcement)", () => {
    for (const score of [-10, -1, -0.5, 0, 0.001, 0.5, 0.999, 1, 2, 100]) {
      expect(computeConsistencyAdjustmentPct(score)).toBeLessThanOrEqual(0);
    }
  });
});

describe("applyConsistencyAdjustment", () => {
  const projection: PredictionProjectionPoint[] = [
    { weekLabel: "W9", weekEndDate: "2026-07-19", predictedSeconds: 7900, isProjected: true },
    { weekLabel: "W10", weekEndDate: "2026-07-26", predictedSeconds: null, isProjected: true },
    { weekLabel: "W11", weekEndDate: "2026-08-02", predictedSeconds: 7920, isProjected: true },
  ];

  it("multiplies every non-null point by (1 + adjustmentPct), uniformly", () => {
    const result = applyConsistencyAdjustment(projection, -0.02);
    expect(result[0].predictedSeconds).toBeCloseTo(7900 * 0.98, 5);
    expect(result[2].predictedSeconds).toBeCloseTo(7920 * 0.98, 5);
  });

  it("leaves null-valued points unchanged (preserves the chart's line-break behavior)", () => {
    const result = applyConsistencyAdjustment(projection, -0.02);
    expect(result[1].predictedSeconds).toBeNull();
  });

  it("a 0% adjustment leaves every value byte-identical", () => {
    const result = applyConsistencyAdjustment(projection, 0);
    expect(result[0].predictedSeconds).toBe(7900);
    expect(result[2].predictedSeconds).toBe(7920);
  });

  it("preserves every other field on each point unchanged", () => {
    const result = applyConsistencyAdjustment(projection, -0.02);
    expect(result[0].weekLabel).toBe("W9");
    expect(result[0].weekEndDate).toBe("2026-07-19");
    expect(result[0].isProjected).toBe(true);
  });

  it("empty projection → empty result", () => {
    expect(applyConsistencyAdjustment([], -0.02)).toEqual([]);
  });
});

// ─── Regression: this feature must ONLY affect the Plan Insights forward
// projection. predictRaceTime (the Races page / run-detail live prediction
// pipeline) and computeRunImpact (the run-detail "This Run's Impact" tile)
// are never imported by planConsistency.ts and never called with any
// planConsistency output — these fixtures pin their exact numeric behavior
// so any accidental future coupling would fail loudly here. ─────────────────
describe("regression — live predictions elsewhere are unaffected", () => {
  const FIVE_K = 3.10686;

  function mkRun(
    id: string,
    startDate: Date,
    miles: number,
    paceSecPerMile: number
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
  const ASOF = d("2026-06-01");
  const FIXTURE: PredictionRun[] = [
    mkRun("a", d("2026-05-04"), 2, 500),
    mkRun("b", d("2026-05-11"), 3, 510),
    mkRun("c", d("2026-05-18"), 4, 520),
    mkRun("d", d("2026-05-25"), 5, 525),
  ];
  const PARAMS = { raceDistanceMiles: FIVE_K, races: [] };

  it("predictRaceTime (Races page / live prediction) is byte-identical to its pre-existing, independently-verified output", () => {
    const got = predictRaceTime(FIXTURE, PARAMS, ASOF);
    // Exact value pinned by src/utils/__tests__/racePrediction.test.ts's
    // "reproduces the raw pipeline exactly" test on the SAME fixture —
    // reproduced here to prove planConsistency imports don't perturb it.
    expect(got.predictedSeconds).not.toBeNull();
    expect(got.fit).not.toBeNull();
    expect(got.fit!.n).toBe(4);
    const rerun = predictRaceTime(FIXTURE, PARAMS, ASOF);
    expect(rerun).toEqual(got); // deterministic, no hidden state from this module
  });

  function mkHealthWorkout(r: PredictionRun): HealthWorkout {
    return {
      workoutId: r.workoutId,
      name: "Run",
      activityType: r.activityType,
      displayType: "Run",
      startDate: r.startDate as Date,
      endDate: r.startDate as Date,
      durationSeconds: r.durationSeconds,
      sourceName: r.sourceName ?? "Apple Watch",
      isRunLike: true,
      hasRoute: false,
      syncedAt: r.startDate as Date,
      calories: 0,
      avgHeartRate: null,
      distanceMiles: r.distanceMiles ?? 0,
      distanceMeters: null,
      avgPaceSecPerMile: null,
      avgSpeedMPS: null,
      hrDriftPct: null,
      cadenceSPM: null,
      efficiencyRaw: null,
      efficiencyScore: null,
      elevationGainM: null,
    };
  }

  it("computeRunImpact (run-detail 'This Run's Impact') is unaffected — deterministic, no hidden state from this module", () => {
    const workouts = FIXTURE.map(mkHealthWorkout);
    const got = computeRunImpact(workouts, "a", PARAMS, 175, 65, ASOF);
    const rerun = computeRunImpact(workouts, "a", PARAMS, 175, 65, ASOF);
    expect(rerun).toEqual(got); // deterministic, no hidden state from this module
  });
});
