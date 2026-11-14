import { describe, it, expect } from "vitest";
import { type RoutePoint } from "@/services/routes";
import {
  computeHRZones,
  computePaceZones,
  HR_ZONE_MODEL_VERSION,
  type HrZoneAnchors,
} from "@/utils/zones";
import { mpsToSecPerMile } from "@/utils/pace";
import {
  computeHrZonesFromPoints,
  computePaceZonesFromPoints,
  computeZoneBreakdown,
  parseZoneBreakdown,
  zoneBreakdownMatchesHrModel,
} from "@/utils/zoneBreakdown";

const MAX_HR = 190;
const RESTING_HR = 62;
const ANCHORS: HrZoneAnchors = { maxHr: MAX_HR, restingHr: RESTING_HR };
const THRESHOLD = 480; // sec/mi

/** Build a route where each point is 1 s apart, with varied HR + speed. */
function makePoints(n: number): RoutePoint[] {
  const base = Date.parse("2026-07-17T12:00:00.000Z");
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    lat: 40 + i * 0.0001,
    lng: -105,
    altitude: 1600,
    timestamp: new Date(base + i * 1000).toISOString(),
    speed: 3 + (i % 5) * 0.3, // m/s, varies across pace zones
    hr: 120 + (i % 7) * 10, // 120..180 bpm, varies across HR zones
  }));
}

describe("zone breakdown extraction (regression vs. the old inline logic)", () => {
  const points = makePoints(40);

  it("computeHrZonesFromPoints reproduces the component's inline HR bucketing", () => {
    // The exact inline the ZoneBreakdown component used before extraction.
    const hrSamples: { bpm: number; seconds: number }[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const t0 = new Date(points[i].timestamp).getTime();
      const t1 = new Date(points[i + 1].timestamp).getTime();
      const dt = (t1 - t0) / 1000;
      if (!isFinite(dt) || dt <= 0) continue;
      if (points[i].hr != null) {
        hrSamples.push({ bpm: points[i].hr as number, seconds: dt });
      }
    }
    const expected = computeHRZones(hrSamples, ANCHORS);
    expect(computeHrZonesFromPoints(points, ANCHORS)).toEqual(expected);
  });

  it("computePaceZonesFromPoints reproduces the component's inline pace bucketing", () => {
    const perPointPaceSecPerMile = points.map((p) =>
      p.speed != null ? mpsToSecPerMile(p.speed) : null
    );
    const perPointTimestampsSec = points.map(
      (p) => new Date(p.timestamp).getTime() / 1000
    );
    const expected = computePaceZones(
      perPointPaceSecPerMile,
      perPointTimestampsSec,
      THRESHOLD
    );
    expect(computePaceZonesFromPoints(points, THRESHOLD)).toEqual(expected);
  });

  it("returns empty pace zones without a usable threshold", () => {
    expect(computePaceZonesFromPoints(points, null)).toEqual([]);
    expect(computePaceZonesFromPoints(points, 0)).toEqual([]);
  });

  it("computeZoneBreakdown tags the basis and bundles both zone sets", () => {
    const zb = computeZoneBreakdown(points, ANCHORS, THRESHOLD, 999);
    expect(zb.maxHr).toBe(MAX_HR);
    expect(zb.restingHr).toBe(RESTING_HR);
    expect(zb.hrZoneModelVersion).toBe(HR_ZONE_MODEL_VERSION);
    expect(zb.thresholdPaceSecPerMile).toBe(THRESHOLD);
    expect(zb.computedAt).toBe(999);
    expect(zb.hrZones).toEqual(computeHrZonesFromPoints(points, ANCHORS));
    expect(zb.paceZones).toEqual(computePaceZonesFromPoints(points, THRESHOLD));
  });
});

describe("parseZoneBreakdown", () => {
  it("round-trips a computed breakdown", () => {
    const zb = computeZoneBreakdown(makePoints(20), ANCHORS, THRESHOLD, 5);
    expect(parseZoneBreakdown(JSON.parse(JSON.stringify(zb)))).toEqual(zb);
  });

  it("accepts a null threshold basis", () => {
    const zb = computeZoneBreakdown(makePoints(20), ANCHORS, null, 5);
    const parsed = parseZoneBreakdown(JSON.parse(JSON.stringify(zb)));
    expect(parsed?.thresholdPaceSecPerMile).toBeNull();
  });

  it("rejects malformed values", () => {
    expect(parseZoneBreakdown(null)).toBeUndefined();
    expect(parseZoneBreakdown({ hrZones: [], paceZones: [] })).toBeUndefined();
    expect(
      parseZoneBreakdown({
        hrZones: [],
        paceZones: [],
        maxHr: 190,
        computedAt: 1,
      })
    ).toBeUndefined(); // missing thresholdPaceSecPerMile
  });
});

