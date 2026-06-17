import { describe, expect, it } from "vitest";

import {
  computeTrainingLoadV2,
  computeStreamedTrainingLoad,
  resolveDisplayLoad,
  buildLoadExplainer,
  activityLoadFactor,
  DEFAULT_RESTING_HR,
  resolveRestingHr,
  HIIT_LOAD_FACTOR,
  DEFAULT_HIIT_FACTOR,
  STRENGTH_LOAD_FACTOR,
  MINDFUL_LOAD_FACTOR,
  TRAINING_LOAD_DT_CLAMP_SEC,
  STREAMED_HR_COVERAGE_MIN,
  STREAMED_LOAD_COLLAPSE_THRESHOLD,
} from "@/utils/trainingLoad";
import { type UserSettings } from "@/types/userSettings";

const STREAM_BASE_MS = Date.parse("2024-01-01T00:00:00Z");

/** Build a point stream: `count` points `dtSec` apart, hr chosen per `hrAt(i)`. */
function buildStream(
  count: number,
  hrAt: (i: number) => number | null,
  dtSec = 1,
  startMs = STREAM_BASE_MS
): { timestamp: string; hr: number | null }[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(startMs + i * dtSec * 1000).toISOString(),
    hr: hrAt(i),
  }));
}

// Validated reference profile: maxHr 164, restingHr 60 → reserve 104.
const MAX_HR = 164;
const RESTING_HR = 60;

describe("resolveRestingHr", () => {
  it("uses the user's resting HR when set", () => {
    expect(resolveRestingHr({ restingHeartRate: 48 } as UserSettings)).toBe(48);
  });
  it("falls back to DEFAULT_RESTING_HR (60) when unset/null", () => {
    expect(DEFAULT_RESTING_HR).toBe(60);
    expect(resolveRestingHr(null)).toBe(DEFAULT_RESTING_HR);
    expect(resolveRestingHr(undefined)).toBe(DEFAULT_RESTING_HR);
    expect(resolveRestingHr({} as UserSettings)).toBe(DEFAULT_RESTING_HR);
  });
});

describe("computeTrainingLoadV2 — validated reference runs (±3)", () => {
  const cases: Array<{ name: string; avgHR: number; durSec: number; expected: number }> = [
    { name: "Mon 6/1 easy", avgHR: 137, durSec: 1854, expected: 69 },
    { name: "Sun 5/31 hard", avgHR: 156, durSec: 1764, expected: 116 },
    { name: "Wed 5/27 long", avgHR: 152, durSec: 4370, expected: 256 },
  ];
  for (const c of cases) {
    it(`${c.name} → ≈ ${c.expected}`, () => {
      const load = computeTrainingLoadV2(c.durSec, c.avgHR, MAX_HR, RESTING_HR, "Running");
      expect(load).not.toBeNull();
      expect(Math.abs((load as number) - c.expected)).toBeLessThanOrEqual(3);
    });
  }
});

