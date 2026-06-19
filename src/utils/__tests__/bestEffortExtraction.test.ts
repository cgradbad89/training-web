import { describe, it, expect } from "vitest";
import {
  extractBestEfforts,
  selectCeilingEfforts,
  bestEffortsToEffortPoints,
  projectPaceToRaceEffort,
  RACE_EFFORT_HRR_TARGET,
  MAX_PACE_ADJUSTMENT_PCT,
  HRR_GATE_THRESHOLD,
  type BestEffortConfig,
} from "@/utils/bestEffortExtraction";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type MileSplit } from "@/utils/mileSplits";

// Authoritative anchors (mirrors settings/prefs): maxHr 175, restingHr 65.
// HRR = (HR − 65) / 110, so HR 153 = 0.80 (gate), HR 160 ≈ 0.864.
const CFG: BestEffortConfig = {
  hrrGateThreshold: HRR_GATE_THRESHOLD, // 0.80
  segmentWindowsMiles: [3, 5, 8],
  maxHr: 175,
  restingHr: 65,
};

function run(overrides: Partial<HealthWorkout>): HealthWorkout {
  return {
    workoutId: "w1",
    name: "Run",
    activityType: "running",
    displayType: "Run",
    startDate: new Date("2026-06-10T12:00:00Z"),
    endDate: new Date("2026-06-10T13:00:00Z"),
    durationSeconds: 0,
    sourceName: "Apple Watch",
    isRunLike: true,
    hasRoute: true,
    syncedAt: new Date("2026-06-10T13:00:00Z"),
    calories: 0,
    avgHeartRate: null,
    distanceMiles: 0,
    distanceMeters: null,
    avgPaceSecPerMile: null,
    avgSpeedMPS: null,
    hrDriftPct: null,
    cadenceSPM: null,
    efficiencyRaw: null,
    efficiencyScore: null,
    elevationGainM: null,
    ...overrides,
  };
}

function splits(
  count: number,
  segmentMiles: number,
  paceSecPerMile: number,
  avgBpm: number
): MileSplit[] {
  return Array.from({ length: count }, (_, i) => ({
    mile: i + 1,
    segmentMiles,
    paceSecPerMile,
    isPartial: false,
    avgBpm,
  }));
}

describe("extractBestEfforts — full-run gate", () => {
  it("happy path: a hard run (HRR ≥ gate) yields a full-run segment", () => {
    const w = run({ distanceMiles: 5, durationSeconds: 2925, avgHeartRate: 160 }); // 9:45/mi, HRR .864
    const segs = extractBestEfforts([w], CFG);
    const full = segs.filter((s) => s.segmentType === "full-run");
    expect(full).toHaveLength(1);
    expect(full[0].distanceMiles).toBe(5);
    expect(full[0].paceSecPerMile).toBeCloseTo(585, 0); // recorded-basis pace
    expect(full[0].avgHrrPercent).toBeCloseTo((160 - 65) / 110, 3);
  });

  it("HR gate rejects a fast-but-easy run (HRR < gate)", () => {
    const w = run({ distanceMiles: 5, durationSeconds: 2700, avgHeartRate: 150 }); // 9:00/mi but HRR .773
    expect(extractBestEfforts([w], CFG)).toHaveLength(0);
  });

  it("gate is inclusive at exactly the threshold (HRR == 0.80)", () => {
    const w = run({ distanceMiles: 6, durationSeconds: 3600, avgHeartRate: 153 }); // HRR exactly .80
    const segs = extractBestEfforts([w], CFG);
    expect(segs.filter((s) => s.segmentType === "full-run")).toHaveLength(1);
  });

  it("ignores non-run-like workouts", () => {
    const w = run({ distanceMiles: 5, durationSeconds: 2925, avgHeartRate: 160, isRunLike: false });
    expect(extractBestEfforts([w], CFG)).toHaveLength(0);
  });
});

