import { describe, it, expect } from "vitest";
import {
  computeHRZones,
  computePaceZones,
  hrZoneIndex,
  maxHRForAge,
  FALLBACK_MAX_HR,
} from "../zones";

describe("maxHRForAge", () => {
  it("uses 220 − age when age is known", () => {
    expect(maxHRForAge(40)).toBe(180);
  });
  it("falls back to FALLBACK_MAX_HR when age is null", () => {
    expect(maxHRForAge(null)).toBe(FALLBACK_MAX_HR);
  });
  it("fallback max HR is 185 (aligned with trainingLoad MAX_HR)", () => {
    expect(FALLBACK_MAX_HR).toBe(185);
    expect(maxHRForAge(null)).toBe(185);
  });
});

describe("hrZoneIndex", () => {
  it("buckets by % of max HR", () => {
    const max = 200;
    expect(hrZoneIndex(110, max)).toBe(1); // 55%
    expect(hrZoneIndex(130, max)).toBe(2); // 65%
    expect(hrZoneIndex(150, max)).toBe(3); // 75%
    expect(hrZoneIndex(170, max)).toBe(4); // 85%
    expect(hrZoneIndex(190, max)).toBe(5); // 95%
  });
});

describe("computeHRZones", () => {
  it("accumulates time-in-zone and percentages sum to 100", () => {
    const maxHR = 200;
    const zones = computeHRZones(
      [
        { bpm: 110, seconds: 60 }, // Z1
        { bpm: 150, seconds: 120 }, // Z3
        { bpm: 190, seconds: 60 }, // Z5
        { bpm: 999, seconds: 30 }, // invalid, ignored
      ],
      maxHR
    );
    expect(zones).toHaveLength(5);
    expect(zones[0].seconds).toBe(60);
    expect(zones[2].seconds).toBe(120);
    expect(zones[4].seconds).toBe(60);
    const totalPct = zones.reduce((a, z) => a + z.pct, 0);
    expect(totalPct).toBeCloseTo(100, 5);
  });

  it("empty / no-valid input → []", () => {
    expect(computeHRZones([], 190)).toEqual([]);
    expect(computeHRZones([{ bpm: 10, seconds: 30 }], 190)).toEqual([]);
  });
});

describe("computePaceZones", () => {
  it("splits the run's GAP distribution into 5 run-relative buckets", () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      gapSecPerMile: 480 + i * 10, // 480..570, spread across quintiles
      seconds: 30,
    }));
    const zones = computePaceZones(samples);
    expect(zones).toHaveLength(5);
    const totalSeconds = zones.reduce((a, z) => a + z.seconds, 0);
    expect(totalSeconds).toBe(300); // 10 × 30s
    const totalPct = zones.reduce((a, z) => a + z.pct, 0);
    expect(totalPct).toBeCloseTo(100, 5);
  });

  it("empty / no-valid input → []", () => {
    expect(computePaceZones([])).toEqual([]);
    expect(computePaceZones([{ gapSecPerMile: 0, seconds: 0 }])).toEqual([]);
  });
});
