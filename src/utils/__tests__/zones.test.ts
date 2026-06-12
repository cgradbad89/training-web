import { describe, it, expect } from "vitest";
import {
  computeHRZones,
  computePaceZones,
  hrZoneIndex,
  maxHRForAge,
  FALLBACK_MAX_HR,
  paceZoneRanges,
} from "../zones";
import {
  resolveMaxHr,
  zoneBoundsBpmForActivity,
  WORKOUT_ZONES,
} from "../trainingLoad";
import { type UserSettings } from "@/types/userSettings";

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

  it("classifies exact-threshold samples into the threshold band", () => {
    const zones = computePaceZones(
      [480, 480, 480, 480, 480, 480],
      timestamps(6),
      480
    );
    expect(zones).toHaveLength(5);
    expect(zones[2].label).toBe("Threshold");
    expect(zones[2].secondsInZone).toBe(300);
    expect(zones[2].percent).toBeCloseTo(100, 5);
  });

  it("weights a fast run toward interval and repetition zones", () => {
    const zones = computePaceZones(
      [460, 460, 430, 430, 430, 430],
      timestamps(6),
      480
    );
    expect(zones[3].secondsInZone).toBe(120);
    expect(zones[4].secondsInZone).toBe(180);
    expect(zones[4].percent).toBeCloseTo(60, 5);
  });

  it("weights a slow recovery run toward recovery and easy zones", () => {
    const zones = computePaceZones(
      [650, 650, 550, 550, 550, 550],
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
    expect(zones[1].secondsInZone).toBe(60); // 528 / 480 = 1.10
    expect(zones[0].secondsInZone).toBe(0);
    expect(zones[2].secondsInZone).toBe(0); // final point has no following segment
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

describe("paceZoneRanges", () => {
  it("computes threshold-derived pace edges and open-ended zones", () => {
    const ranges = paceZoneRanges(600);
    expect(ranges).toHaveLength(5);

    expect(ranges[0]).toMatchObject({
      zone: 1,
      label: "Recovery",
      minPaceSecPerMile: 720,
      maxPaceSecPerMile: null,
    });
    expect(ranges[2]).toMatchObject({
      zone: 3,
      label: "Threshold",
      minPaceSecPerMile: 582,
      maxPaceSecPerMile: 660,
    });
    expect(ranges[4]).toMatchObject({
      zone: 5,
      label: "Repetition",
      minPaceSecPerMile: null,
      maxPaceSecPerMile: 540,
    });
  });
});

// ─── Settings-provided max HR drives zone boundaries ─────────────────────────
// The max HR set at /settings (users/{uid}/settings/prefs.maxHeartRate) is the
// single source of truth for client-side HR-zone math: every consumer resolves
// it via resolveMaxHr(settings) and passes it down — no hardcoded constants.
describe("zone boundaries from a settings-provided max HR", () => {
  it("hrZoneIndex boundaries scale with the settings max HR (172 bpm)", () => {
    const maxHr = resolveMaxHr({ maxHeartRate: 172 } as UserSettings);
    expect(maxHr).toBe(172);
    // Bands at 60/70/80/90% of 172 = 103.2 / 120.4 / 137.6 / 154.8 bpm.
    expect(hrZoneIndex(103, maxHr)).toBe(1);
    expect(hrZoneIndex(104, maxHr)).toBe(2);
    expect(hrZoneIndex(120, maxHr)).toBe(2);
    expect(hrZoneIndex(121, maxHr)).toBe(3);
    expect(hrZoneIndex(137, maxHr)).toBe(3);
    expect(hrZoneIndex(138, maxHr)).toBe(4);
    expect(hrZoneIndex(154, maxHr)).toBe(4);
    expect(hrZoneIndex(155, maxHr)).toBe(5);
  });

  it("the same bpm lands in a different zone under the 185 default — settings value matters", () => {
    const settingsMax = resolveMaxHr({ maxHeartRate: 172 } as UserSettings);
    const defaultMax = resolveMaxHr(undefined);
    expect(defaultMax).toBe(185);
    // 160 bpm: 93% of 172 → Z5, but only 86% of 185 → Z4.
    expect(hrZoneIndex(160, settingsMax)).toBe(5);
    expect(hrZoneIndex(160, defaultMax)).toBe(4);
  });

  it("computeHRZones buckets time using the settings max HR", () => {
    const maxHr = resolveMaxHr({ maxHeartRate: 172 } as UserSettings);
    const zones = computeHRZones(
      [
        { bpm: 100, seconds: 60 }, // 58% → Z1
        { bpm: 130, seconds: 60 }, // 76% → Z3
        { bpm: 160, seconds: 60 }, // 93% → Z5
      ],
      maxHr
    );
    const byZone = Object.fromEntries(zones.map((z) => [z.zone, z.seconds]));
    expect(byZone[1]).toBe(60);
    expect(byZone[3]).toBe(60);
    expect(byZone[5]).toBe(60);
  });

  it("zoneBoundsBpmForActivity floors each band at the settings max HR", () => {
    const maxHr = resolveMaxHr({ maxHeartRate: 172 } as UserSettings);
    const z2 = WORKOUT_ZONES.running.find((z) => z.zone === 2)!;
    // Z2 starts at 60% of max HR → ceil(0.6 × 172) = 104 bpm.
    expect(zoneBoundsBpmForActivity(z2, "running", maxHr).min).toBe(104);
  });
});