describe("computeTrainingLoadV2 — guards & behavior", () => {
  it("HRR clamps to 1.0 when avgHR exceeds maxHr (no overflow), still a number", () => {
    const atMax = computeTrainingLoadV2(1800, MAX_HR, MAX_HR, RESTING_HR, "Running");
    const over = computeTrainingLoadV2(1800, MAX_HR + 40, MAX_HR, RESTING_HR, "Running");
    expect(over).not.toBeNull();
    expect(typeof over).toBe("number");
    // Above max clamps to the same HRR=1.0 score as exactly at max.
    expect(over).toBe(atMax);
  });

  it("returns null (not 0) when avgHeartRate is null/undefined", () => {
    expect(computeTrainingLoadV2(1800, null, MAX_HR, RESTING_HR, "Running")).toBeNull();
    expect(
      computeTrainingLoadV2(1800, undefined, MAX_HR, RESTING_HR, "Running")
    ).toBeNull();
  });

  it("returns null when avgHeartRate is ≤ 0 or non-finite", () => {
    expect(computeTrainingLoadV2(1800, 0, MAX_HR, RESTING_HR)).toBeNull();
    expect(computeTrainingLoadV2(1800, -5, MAX_HR, RESTING_HR)).toBeNull();
    expect(computeTrainingLoadV2(1800, NaN, MAX_HR, RESTING_HR)).toBeNull();
  });

  it("returns null when durationSeconds is 0 or negative", () => {
    expect(computeTrainingLoadV2(0, 140, MAX_HR, RESTING_HR)).toBeNull();
    expect(computeTrainingLoadV2(-100, 140, MAX_HR, RESTING_HR)).toBeNull();
  });

  it("returns null when maxHr <= restingHr (no divide-by-zero)", () => {
    expect(computeTrainingLoadV2(1800, 140, 60, 60)).toBeNull();
    expect(computeTrainingLoadV2(1800, 140, 55, 60)).toBeNull();
  });

  it("HIIT load = round(running load × avg HRR) — intensity-proportional factor", () => {
    // avgHR 156 → HRR = (156−60)/104 = 0.9231. HIIT factor is now that HRR
    // (not the old flat 0.75), so HIIT ≈ running × 0.9231, still < running.
    const hrr = (156 - RESTING_HR) / (MAX_HR - RESTING_HR);
    const running = computeTrainingLoadV2(1764, 156, MAX_HR, RESTING_HR, "Running");
    const hiit = computeTrainingLoadV2(
      1764,
      156,
      MAX_HR,
      RESTING_HR,
      "HighIntensityIntervalTraining"
    );
    expect(running).not.toBeNull();
    expect(hiit).not.toBeNull();
    // Factor is applied inside the round, so round(raw×HRR) can differ from
    // round(roundedRunning×HRR) by 1 — assert within ±1 and strictly lower.
    expect(
      Math.abs((hiit as number) - (running as number) * hrr)
    ).toBeLessThanOrEqual(1);
    expect(hiit as number).toBeLessThan(running as number);
    // And NOT the old flat-0.75 value (proves the factor changed).
    expect(hiit as number).not.toBe(
      Math.round((running as number) * HIIT_LOAD_FACTOR)
    );
  });

  it("monotonic: higher avgHR (same duration) → strictly higher load", () => {
    const lo = computeTrainingLoadV2(1800, 130, MAX_HR, RESTING_HR, "Running");
    const mid = computeTrainingLoadV2(1800, 145, MAX_HR, RESTING_HR, "Running");
    const hi = computeTrainingLoadV2(1800, 160, MAX_HR, RESTING_HR, "Running");
    expect(lo).not.toBeNull();
    expect((mid as number)).toBeGreaterThan(lo as number);
    expect((hi as number)).toBeGreaterThan(mid as number);
  });
});

describe("activityLoadFactor — HIIT intensity-proportional (HIIT-only)", () => {
  it("HIIT factor equals the clamped avg HRR passed in", () => {
    // HRR ≈ 0.59 (easy HIIT) and ≈ 0.88 (hard HIIT) → factor tracks it 1:1.
    expect(activityLoadFactor("HIIT", 0.59)).toBeCloseTo(0.59, 10);
    expect(activityLoadFactor("HIIT", 0.88)).toBeCloseTo(0.88, 10);
    expect(activityLoadFactor("orangetheory", 0.73)).toBeCloseTo(0.73, 10);
  });

  it("HIIT factor clamps HRR to [0, 1]", () => {
    expect(activityLoadFactor("HIIT", 1.5)).toBe(1.0);
    expect(activityLoadFactor("HIIT", -0.2)).toBe(0);
  });

  it("HIIT falls back to DEFAULT_HIIT_FACTOR (0.75) when HRR is absent/non-finite", () => {
    expect(DEFAULT_HIIT_FACTOR).toBe(0.75);
    expect(DEFAULT_HIIT_FACTOR).toBe(HIIT_LOAD_FACTOR);
    expect(activityLoadFactor("HIIT")).toBe(DEFAULT_HIIT_FACTOR);
    expect(activityLoadFactor("HIIT", NaN)).toBe(DEFAULT_HIIT_FACTOR);
    expect(activityLoadFactor("HIIT", undefined)).toBe(DEFAULT_HIIT_FACTOR);
  });

  it("running / strength / mindful factors are UNCHANGED and ignore HRR", () => {
    // Pass an HRR to prove non-HIIT types do not consume it.
    for (const hrr of [undefined, 0.2, 0.59, 0.95, 1.5]) {
      expect(activityLoadFactor("Running", hrr)).toBe(1.0);
      expect(activityLoadFactor("rowing", hrr)).toBe(1.0);
      expect(activityLoadFactor(undefined, hrr)).toBe(1.0);
      expect(activityLoadFactor("traditional_strength_training", hrr)).toBe(
        STRENGTH_LOAD_FACTOR
      );
      expect(activityLoadFactor("Pilates", hrr)).toBe(MINDFUL_LOAD_FACTOR);
    }
  });
});

