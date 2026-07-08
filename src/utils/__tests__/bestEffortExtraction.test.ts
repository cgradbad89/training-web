import { describe, it, expect } from "vitest";
import {
  extractBestEfforts,
  selectCeilingEfforts,
  buildBestEffortSegments,
  bestEffortsToEffortPoints,
  projectPaceToRaceEffort,
  RACE_EFFORT_HRR_TARGET,
  MAX_PACE_ADJUSTMENT_PCT,
  HRR_GATE_THRESHOLD,
  FAST_FINISH_MIN_SEGMENT_MILES,
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

// Per-mile splits with distinct pace/HR per mile (a real fast-finish shape),
// unlike the uniform `splits()` helper above.
function mileSplitsFrom(
  rows: Array<{ pace: number; bpm?: number; segmentMiles?: number; isPartial?: boolean }>
): MileSplit[] {
  return rows.map((r, i) => ({
    mile: i + 1,
    segmentMiles: r.segmentMiles ?? 1.0,
    paceSecPerMile: r.pace,
    isPartial: r.isPartial ?? false,
    avgBpm: r.bpm,
  }));
}

describe("extractBestEfforts — fast-finish (contiguous per-mile gate)", () => {
  it("credits an easy-start / hard-finish run the whole-run gate rejects", () => {
    // Jul-7 shape: 6mi, whole-run HR 150 (0.773 < gate → no full-run), but the
    // last 2 miles at 156/161 bpm each clear the gate individually.
    const w = run({
      distanceMiles: 6,
      durationSeconds: 3600,
      avgHeartRate: 150,
      mileSplits: mileSplitsFrom([
        { pace: 660, bpm: 140 },
        { pace: 660, bpm: 138 },
        { pace: 650, bpm: 142 },
        { pace: 640, bpm: 148 }, // 0.755 — still below the gate
        { pace: 490, bpm: 156 }, // 0.827 ≥ gate
        { pace: 470, bpm: 161 }, // 0.873 ≥ gate
      ]),
    });
    const segs = extractBestEfforts([w], { ...CFG, segmentWindowsMiles: [] });
    const ff = segs.filter((s) => s.segmentType === "fast-finish");
    expect(ff).toHaveLength(1);
    expect(ff[0].distanceMiles).toBeCloseTo(2.0, 2); // miles 5–6, ratio 1
    expect(ff[0].paceSecPerMile).toBeCloseTo(480, 0); // (490 + 470) / 2
    expect(ff[0].avgHrrPercent).toBeCloseTo((158.5 - 65) / 110, 2); // weighted 158.5 bpm
    // No full-run segment: whole-run HR is below the gate.
    expect(segs.filter((s) => s.segmentType === "full-run")).toHaveLength(0);
  });

  it("excludes a qualifying stretch just under the 2-mile floor", () => {
    expect(FAST_FINISH_MIN_SEGMENT_MILES).toBe(2);
    // Miles 5 (1.0) + 6 (0.9 partial) both clear the gate → 1.9mi < floor.
    const w = run({
      distanceMiles: 5.9,
      durationSeconds: 3600,
      avgHeartRate: 150,
      mileSplits: mileSplitsFrom([
        { pace: 660, bpm: 140 },
        { pace: 660, bpm: 138 },
        { pace: 650, bpm: 142 },
        { pace: 640, bpm: 148 },
        { pace: 490, bpm: 158 },
        { pace: 470, bpm: 158, segmentMiles: 0.9, isPartial: true },
      ]),
    });
    const segs = extractBestEfforts([w], { ...CFG, segmentWindowsMiles: [] });
    expect(segs.filter((s) => s.segmentType === "fast-finish")).toHaveLength(0);
  });

  it("produces no segment when no mile clears the gate (route fetch skipped upstream)", () => {
    // Every mile below the gate — the exact shape the service pre-filter skips
    // (no GPS route read). The extractor must also produce nothing here.
    const w = run({
      distanceMiles: 6,
      durationSeconds: 3600,
      avgHeartRate: 145, // 0.727 → no full-run either
      mileSplits: mileSplitsFrom([
        { pace: 660, bpm: 140 },
        { pace: 655, bpm: 142 },
        { pace: 650, bpm: 145 },
        { pace: 648, bpm: 148 },
        { pace: 645, bpm: 150 }, // 0.773 < gate
        { pace: 642, bpm: 149 },
      ]),
    });
    expect(extractBestEfforts([w], { ...CFG, segmentWindowsMiles: [] })).toHaveLength(0);
  });
});

describe("buildBestEffortSegments — dual floors", () => {
  it("keeps the 5mi ceiling for full-run efforts while a 2mi fast-finish survives", () => {
    const asOf = new Date("2026-06-20T12:00:00Z");
    // A hard 3mi run: full-run gate passes, but 3mi < the 5mi ceiling → dropped.
    const shortHard = run({
      workoutId: "short",
      startDate: new Date("2026-06-12T12:00:00Z"),
      distanceMiles: 3,
      durationSeconds: 1755, // 585/mi
      avgHeartRate: 160,
    });
    // A 6mi easy-start run with a 2mi hard finish → fast-finish credit.
    const fastFinish = run({
      workoutId: "ff",
      startDate: new Date("2026-06-14T12:00:00Z"),
      distanceMiles: 6,
      durationSeconds: 3600,
      avgHeartRate: 150,
      mileSplits: mileSplitsFrom([
        { pace: 660, bpm: 140 },
        { pace: 660, bpm: 138 },
        { pace: 650, bpm: 142 },
        { pace: 640, bpm: 148 },
        { pace: 490, bpm: 156 },
        { pace: 470, bpm: 161 },
      ]),
    });
    const segs = buildBestEffortSegments([shortHard, fastFinish], asOf, 175, 65);
    // 3mi full-run dropped by the 5mi ceiling (floor unchanged for that path)…
    expect(segs.some((s) => Math.round(s.distanceMiles) === 3)).toBe(false);
    // …while the 2mi fast-finish clears its own shorter floor.
    const ff = segs.find((s) => s.segmentType === "fast-finish");
    expect(ff).toBeTruthy();
    expect(ff!.distanceMiles).toBeCloseTo(2.0, 2);
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
