import { describe, it, expect } from "vitest";
import { type RoutePoint } from "@/services/routes";
import { computeHRZones, computePaceZones } from "@/utils/zones";
import { mpsToSecPerMile } from "@/utils/pace";
import {
  computeHrZonesFromPoints,
  computePaceZonesFromPoints,
  computeZoneBreakdown,
  parseZoneBreakdown,
} from "@/utils/zoneBreakdown";

const MAX_HR = 190;
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
    const expected = computeHRZones(hrSamples, MAX_HR);
    expect(computeHrZonesFromPoints(points, MAX_HR)).toEqual(expected);
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
    const zb = computeZoneBreakdown(points, MAX_HR, THRESHOLD, 999);
    expect(zb.maxHr).toBe(MAX_HR);
    expect(zb.thresholdPaceSecPerMile).toBe(THRESHOLD);
    expect(zb.computedAt).toBe(999);
    expect(zb.hrZones).toEqual(computeHrZonesFromPoints(points, MAX_HR));
    expect(zb.paceZones).toEqual(computePaceZonesFromPoints(points, THRESHOLD));
  });
});

describe("parseZoneBreakdown", () => {
  it("round-trips a computed breakdown", () => {
    const zb = computeZoneBreakdown(makePoints(20), MAX_HR, THRESHOLD, 5);
    expect(parseZoneBreakdown(JSON.parse(JSON.stringify(zb)))).toEqual(zb);
  });

  it("accepts a null threshold basis", () => {
    const zb = computeZoneBreakdown(makePoints(20), MAX_HR, null, 5);
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