describe("HIIT f=avg-HRR — reference sessions vs Strava RE (±8 / ~4% MAPE)", () => {
  // Factor-1.0 base load (L1) from the hrStream investigation per session, the
  // session avg HR, and external Strava RE (ground truth). The new HIIT factor
  // is f = clamp(avg HRR). load_new = round(L1 × activityLoadFactor("HIIT", HRR)).
  // 6-session sample — small ground truth, flagged tunable.
  const REF = [
    { date: "5/28", L1: 84, avgHR: 121, RE: 49 },
    { date: "6/4", L1: 92, avgHR: 128, RE: 61 },
    { date: "5/20", L1: 157, avgHR: 138, RE: 114 },
    { date: "6/5", L1: 125, avgHR: 141, RE: 106 },
    { date: "5/25", L1: 168, avgHR: 144, RE: 149 },
    { date: "5/22", L1: 210, avgHR: 151, RE: 188 },
  ];
  const hrrOf = (avgHR: number) =>
    Math.max(0, Math.min(1, (avgHR - RESTING_HR) / (MAX_HR - RESTING_HR)));
  const loadAt = (L1: number, avgHR: number) =>
    Math.round(L1 * activityLoadFactor("HIIT", hrrOf(avgHR)));

  it("the easy session 5/28 lands near its RE 49 (was 63 at flat 0.75)", () => {
    const s = REF[0];
    expect(loadAt(s.L1, s.avgHR)).toBe(49); // 84 × 0.5865 ≈ 49
    expect(Math.abs(loadAt(s.L1, s.avgHR) - s.RE)).toBeLessThanOrEqual(8);
    // It must be well below the old flat-0.75 value of 63.
    expect(loadAt(s.L1, s.avgHR)).toBeLessThan(Math.round(s.L1 * 0.75));
  });

  it("the hard session 5/22 lands near its RE 188 (was 158 at flat 0.75)", () => {
    const s = REF[5];
    expect(Math.abs(loadAt(s.L1, s.avgHR) - s.RE)).toBeLessThanOrEqual(8); // ≈184
    // It must be well above the old flat-0.75 value of 158.
    expect(loadAt(s.L1, s.avgHR)).toBeGreaterThan(Math.round(s.L1 * 0.75));
  });

  it("mean |ratio−1| across the 6 sessions is ≤ 6% (parameter-free ~4% fit)", () => {
    const mape =
      REF.reduce((a, s) => a + Math.abs(loadAt(s.L1, s.avgHR) / s.RE - 1), 0) /
      REF.length;
    expect(mape).toBeLessThanOrEqual(0.06);
    // And it must beat the old flat 0.75 factor's error.
    const mape075 =
      REF.reduce(
        (a, s) => a + Math.abs(Math.round(s.L1 * 0.75) / s.RE - 1),
        0
      ) / REF.length;
    expect(mape).toBeLessThan(mape075);
  });
});

describe("HIIT factor — streamed path & fallback behavior", () => {
  it("streamed HIIT factor uses AVG HRR (per-session scalar), not per-sample", () => {
    // Spiky stream (alternating 180/100) with a declared avgHR of 140 →
    // factor must use HRR(140)=0.769, independent of the per-sample spikes.
    const pts = buildStream(600, (i) => (i % 2 === 0 ? 180 : 100));
    const hiit = computeStreamedTrainingLoad(pts, 600, 140, MAX_HR, RESTING_HR, "HIIT");
    const run = computeStreamedTrainingLoad(pts, 600, 140, MAX_HR, RESTING_HR, "Running");
    expect(hiit.method).toBe("streamed");
    expect(hiit.load).not.toBeNull();
    const hrr = (140 - RESTING_HR) / (MAX_HR - RESTING_HR);
    // HIIT base (same integral as the run) × avg HRR.
    expect(Math.abs((hiit.load as number) - (run.load as number) * hrr)).toBeLessThanOrEqual(1);
  });

  it("streamed HIIT with NO avgHR falls back to DEFAULT_HIIT_FACTOR 0.75 (no NaN/null)", () => {
    const pts = buildStream(600, () => 152);
    const hiit = computeStreamedTrainingLoad(pts, 600, null, MAX_HR, RESTING_HR, "HIIT");
    const run = computeStreamedTrainingLoad(pts, 600, null, MAX_HR, RESTING_HR, "Running");
    expect(hiit.method).toBe("streamed");
    expect(hiit.load).not.toBeNull();
    expect(Number.isFinite(hiit.load as number)).toBe(true);
    // Factor falls back to 0.75 (run uses 1.0).
    expect(
      Math.abs((hiit.load as number) - (run.load as number) * DEFAULT_HIIT_FACTOR)
    ).toBeLessThanOrEqual(1);
  });

  it("avg-HR HIIT with missing avgHR → null (existing null rule, no NaN from the factor)", () => {
    expect(
      computeTrainingLoadV2(1800, null, MAX_HR, RESTING_HR, "HIIT")
    ).toBeNull();
  });
});