describe("extractBestEfforts — continuous segment + GPS reconciliation", () => {
  it("scales segment pace to recorded distance (GPS under-count → faster pace)", () => {
    // 5 GPS miles of 0.98mi each (under-counts) → totalGps 4.9 vs recorded 5.0.
    // Run-level HR below gate so only the continuous segment is produced.
    const w = run({
      distanceMiles: 5,
      durationSeconds: 3000,
      avgHeartRate: 150, // 0.773 → no full-run
      mileSplits: splits(5, 0.98, 600, 160), // per-mile HR 160 → continuous passes
    });
    const segs = extractBestEfforts([w], { ...CFG, segmentWindowsMiles: [5] });
    const cont = segs.filter((s) => s.segmentType === "continuous-segment");
    expect(cont).toHaveLength(1);
    // raw GPS pace = 600; reconciled = 600 × (4.9/5.0) = 588.
    expect(cont[0].paceSecPerMile).toBeCloseTo(588, 0);
    expect(cont[0].paceSecPerMile).toBeLessThan(600);
    expect(cont[0].distanceMiles).toBeCloseTo(5.0, 2);
  });

  it("continuous segment is HR-gated on its own per-mile HR", () => {
    const w = run({
      distanceMiles: 5,
      durationSeconds: 3000,
      avgHeartRate: 150,
      mileSplits: splits(5, 1.0, 600, 150), // per-mile HR 150 → 0.773 < gate
    });
    expect(extractBestEfforts([w], { ...CFG, segmentWindowsMiles: [5] })).toHaveLength(0);
  });
});

describe("projectPaceToRaceEffort", () => {
  it("clamps the speed-up at MAX_PACE_ADJUSTMENT_PCT for a far-below-target effort", () => {
    const projected = projectPaceToRaceEffort(600, 0.7); // shortfall .20 → clamp .06
    expect(projected).toBeCloseTo(600 * (1 - MAX_PACE_ADJUSTMENT_PCT), 5); // 564, NOT 480
  });

  it("leaves an at/above-target effort unchanged", () => {
    expect(projectPaceToRaceEffort(600, RACE_EFFORT_HRR_TARGET)).toBe(600);
    expect(projectPaceToRaceEffort(600, RACE_EFFORT_HRR_TARGET + 0.05)).toBe(600);
  });

  it("scales proportionally to the HRR shortfall below the clamp", () => {
    // target 0.90, hrr 0.86 → shortfall 0.04 (< 0.06 clamp) → 4% speed-up.
    const projected = projectPaceToRaceEffort(600, 0.86);
    expect(projected).toBeCloseTo(600 * (1 - 0.04), 4); // 576
  });
});

describe("selectCeilingEfforts", () => {
  const seg = (distanceMiles: number, paceSecPerMile: number) => ({
    sourceWorkoutId: `${distanceMiles}-${paceSecPerMile}`,
    date: "2026-06-10",
    distanceMiles,
    paceSecPerMile,
    avgHrrPercent: 0.85,
    segmentType: "full-run" as const,
  });

  it("keeps the fastest effort per distance bucket and drops sub-minimum distances", () => {
    const chosen = selectCeilingEfforts(
      [seg(3, 520), seg(5, 600), seg(5, 585), seg(8, 620)],
      5
    );
    // 3mi dropped; 5mi keeps the faster (585); 8mi kept.
    expect(chosen.map((s) => Math.round(s.distanceMiles))).toEqual([5, 8]);
    expect(chosen.find((s) => Math.round(s.distanceMiles) === 5)!.paceSecPerMile).toBe(585);
  });
});

describe("bestEffortsToEffortPoints", () => {
  it("projects pace, tiers high-weight, and ages from the segment date", () => {
    const now = new Date("2026-06-20T12:00:00Z");
    const points = bestEffortsToEffortPoints(
      [
        {
          sourceWorkoutId: "w1",
          date: "2026-06-10",
          distanceMiles: 5,
          paceSecPerMile: 600,
          avgHrrPercent: 0.86, // shortfall 0.04 → 4% → 576
          segmentType: "full-run",
        },
      ],
      now
    );
    expect(points).toHaveLength(1);
    const p = points[0];
    expect(p.tier).toBe("QUALITY");
    expect(p.weightMultiplier).toBeGreaterThan(1);
    // timeSeconds reflects the PROJECTED pace (576/mi × 5mi), not the raw 600.
    expect(p.timeSeconds).toBeCloseTo(576 * 5, 0);
    expect(p.ageDays).toBeCloseTo(10, 0);
  });
});
