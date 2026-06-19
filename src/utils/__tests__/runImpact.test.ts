import { describe, it, expect } from "vitest";
import {
  computePredictionImpact,
  computeRunImpact,
  computeCtlImpact,
} from "@/utils/runImpact";
import {
  predictRaceTime,
  HALF_MARATHON_MILES,
  type PredictionRun,
} from "@/utils/racePrediction";
import { type HealthWorkout } from "@/types/healthWorkout";

// 5K target: shorter targets only need ≥4 efforts (no HM long-run gate), so
// the with/without fits are deterministic from small fixtures.
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

// 4 baseline runs at ~9:00/mi with distance spread (sxx > 0), within 56d.
const BASELINE: PredictionRun[] = [
  mkRun("a", d("2026-05-04"), 2, 540),
  mkRun("b", d("2026-05-11"), 3, 540),
  mkRun("c", d("2026-05-18"), 4, 540),
  mkRun("d", d("2026-05-25"), 5, 540),
];

const PARAMS = { raceDistanceMiles: FIVE_K, races: [] };

describe("computePredictionImpact", () => {
  it("a fast run improves the prediction → favorable negative delta (with < without)", () => {
    const fast = mkRun("current", d("2026-05-28"), 3, 460);
    const impact = computePredictionImpact(
      [...BASELINE, fast],
      "current",
      PARAMS,
      ASOF
    )!;
    expect(impact).not.toBeNull();
    expect(impact.withoutSeconds).not.toBeNull();
    expect(impact.withSeconds).toBeLessThan(impact.withoutSeconds!);
    expect(impact.deltaSeconds).toBeLessThan(0);
    expect(impact.deltaSeconds).toBeCloseTo(
      impact.withSeconds - impact.withoutSeconds!,
      6
    );
  });

  it("a slow run worsens the prediction → HONEST unfavorable positive delta", () => {
    const slow = mkRun("current", d("2026-05-28"), 3, 660);
    const impact = computePredictionImpact(
      [...BASELINE, slow],
      "current",
      PARAMS,
      ASOF
    )!;
    expect(impact).not.toBeNull();
    expect(impact.withSeconds).toBeGreaterThan(impact.withoutSeconds!);
    expect(impact.deltaSeconds).toBeGreaterThan(0);
  });

  it("sentinel when exclusion leaves too few efforts: withoutSeconds null, withSeconds kept", () => {
    // Exactly 4 efforts INCLUDING the current run → excluding it leaves 3,
    // below the model's minimum of 4 → no without-run fit.
    const runs = [
      mkRun("current", d("2026-05-04"), 2, 540),
      mkRun("b", d("2026-05-11"), 3, 540),
      mkRun("c", d("2026-05-18"), 4, 540),
      mkRun("d", d("2026-05-25"), 5, 540),
    ];
    const impact = computePredictionImpact(runs, "current", PARAMS, ASOF)!;
    expect(impact).not.toBeNull();
    expect(impact.withSeconds).toBeGreaterThan(0);
    expect(impact.withoutSeconds).toBeNull();
    expect(impact.deltaSeconds).toBeNull();
  });

  it("returns null when no prediction exists even with the full run set", () => {
    const impact = computePredictionImpact(
      BASELINE.slice(0, 3), // 3 efforts < model minimum
      "a",
      PARAMS,
      ASOF
    );
    expect(impact).toBeNull();
  });

  it("delta is 0 when the current run contributes nothing (not in the run set)", () => {
    const impact = computePredictionImpact(
      BASELINE,
      "not-a-run-id",
      PARAMS,
      ASOF
    )!;
    expect(impact.deltaSeconds).toBe(0);
  });
});

// ─── computeRunImpact (HR-gated best-effort projection, §7b) ──────────────────

const HALF = HALF_MARATHON_MILES;
const HALF_PARAMS = { raceDistanceMiles: HALF, races: [] };
const MAX_HR = 175;
const REST_HR = 65;

