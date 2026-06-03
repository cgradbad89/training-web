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
  it("fallback max HR is 185 (aligned with trainingLoad DEFAULT_MAX_HR)", () => {
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
  function timestamps(count: number, stepSeconds = 60): number[] {
    return Array.from({ length: count }, (_, i) => i * stepSeconds);
  }

  it("classifies threshold-pace samples into the requested interval band", () => {
    const zones = computePaceZones(
      [480, 480, 480, 480, 480, 480],
      timestamps(6),
      480
    );
    expect(zones).toHaveLength(5);
    expect(zones[3].label).toBe("Interval");
    expect(zones[3].secondsInZone).toBe(300);
    expect(zones[3].percent).toBeCloseTo(100, 5);
  });

  it("weights a fast run toward interval and repetition zones", () => {
    const zones = computePaceZones(
      [470, 470, 430, 430, 430, 430],
      timestamps(6),
      480
    );
    expect(zones[3].secondsInZone).toBe(120);
    expect(zones[4].secondsInZone).toBe(180);
    expect(zones[4].percent).toBeCloseTo(60, 5);
  });

  it("weights a slow recovery run toward recovery and easy zones", () => {
    const zones = computePaceZones(
      [650, 650, 580, 580, 580, 580],
      timestamps(6),
      480
    );
    expect(zones[0].secondsInZone).toBe(120);
    expect(zones[1].secondsInZone).toBe(180);
    expect(zones[0].label).toBe("Recovery");
    expect(zones[1].label).toBe("Easy");
  });

  it("excludes null, invalid, and spike pace points", () => {
    const zones = computePaceZones(
      [null, 0, 1901, 528, 480],
      timestamps(5),
      480
    );
    expect(zones[2].secondsInZone).toBe(60); // 528 / 480 = 1.10
    expect(zones.slice(0, 2).every((z) => z.secondsInZone === 0)).toBe(true);
    expect(zones[3].secondsInZone).toBe(0); // final point has no following segment
  });

  it("empty or invalid threshold input returns [] safely", () => {
    expect(computePaceZones([], [], 480)).toEqual([]);
    expect(computePaceZones([480, 480], [0, 60], 0)).toEqual([]);
    expect(computePaceZones([null, 0], [0, 60], 480)).toEqual([]);
  });

  it("percentages sum to 100 when valid samples exist", () => {
    const zones = computePaceZones(
      [650, 580, 528, 480, 430, 430],
      timestamps(6),
      480
    );
    const totalSeconds = zones.reduce((a, z) => a + z.secondsInZone, 0);
    expect(totalSeconds).toBe(300);
    const totalPct = zones.reduce((a, z) => a + z.percent, 0);
    expect(totalPct).toBeCloseTo(100, 5);
  });
});
