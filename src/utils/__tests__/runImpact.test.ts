import { describe, it, expect } from "vitest";
import {
  computePredictionImpact,
  computeCtlImpact,
} from "@/utils/runImpact";
import { type PredictionRun } from "@/utils/racePrediction";
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