describe("runs are completely unaffected by the HIIT factor change", () => {
  it("Running loads still match the validated reference values (factor 1.0, ±3)", () => {
    // Same fixtures/tolerance as the reference-runs suite — unchanged after the
    // HIIT edit (running ignores the new hrr arg → factor stays 1.0).
    const refs: Array<[number, number, number]> = [
      [1854, 137, 69],
      [1764, 156, 116],
      [4370, 152, 256],
    ];
    for (const [dur, hr, expected] of refs) {
      const load = computeTrainingLoadV2(dur, hr, MAX_HR, RESTING_HR, "Running");
      expect(Math.abs((load as number) - expected)).toBeLessThanOrEqual(3);
    }
  });
});

describe("computeStreamedTrainingLoad", () => {
  it("clean ~1Hz stream reconciles with the avg-HR result (within ~5%)", () => {
    // 600 points, 1s apart, constant 152 bpm.
    const pts = buildStream(600, () => 152);
    const res = computeStreamedTrainingLoad(pts, 600, 152, MAX_HR, RESTING_HR, "Running");
    expect(res.method).toBe("streamed");
    const avg = computeTrainingLoadV2(600, 152, MAX_HR, RESTING_HR, "Running") as number;
    expect(res.load).not.toBeNull();
    expect(Math.abs((res.load as number) - avg) / avg).toBeLessThanOrEqual(0.05);
  });

  it("pause-gap clamp: a 1000s gap contributes ≤ clamp, not 1000s of load", () => {
    const noGap = buildStream(600, () => 152);
    // Same points but shift everything after index 300 forward by 1000s → one
    // ~1001s gap that must clamp to TRAINING_LOAD_DT_CLAMP_SEC.
    const withGap = noGap.map((p, i) =>
      i >= 300
        ? {
            ...p,
            timestamp: new Date(
              Date.parse(p.timestamp) + 1000 * 1000
            ).toISOString(),
          }
        : p
    );
    const gLoad = computeStreamedTrainingLoad(withGap, 600, 152, MAX_HR, RESTING_HR, "Running").load as number;
    const nLoad = computeStreamedTrainingLoad(noGap, 600, 152, MAX_HR, RESTING_HR, "Running").load as number;
    // Clamp keeps the gap's contribution tiny (≤ clamp seconds), so the two
    // loads stay within a couple units — NOT inflated by ~1000s of integration.
    expect(Math.abs(gLoad - nLoad)).toBeLessThanOrEqual(2);
    expect(TRAINING_LOAD_DT_CLAMP_SEC).toBe(10);
  });

  it("sparse HR (<50% coverage) → avg-hr-fallback equal to computeTrainingLoadV2", () => {
    // hr only on every 3rd point → coverage ~0.333.
    const pts = buildStream(600, (i) => (i % 3 === 0 ? 152 : null));
    const res = computeStreamedTrainingLoad(pts, 600, 152, MAX_HR, RESTING_HR, "Running");
    expect(res.method).toBe("avg-hr-fallback");
    expect(res.hrCoverage).toBeLessThan(STREAMED_HR_COVERAGE_MIN);
    expect(res.load).toBe(
      computeTrainingLoadV2(600, 152, MAX_HR, RESTING_HR, "Running")
    );
  });

  it("carry-forward: intermittent null hr uses last valid hr → finite, non-null load", () => {
    // Even indices 152, odd null → coverage 0.5, nulls carry 152 forward.
    const pts = buildStream(600, (i) => (i % 2 === 0 ? 152 : null));
    const res = computeStreamedTrainingLoad(pts, 600, 152, MAX_HR, RESTING_HR, "Running");
    expect(res.method).toBe("streamed");
    expect(res.load).not.toBeNull();
    expect(Number.isFinite(res.load as number)).toBe(true);
    expect(res.load as number).toBeGreaterThan(0);
  });

  it("hrCoverage = 0.5 exactly engages streaming (boundary)", () => {
    // First 300 carry hr, last 300 null → coverage exactly 300/600 = 0.5.
    const pts = buildStream(600, (i) => (i < 300 ? 152 : null));
    const res = computeStreamedTrainingLoad(pts, 600, 152, MAX_HR, RESTING_HR, "Running");
    expect(res.hrCoverage).toBe(0.5);
    expect(res.method).toBe("streamed");
  });

  it("maxHr <= restingHr → load null even with a full stream", () => {
    const pts = buildStream(600, () => 152);
    const res = computeStreamedTrainingLoad(pts, 600, 152, 60, 60, "Running");
    expect(res.method).toBe("streamed");
    expect(res.load).toBeNull();
  });
});