describe("computeHrZonesFromPoints — reserve model", () => {
  const A: HrZoneAnchors = { maxHr: 180, restingHr: 65 };
  function steady(bpm: number, n = 30): RoutePoint[] {
    return makePoints(n).map((p) => ({ ...p, hr: bpm }));
  }

  it("a steady 156 bpm run at 180/65 is all Z3 (time-weighted)", () => {
    const zones = computeHrZonesFromPoints(steady(156), A);
    expect(zones[2].pct).toBeCloseTo(100, 5);
  });

  it("keeps the existing skips: null hr, non-positive dt, bpm outside 40–220", () => {
    const base = makePoints(6);
    const points: RoutePoint[] = [
      { ...base[0], hr: null }, // null hr → skipped
      { ...base[1], hr: 156 }, // 1 s → Z3
      { ...base[2], hr: 30 }, // below 40 → skipped
      { ...base[3], hr: 250 }, // above 220 → skipped
      { ...base[4], hr: 156, timestamp: base[3].timestamp }, // dt<=0 from prev; this sample's dt to next is positive
      { ...base[5], hr: 140 },
    ];
    const zones = computeHrZonesFromPoints(points, A);
    const total = zones.reduce((a, z) => a + z.seconds, 0);
    expect(total).toBeGreaterThan(0);
    expect(zones[2].seconds).toBeGreaterThan(0);
  });

  it("returns [] when no point carries a usable hr", () => {
    expect(
      computeHrZonesFromPoints(
        makePoints(10).map((p) => ({ ...p, hr: null })),
        A
      )
    ).toEqual([]);
  });
});

describe("zoneBreakdownMatchesHrModel", () => {
  const A: HrZoneAnchors = { maxHr: 180, restingHr: 65 };
  const fresh = () => computeZoneBreakdown(makePoints(20), A, THRESHOLD, 1);

  it("is true for a cache computed under the current model and anchors", () => {
    expect(zoneBreakdownMatchesHrModel(fresh(), A)).toBe(true);
  });

  it("is false for null / undefined", () => {
    expect(zoneBreakdownMatchesHrModel(null, A)).toBe(false);
    expect(zoneBreakdownMatchesHrModel(undefined, A)).toBe(false);
  });

  it("is false when maxHr changed", () => {
    expect(zoneBreakdownMatchesHrModel(fresh(), { ...A, maxHr: 185 })).toBe(false);
  });

  it("is false when only restingHr changed", () => {
    expect(zoneBreakdownMatchesHrModel(fresh(), { ...A, restingHr: 60 })).toBe(false);
  });

  it("is false for a legacy model version even if max and resting match", () => {
    expect(
      zoneBreakdownMatchesHrModel({ ...fresh(), hrZoneModelVersion: 1 }, A)
    ).toBe(false);
  });
});

describe("parseZoneBreakdown — legacy docs", () => {
  const legacyDoc = {
    hrZones: [{ zone: 3, label: "Z3 70–80%", seconds: 100, pct: 100 }],
    paceZones: [],
    maxHr: 180,
    thresholdPaceSecPerMile: 600,
    computedAt: 5,
  };

  it("parses a doc without hrZoneModelVersion/restingHr as stale instead of throwing", () => {
    const parsed = parseZoneBreakdown(legacyDoc);
    expect(parsed).toBeDefined();
    expect(parsed!.hrZoneModelVersion).toBe(1);
    expect(Number.isFinite(parsed!.restingHr)).toBe(true);
    expect(
      zoneBreakdownMatchesHrModel(parsed, { maxHr: 180, restingHr: 65 })
    ).toBe(false);
    // Even if resting happened to equal the sentinel, the legacy version still fails.
    expect(
      zoneBreakdownMatchesHrModel(parsed, { maxHr: 180, restingHr: 0 })
    ).toBe(false);
  });

  it("treats a half-stamped doc (only one new field) as legacy", () => {
    const onlyVersion = parseZoneBreakdown({ ...legacyDoc, hrZoneModelVersion: 2 });
    const onlyResting = parseZoneBreakdown({ ...legacyDoc, restingHr: 65 });
    for (const parsed of [onlyVersion, onlyResting]) {
      expect(parsed!.hrZoneModelVersion).toBe(1);
      expect(zoneBreakdownMatchesHrModel(parsed, { maxHr: 180, restingHr: 65 })).toBe(false);
    }
  });

  it("round-trips a current doc as fresh", () => {
    const A: HrZoneAnchors = { maxHr: 180, restingHr: 65 };
    const zb = computeZoneBreakdown(makePoints(20), A, THRESHOLD, 7);
    const parsed = parseZoneBreakdown(JSON.parse(JSON.stringify(zb)));
    expect(parsed).toEqual(zb);
    expect(zoneBreakdownMatchesHrModel(parsed, A)).toBe(true);
  });
});
