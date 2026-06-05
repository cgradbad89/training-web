import { describe, expect, it } from "vitest";

import {
  computeTrainingLoadV2,
  DEFAULT_RESTING_HR,
  resolveRestingHr,
  HIIT_LOAD_FACTOR,
} from "@/utils/trainingLoad";
import { type UserSettings } from "@/types/userSettings";

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