describe("computeStreamedTrainingLoad — collapse guard (PRD §6 #24)", () => {
  it("exports STREAMED_LOAD_COLLAPSE_THRESHOLD === 5", () => {
    expect(STREAMED_LOAD_COLLAPSE_THRESHOLD).toBe(5);
  });

  it("degenerate stream (zero dt) + valid avgHR → avg-hr-fallback, score > 0", () => {
    // 600 dense, fully-covered samples but ALL at the same timestamp (dtSec=0) —
    // every step's dt ≤ 0, so the integral collapses to 0 despite coverage 1.0.
    const pts = buildStream(600, () => 150, 0);
    const res = computeStreamedTrainingLoad(pts, 1500, 150, MAX_HR, RESTING_HR, "Running");
    expect(res.method).toBe("avg-hr-fallback");
    expect(res.load).not.toBeNull();
    expect(res.load as number).toBeGreaterThan(0);
    // Falls back to the exact avg-HR Banister value.
    expect(res.load).toBe(
      computeTrainingLoadV2(1500, 150, MAX_HR, RESTING_HR, "Running")
    );
    expect(res.hrCoverage).toBe(1);
  });

  it("healthy GPS stream (≥ threshold) → unchanged 'streamed'", () => {
    const pts = buildStream(600, () => 152); // clean 1 Hz
    const res = computeStreamedTrainingLoad(pts, 600, 152, MAX_HR, RESTING_HR, "Running");
    expect(res.method).toBe("streamed");
    expect(res.load as number).toBeGreaterThanOrEqual(
      STREAMED_LOAD_COLLAPSE_THRESHOLD
    );
  });

  it("degenerate stream + NO valid avgHR → load 0, method 'none' (don't guess)", () => {
    const pts = buildStream(600, () => 150, 0); // collapses to 0
    const res = computeStreamedTrainingLoad(pts, 1500, null, MAX_HR, RESTING_HR, "Running");
    expect(res.method).toBe("none");
    expect(res.load).toBe(0);
  });

  it("degenerate stream + avgHR ≤ restingHr (not usable) → load 0, method 'none'", () => {
    const pts = buildStream(600, () => 150, 0);
    // avgHR 55 < restingHr 60 → not a usable reserve → no fallback, don't guess.
    const res = computeStreamedTrainingLoad(pts, 1500, 55, MAX_HR, RESTING_HR, "Running");
    expect(res.method).toBe("none");
    expect(res.load).toBe(0);
  });

  it("borderline easy run just above threshold → NOT triggered (stays 'streamed')", () => {
    // Clean 10-min stream at a low HR → a small but legitimate load ≥ threshold.
    const pts = buildStream(600, () => 110);
    const res = computeStreamedTrainingLoad(pts, 600, 110, MAX_HR, RESTING_HR, "Running");
    expect(res.method).toBe("streamed");
    expect(res.load as number).toBeGreaterThanOrEqual(
      STREAMED_LOAD_COLLAPSE_THRESHOLD
    );
    expect(res.load as number).toBeLessThan(40); // genuinely a low/easy effort
  });
});

