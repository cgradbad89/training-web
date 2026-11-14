import { describe, it, expect } from "vitest";
import {
  computeHRZones,
  computePaceZones,
  hrZoneCutsBpm,
  hrZoneIndex,
  formatHrZoneBpmLabel,
  hrZoneRangesBpm,
  HR_ZONE_BOUNDS,
  HR_ZONE_MODEL_VERSION,
  maxHRForAge,
  FALLBACK_MAX_HR,
  paceZoneRanges,
  type HrZoneAnchors,
} from "../zones";
import {
  resolveMaxHr,
  resolveRestingHr,
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

// Reference anchors from the product owner: max 180, resting 65 → reserve 115.
const A: HrZoneAnchors = { maxHr: 180, restingHr: 65 };

describe("HR_ZONE_MODEL_VERSION / HR_ZONE_BOUNDS", () => {
  it("model version is 2 (% of HR reserve)", () => {
    expect(HR_ZONE_MODEL_VERSION).toBe(2);
  });
  it("HR_ZONE_BOUNDS is the single source of the 50/60/70/80/90/100 fractions", () => {
    expect([...HR_ZONE_BOUNDS]).toEqual([0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
  });
});

describe("hrZoneCutsBpm", () => {
  it("at 180/65 the Z2..Z5 cuts are exactly 134, 145.5, 157, 168.5", () => {
    expect([...hrZoneCutsBpm(A)]).toEqual([134, 145.5, 157, 168.5]);
  });

  it("changing only restingHr changes the cuts", () => {
    const base = hrZoneCutsBpm({ maxHr: 180, restingHr: 65 });
    const other = hrZoneCutsBpm({ maxHr: 180, restingHr: 60 });
    expect([...other]).toEqual([132, 144, 156, 168]);
    expect([...other]).not.toEqual([...base]);
  });

  it("changing only maxHr changes the cuts", () => {
    expect([...hrZoneCutsBpm({ maxHr: 190, restingHr: 65 })]).toEqual([
      140, 152.5, 165, 177.5,
    ]);
  });

  it("resting equal to max falls back to 185/60 (cuts 135, 147.5, 160, 172.5)", () => {
    const fallback = [135, 147.5, 160, 172.5];
    expect([...hrZoneCutsBpm({ maxHr: 150, restingHr: 150 })]).toEqual(fallback);
  });

  it("resting above max falls back to 185/60", () => {
    expect([...hrZoneCutsBpm({ maxHr: 150, restingHr: 170 })]).toEqual([
      135, 147.5, 160, 172.5,
    ]);
  });

  it("non-finite anchors fall back and never return NaN or throw", () => {
    for (const anchors of [
      { maxHr: NaN, restingHr: 60 },
      { maxHr: 180, restingHr: NaN },
      { maxHr: Infinity, restingHr: 60 },
    ]) {
      const cuts = hrZoneCutsBpm(anchors);
      expect([...cuts]).toEqual([135, 147.5, 160, 172.5]);
      expect(cuts.every(Number.isFinite)).toBe(true);
    }
  });
});

describe("hrZoneIndex (% of HR reserve)", () => {
  it("156 bpm average at 180/65 is Z3 (79.1% of reserve)", () => {
    expect(hrZoneIndex(156, A)).toBe(3);
  });

  it("157 bpm is Z4", () => {
    expect(hrZoneIndex(157, A)).toBe(4);
  });

  it("a bpm exactly on a cut belongs to the higher zone", () => {
    expect(hrZoneIndex(134, A)).toBe(2);
    expect(hrZoneIndex(145.5, A)).toBe(3);
    expect(hrZoneIndex(157, A)).toBe(4);
    expect(hrZoneIndex(168.5, A)).toBe(5);
  });

  it("one step below each cut stays in the lower zone", () => {
    expect(hrZoneIndex(133, A)).toBe(1);
    expect(hrZoneIndex(145, A)).toBe(2);
    expect(hrZoneIndex(156.9, A)).toBe(3);
    expect(hrZoneIndex(168, A)).toBe(4);
  });

  it("168.5 is Z5", () => {
    expect(hrZoneIndex(168.5, A)).toBe(5);
  });

  it("below the Z2 cut (including below the 50% floor of 122.5) is Z1", () => {
    expect(hrZoneIndex(133.9, A)).toBe(1);
    expect(hrZoneIndex(122, A)).toBe(1);
    expect(hrZoneIndex(60, A)).toBe(1);
    expect(hrZoneIndex(40, A)).toBe(1);
  });

  it("above max HR is Z5", () => {
    expect(hrZoneIndex(181, A)).toBe(5);
    expect(hrZoneIndex(220, A)).toBe(5);
  });

  it("the same bpm lands in a different zone when only restingHr changes", () => {
    // 134 bpm: Z2 at resting 65 (cut 134), Z3 at resting 60 (Z3 cut 144 → no; Z2 cut 132)
    expect(hrZoneIndex(133, { maxHr: 180, restingHr: 65 })).toBe(1);
    expect(hrZoneIndex(133, { maxHr: 180, restingHr: 60 })).toBe(2);
  });

  it("the same bpm lands in a different zone than the legacy %-of-max model", () => {
    // 156 bpm = 86.7% of max 180 (legacy Z4) but 79.1% of reserve (Z3).
    expect(156 / 180).toBeGreaterThan(0.8);
    expect(hrZoneIndex(156, A)).toBe(3);
  });
});

describe("hrZoneRangesBpm", () => {
  it("returns 5 zones with open outer edges", () => {
    const r = hrZoneRangesBpm(A);
    expect(r.map((x) => x.zone)).toEqual([1, 2, 3, 4, 5]);
    expect(r[0].lowBpm).toBeNull();
    expect(r[4].highBpm).toBeNull();
  });

  it("adjacent ranges share their cut and match hrZoneCutsBpm", () => {
    const r = hrZoneRangesBpm(A);
    expect(r.map((x) => [x.lowBpm, x.highBpm])).toEqual([
      [null, 134],
      [134, 145.5],
      [145.5, 157],
      [157, 168.5],
      [168.5, null],
    ]);
  });

  it("invalid anchors fall back to 185/60", () => {
    const r = hrZoneRangesBpm({ maxHr: 60, restingHr: 60 });
    expect(r[1].lowBpm).toBe(135);
    expect(r[4].lowBpm).toBe(172.5);
  });
});

describe("formatHrZoneBpmLabel", () => {
  it("renders whole-bpm labels at 180/65 matching how bpm are classified", () => {
    const labels = hrZoneRangesBpm(A).map(formatHrZoneBpmLabel);
    // Cuts 134 / 145.5 / 157 / 168.5; a bpm on a cut is the higher zone.
    expect(labels).toEqual(["< 134", "134–145", "146–156", "157–168", "169+"]);
  });

  it("every whole bpm in a label classifies into that label's zone", () => {
    const ranges = hrZoneRangesBpm(A);
    expect(hrZoneIndex(145, A)).toBe(2);
    expect(hrZoneIndex(146, A)).toBe(3);
    expect(hrZoneIndex(156, A)).toBe(3);
    expect(hrZoneIndex(168, A)).toBe(4);
    expect(hrZoneIndex(169, A)).toBe(5);
    expect(ranges).toHaveLength(5);
  });

  it("returns an em dash for a span with both edges open", () => {
    expect(formatHrZoneBpmLabel({ zone: 3, lowBpm: null, highBpm: null })).toBe("—");
  });
});

describe("computeHRZones", () => {
  it("accumulates time-in-zone and percentages sum to 100", () => {
    const zones = computeHRZones(
      [
        { bpm: 110, seconds: 60 }, // Z1
        { bpm: 150, seconds: 120 }, // Z3
        { bpm: 175, seconds: 60 }, // Z5
        { bpm: 999, seconds: 30 }, // invalid, ignored
      ],
      A
    );
    expect(zones).toHaveLength(5);
    expect(zones[0].seconds).toBe(60);
    expect(zones[2].seconds).toBe(120);
    expect(zones[4].seconds).toBe(60);
    const totalPct = zones.reduce((a, z) => a + z.pct, 0);
    expect(totalPct).toBeCloseTo(100, 5);
  });

  it("keeps the ZoneBucket shape and labels", () => {
    const zones = computeHRZones([{ bpm: 150, seconds: 10 }], A);
    expect(zones.map((z) => z.label)).toEqual([
      "Z1 50–60%",
      "Z2 60–70%",
      "Z3 70–80%",
      "Z4 80–90%",
      "Z5 90–100%",
    ]);
    expect(zones.map((z) => z.zone)).toEqual([1, 2, 3, 4, 5]);
  });

  it("a 156 bpm steady run is 100% Z3 at 180/65", () => {
    const zones = computeHRZones([{ bpm: 156, seconds: 600 }], A);
    expect(zones[2].pct).toBeCloseTo(100, 5);
  });

  it("samples below 40 or above 220 bpm are still skipped", () => {
    const zones = computeHRZones(
      [
        { bpm: 39, seconds: 100 },
        { bpm: 221, seconds: 100 },
        { bpm: 140, seconds: 50 }, // Z2
      ],
      A
    );
    expect(zones[1].seconds).toBe(50);
    expect(zones.reduce((a, z) => a + z.seconds, 0)).toBe(50);
  });

  it("skips non-finite bpm and non-positive / non-finite seconds", () => {
    const zones = computeHRZones(
      [
        { bpm: NaN, seconds: 10 },
        { bpm: 150, seconds: 0 },
        { bpm: 150, seconds: -5 },
        { bpm: 150, seconds: NaN },
        { bpm: 150, seconds: 30 },
      ],
      A
    );
    expect(zones[2].seconds).toBe(30);
  });

  it("empty / zero-valid-sample input → []", () => {
    expect(computeHRZones([], A)).toEqual([]);
    expect(computeHRZones([{ bpm: 10, seconds: 30 }], A)).toEqual([]);
  });

  it("uses the fallback anchors when resting >= max (no NaN, still buckets)", () => {
    const zones = computeHRZones([{ bpm: 150, seconds: 60 }], {
      maxHr: 100,
      restingHr: 120,
    });
    // fallback 185/60: Z3 cut 147.5, Z4 cut 160 → 150 is Z3
    expect(zones[2].seconds).toBe(60);
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
describe("zone boundaries from settings-provided HR anchors", () => {
  it("hrZoneIndex cuts scale with the settings max and resting HR (172/60)", () => {
    const anchors = {
      maxHr: resolveMaxHr({ maxHeartRate: 172 } as UserSettings),
      restingHr: resolveRestingHr({ restingHeartRate: 60 } as UserSettings),
    };
    expect(anchors).toEqual({ maxHr: 172, restingHr: 60 });
    // Reserve 112: cuts at 60 + 0.6/0.7/0.8/0.9 × 112 = 127.2 / 138.4 / 149.6 / 160.8.
    expect(hrZoneIndex(127, anchors)).toBe(1);
    expect(hrZoneIndex(128, anchors)).toBe(2);
    expect(hrZoneIndex(138, anchors)).toBe(2);
    expect(hrZoneIndex(139, anchors)).toBe(3);
    expect(hrZoneIndex(149, anchors)).toBe(3);
    expect(hrZoneIndex(150, anchors)).toBe(4);
    expect(hrZoneIndex(160, anchors)).toBe(4);
    expect(hrZoneIndex(161, anchors)).toBe(5);
  });

  it("the same bpm lands in a different zone under the 185/60 defaults — settings value matters", () => {
    const settings = { maxHr: 172, restingHr: 60 };
    const defaults = {
      maxHr: resolveMaxHr(undefined),
      restingHr: resolveRestingHr(undefined),
    };
    expect(defaults).toEqual({ maxHr: 185, restingHr: 60 });
    // 150 bpm: 80.4% of the 172/60 reserve → Z4, but 72.0% of the 185/60 reserve → Z3.
    expect(hrZoneIndex(150, settings)).toBe(4);
    expect(hrZoneIndex(150, defaults)).toBe(3);
  });

  it("computeHRZones buckets time using the settings anchors", () => {
    const anchors = { maxHr: 172, restingHr: 60 };
    const zones = computeHRZones(
      [
        { bpm: 100, seconds: 60 }, // Z1
        { bpm: 145, seconds: 60 }, // Z3
        { bpm: 165, seconds: 60 }, // Z5
      ],
      anchors
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