/** HealthWorkout with the fields computeRunImpact needs (distance/duration/HR). */
function mkHW(
  id: string,
  startDate: Date,
  miles: number,
  paceSecPerMile: number,
  avgHeartRate: number
): HealthWorkout {
  return {
    workoutId: id,
    name: "Run",
    activityType: "running",
    displayType: "Run",
    startDate,
    endDate: startDate,
    durationSeconds: miles * paceSecPerMile,
    sourceName: "Apple Watch",
    isRunLike: true,
    hasRoute: false,
    syncedAt: startDate,
    calories: 0,
    avgHeartRate,
    distanceMiles: miles,
    distanceMeters: null,
    avgPaceSecPerMile: paceSecPerMile,
    avgSpeedMPS: null,
    hrDriftPct: null,
    cadenceSPM: null,
    efficiencyRaw: null,
    efficiencyScore: null,
    elevationGainM: null,
  };
}

// Easy base (HR 145 → HRR 0.73, below the 0.80 gate → no best efforts) that
// satisfies the HM gate on its own: ≥4 efforts ≥3mi, 2+ ≥4mi in 35d, longest ≥6.
// Two runs ≥6mi so removing one easy run still clears the longest-≥6 gate.
function easyBase(): HealthWorkout[] {
  return [
    mkHW("e1", d("2026-06-12"), 7, 600, 145),
    mkHW("e2", d("2026-06-08"), 6, 600, 145),
    mkHW("e3", d("2026-06-04"), 5, 600, 145),
    mkHW("e4", d("2026-05-30"), 4, 600, 145),
    mkHW("e5", d("2026-05-26"), 4, 600, 145),
  ];
}

const NOW = d("2026-06-20");

describe("computeRunImpact", () => {
  it("a hard in-window run improves the projection → affects + negative delta", () => {
    const hard = mkHW("hard", d("2026-06-14"), 6, 510, 160); // 8:30/mi, HRR .864
    const impact = computeRunImpact(
      [...easyBase(), hard],
      "hard",
      HALF_PARAMS,
      MAX_HR,
      REST_HR,
      NOW
    )!;
    expect(impact).not.toBeNull();
    expect(impact.affectsProjection).toBe(true);
    expect(impact.withoutRunSeconds).not.toBeNull();
    expect(impact.deltaSeconds).toBeLessThan(0); // faster WITH the hard run
    expect(impact.withRunSeconds).toBeLessThan(impact.withoutRunSeconds!);
  });

  it("folds in §7b best efforts → 'with' is faster than the base-only fit (matches dashboard)", () => {
    const hard = mkHW("hard", d("2026-06-14"), 6, 510, 160);
    const all = [...easyBase(), hard];
    const baseOnly = predictRaceTime(all, HALF_PARAMS, NOW).predictedSeconds!;
    const impact = computeRunImpact(all, "hard", HALF_PARAMS, MAX_HR, REST_HR, NOW)!;
    expect(impact.withRunSeconds).toBeLessThan(baseOnly);
  });

  it("an easy in-window run has near-zero impact (in-window, |delta| small)", () => {
    const all = easyBase();
    const impact = computeRunImpact(all, "e1", HALF_PARAMS, MAX_HR, REST_HR, NOW)!;
    expect(impact.affectsProjection).toBe(true);
    expect(impact.deltaSeconds).not.toBeNull();
    expect(Math.abs(impact.deltaSeconds!)).toBeLessThan(60); // not a big mover
  });

  it("an out-of-window run (distance < 3mi) → affectsProjection false, delta null", () => {
    const short = mkHW("short", d("2026-06-15"), 2, 480, 165); // hard but 2mi
    const impact = computeRunImpact(
      [...easyBase(), short],
      "short",
      HALF_PARAMS,
      MAX_HR,
      REST_HR,
      NOW
    )!;
    expect(impact.affectsProjection).toBe(false);
    expect(impact.deltaSeconds).toBeNull();
  });

  it("an out-of-window run (older than recency window) → affectsProjection false", () => {
    const old = mkHW("old", d("2026-04-01"), 6, 510, 160); // 80d before NOW
    const impact = computeRunImpact(
      [...easyBase(), old],
      "old",
      HALF_PARAMS,
      MAX_HR,
      REST_HR,
      NOW
    )!;
    expect(impact.affectsProjection).toBe(false);
    expect(impact.deltaSeconds).toBeNull();
  });

  it("a targetRunId not in the set is found-safe → affectsProjection false, no off-by-one", () => {
    const impact = computeRunImpact(
      easyBase(),
      "not-a-real-id",
      HALF_PARAMS,
      MAX_HR,
      REST_HR,
      NOW
    )!;
    expect(impact).not.toBeNull();
    expect(impact.affectsProjection).toBe(false);
    expect(impact.deltaSeconds).toBeNull();
  });
});

