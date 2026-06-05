import { describe, expect, it } from "vitest";

import {
  computeTrainingLoadV2,
  computeStreamedTrainingLoad,
  resolveDisplayLoad,
  buildLoadExplainer,
  DEFAULT_RESTING_HR,
  resolveRestingHr,
  HIIT_LOAD_FACTOR,
  TRAINING_LOAD_DT_CLAMP_SEC,
  STREAMED_HR_COVERAGE_MIN,
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

  it("HIIT load = round(running load × 0.75)", () => {
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
    // Factor is applied inside the round, so round(raw×0.75) can differ from
    // round(roundedRunning×0.75) by 1 — assert within ±1 and strictly lower.
    expect(
      Math.abs((hiit as number) - (running as number) * HIIT_LOAD_FACTOR)
    ).toBeLessThanOrEqual(1);
    expect(hiit as number).toBeLessThan(running as number);
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
