import { describe, it, expect } from "vitest";
import {
  computeOverlayChartCache,
  evenSampleIndices,
  parseOverlayChartCache,
  OVERLAY_CACHE_TARGET_POINTS,
} from "@/utils/overlayChartCache";
import { type RoutePoint } from "@/services/routes";

const BASE_MS = Date.parse("2026-06-01T12:00:00Z");

/** n points, 1s apart, heading north at ~3 m/s, gentle altitude ramp. */
function makePoints(
  n: number,
  overrides: (i: number) => Partial<RoutePoint> = () => ({})
): RoutePoint[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    lat: 40 + i * 0.000027, // ~3 m per second of latitude
    lng: -74,
    altitude: 10 + i * 0.05,
    timestamp: new Date(BASE_MS + i * 1000).toISOString(),
    speed: 3,
    hr: 150,
    ...overrides(i),
  }));
}

describe("evenSampleIndices", () => {
  it("keeps every index when n <= target", () => {
    expect(evenSampleIndices(5, 10)).toEqual([0, 1, 2, 3, 4]);
    expect(evenSampleIndices(10, 10)).toEqual([...Array(10).keys()]);
  });

  it("samples down to exactly target, always keeping first and last", () => {
    const idx = evenSampleIndices(1000, 200);
    expect(idx).toHaveLength(200);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(999);
  });

  it("spaces samples evenly across the whole range (never truncation)", () => {
    const idx = evenSampleIndices(1000, 200);
    const gaps = idx.slice(1).map((v, i) => v - idx[i]);
    const expected = 999 / 199;
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(Math.floor(expected));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(Math.ceil(expected));
  });
});

describe("computeOverlayChartCache", () => {
  it("returns null for runs too short to chart", () => {
    expect(computeOverlayChartCache([])).toBeNull();
    expect(computeOverlayChartCache(makePoints(1))).toBeNull();
  });

  it("decimates a dense route to the target point count", () => {
    const cache = computeOverlayChartCache(makePoints(2400));
    expect(cache).not.toBeNull();
    expect(cache!.distancesMiles).toHaveLength(OVERLAY_CACHE_TARGET_POINTS);
    expect(cache!.paceSecPerMile).toHaveLength(OVERLAY_CACHE_TARGET_POINTS);
    expect(cache!.heartRateBpm).toHaveLength(OVERLAY_CACHE_TARGET_POINTS);
    expect(cache!.elevationFt).toHaveLength(OVERLAY_CACHE_TARGET_POINTS);
    expect(cache!.sourcePointCount).toBe(2400);
    // Distances cover the run start-to-finish.
    expect(cache!.distancesMiles[0]).toBe(0);
    const last = cache!.distancesMiles[cache!.distancesMiles.length - 1];
    expect(last).toBeGreaterThan(4); // ~2400s at 3 m/s ≈ 4.5 mi
  });

  it("keeps every point for short routes (no upsampling)", () => {
    const cache = computeOverlayChartCache(makePoints(50));
    expect(cache!.distancesMiles).toHaveLength(50);
    expect(cache!.sourcePointCount).toBe(50);
  });

  it("nulls out-of-range HR and missing speed instead of fabricating values", () => {
    const cache = computeOverlayChartCache(
      makePoints(50, (i) => ({
        hr: i % 2 === 0 ? 300 : null, // all invalid/absent
        speed: null,
      }))
    );
    expect(cache!.heartRateBpm.every((v) => v === null)).toBe(true);
    expect(cache!.paceSecPerMile.every((v) => v === null)).toBe(true);
  });

  it("records the computedAt clock it was given", () => {
    const cache = computeOverlayChartCache(makePoints(10), 200, 1234567);
    expect(cache!.computedAt).toBe(1234567);
  });
});

describe("parseOverlayChartCache", () => {
  it("round-trips a computed cache through JSON (the merge-write path)", () => {
    const cache = computeOverlayChartCache(makePoints(300))!;
    const parsed = parseOverlayChartCache(JSON.parse(JSON.stringify(cache)));
    expect(parsed).toEqual(cache);
  });

  it("rejects malformed values", () => {
    expect(parseOverlayChartCache(undefined)).toBeUndefined();
    expect(parseOverlayChartCache("nope")).toBeUndefined();
    expect(parseOverlayChartCache({})).toBeUndefined();
    const cache = computeOverlayChartCache(makePoints(300))!;
    expect(
      parseOverlayChartCache({
        ...cache,
        heartRateBpm: cache.heartRateBpm.slice(1), // length mismatch
      })
    ).toBeUndefined();
    expect(
      parseOverlayChartCache({ ...cache, computedAt: "yesterday" })
    ).toBeUndefined();
  });
});