// ─── CTL impact ──────────────────────────────────────────────────────────────

/** Minimal HealthWorkout for load purposes (stored V2 load wins in
 *  resolveDisplayLoad, so no HR fields are needed). */
function mkWorkout(
  id: string,
  startDate: Date,
  trainingLoadV2: number | null
): HealthWorkout {
  return {
    workoutId: id,
    name: "Run",
    activityType: "HKWorkoutActivityTypeRunning",
    displayType: "Run",
    startDate,
    endDate: startDate,
    durationSeconds: 3600,
    sourceName: "Apple Watch",
    isRunLike: true,
    hasRoute: false,
    syncedAt: startDate,
    calories: 0,
    avgHeartRate: null,
    distanceMiles: 6,
    distanceMeters: null,
    avgPaceSecPerMile: 600,
    avgSpeedMPS: null,
    hrDriftPct: null,
    cadenceSPM: null,
    efficiencyRaw: null,
    efficiencyScore: null,
    elevationGainM: null,
    trainingLoadV2,
  };
}

const TODAY = d("2026-06-01");

describe("computeCtlImpact", () => {
  it("a loaded run raises CTL: withCtl > withoutCtl, delta > 0", () => {
    const workouts = [
      mkWorkout("old-1", d("2026-04-01"), 80),
      mkWorkout("old-2", d("2026-05-01"), 90),
      mkWorkout("current", d("2026-05-30"), 100),
    ];
    const impact = computeCtlImpact(workouts, "current", 185, 60, TODAY)!;
    expect(impact.withCtl).toBeGreaterThan(impact.withoutCtl);
    expect(impact.delta).toBeGreaterThan(0);
    expect(impact.delta).toBeCloseTo(impact.withCtl - impact.withoutCtl, 9);
    // A 2-day-old load of 100 contributes roughly load × α(42d) ≈ 2.3, decayed.
    expect(impact.delta).toBeLessThan(5);
  });

  it("delta is 0 when the run has no resolvable load (null stays null, never 0-coerced)", () => {
    const workouts = [
      mkWorkout("old-1", d("2026-05-01"), 90),
      mkWorkout("current", d("2026-05-30"), null), // no stored load, no avg HR
    ];
    const impact = computeCtlImpact(workouts, "current", 185, 60, TODAY)!;
    expect(impact.delta).toBe(0);
    expect(impact.withCtl).toBe(impact.withoutCtl);
  });

  it("returns null for an empty workout set", () => {
    expect(computeCtlImpact([], "x", 185, 60, TODAY)).toBeNull();
  });

  it("uses the identical date window for both walks (excluding the earliest workout keeps the seed)", () => {
    // current = earliest workout; the without-walk must still seed from the
    // same date so the delta isolates load, not window length.
    const workouts = [
      mkWorkout("current", d("2026-05-01"), 100),
      mkWorkout("later", d("2026-05-20"), 80),
    ];
    const impact = computeCtlImpact(workouts, "current", 185, 60, TODAY)!;
    expect(impact.delta).toBeGreaterThan(0);
    expect(impact.withoutCtl).toBeGreaterThan(0); // "later" still contributes
  });
});