describe("resolveDisplayLoad", () => {
  const MX = 164;
  const RST = 60;

  it("returns the stored trainingLoadV2 when present (stored wins over recompute)", () => {
    // Stored 999 deliberately differs from what a live recompute would produce.
    const w = {
      trainingLoadV2: 999,
      avgHeartRate: 152,
      durationSeconds: 1764,
      activityType: "Running",
    };
    expect(resolveDisplayLoad(w, MX, RST)).toBe(999);
    // Sanity: the live recompute is NOT 999.
    expect(computeTrainingLoadV2(1764, 152, MX, RST, "Running")).not.toBe(999);
  });

  it("falls back to live computeTrainingLoadV2 when the field is absent/undefined/null", () => {
    const live = computeTrainingLoadV2(1764, 152, MX, RST, "Running");
    const absent = {
      avgHeartRate: 152,
      durationSeconds: 1764,
      activityType: "Running",
    };
    const nullField = { ...absent, trainingLoadV2: null };
    const undefField = { ...absent, trainingLoadV2: undefined };
    expect(resolveDisplayLoad(absent, MX, RST)).toBe(live);
    expect(resolveDisplayLoad(nullField, MX, RST)).toBe(live);
    expect(resolveDisplayLoad(undefField, MX, RST)).toBe(live);
  });

  it("returns null (→ '—') when there is no stored value AND no avgHeartRate", () => {
    const w = { trainingLoadV2: null, avgHeartRate: null, durationSeconds: 1764 };
    expect(resolveDisplayLoad(w, MX, RST)).toBeNull();
  });

  it("weekly sum skips nulls and uses the resolved values (stored + fallback)", () => {
    const stored = {
      trainingLoadV2: 100,
      avgHeartRate: 150,
      durationSeconds: 1800,
      activityType: "Running",
    };
    const fallback = {
      avgHeartRate: 152,
      durationSeconds: 1764,
      activityType: "Running",
    };
    const missing = { avgHeartRate: null, durationSeconds: 1800 };
    const week = [stored, fallback, missing];

    const sum = week
      .map((w) => resolveDisplayLoad(w, MX, RST))
      .filter((v): v is number => v != null)
      .reduce((a, b) => a + b, 0);

    const expectedFallback = computeTrainingLoadV2(
      1764,
      152,
      MX,
      RST,
      "Running"
    ) as number;
    expect(sum).toBe(100 + expectedFallback);
  });
});

describe("buildLoadExplainer", () => {
  const base = {
    score: 100,
    avgHeartRate: 152,
    durationSeconds: 1764,
    maxHr: 164,
    restingHr: 60,
  };

  it("streamed → second-by-second method label, isStreamed true", () => {
    const e = buildLoadExplainer({ ...base, trainingLoadMethod: "streamed" });
    expect(e.show).toBe(true);
    expect(e.isStreamed).toBe(true);
    expect(e.isLiveEstimate).toBe(false);
    expect(e.methodLabel).toMatch(/second-by-second/i);
  });

  it("avg-hr-fallback → average-HR method label, not streamed/live", () => {
    const e = buildLoadExplainer({
      ...base,
      trainingLoadMethod: "avg-hr-fallback",
    });
    expect(e.isStreamed).toBe(false);
    expect(e.isLiveEstimate).toBe(false);
    expect(e.methodLabel).toMatch(/average heart rate/i);
  });

  it("no stored method → live estimate, average-HR label", () => {
    const e = buildLoadExplainer({ ...base });
    expect(e.isLiveEstimate).toBe(true);
    expect(e.methodLabel).toMatch(/average heart rate/i);
  });

  it("hrrPct = round((avgHR−rest)/(max−rest)×100)", () => {
    const e = buildLoadExplainer({ ...base }); // (152−60)/104 = 0.8846 → 88
    expect(e.hrrPct).toBe(88);
  });

  it("clamps HRR to 0–100% for out-of-range HR", () => {
    expect(buildLoadExplainer({ ...base, avgHeartRate: 200 }).hrrPct).toBe(100);
    expect(buildLoadExplainer({ ...base, avgHeartRate: 40 }).hrrPct).toBe(0);
  });

  it("suppresses the section when score is missing (no NaN)", () => {
    const e = buildLoadExplainer({ ...base, score: null });
    expect(e.show).toBe(false);
  });

  it("suppresses the section when duration is missing", () => {
    const e = buildLoadExplainer({ ...base, durationSeconds: null });
    expect(e.show).toBe(false);
  });

  it("hrrPct is null (not NaN) when HR anchors are unusable", () => {
    const noHr = buildLoadExplainer({ ...base, avgHeartRate: null });
    expect(noHr.hrrPct).toBeNull();
    const badReserve = buildLoadExplainer({ ...base, maxHr: 60, restingHr: 60 });
    expect(badReserve.hrrPct).toBeNull();
    // Section can still show (score + duration present) without a NaN %.
    expect(badReserve.show).toBe(true);
  });
});
