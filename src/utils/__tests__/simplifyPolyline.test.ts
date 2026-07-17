import { describe, it, expect } from "vitest";
import {
  simplifyPolyline,
  parseSimplifiedPath,
} from "@/utils/simplifyPolyline";

// ~1 m of latitude ≈ 1/111320 deg; use that to build metre-scale fixtures.
const M = 1 / 111_320;

describe("simplifyPolyline", () => {
  it("returns a copy of a <= 2 point path unchanged", () => {
    const pts = [
      { lat: 40, lng: -105 },
      { lat: 40.001, lng: -105.001 },
    ];
    const out = simplifyPolyline(pts, 3);
    expect(out).toEqual(pts);
    expect(out).not.toBe(pts);
  });

  it("always keeps the first and last point exactly", () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({
      lat: 40 + i * M,
      lng: -105,
    }));
    const out = simplifyPolyline(pts, 3);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[pts.length - 1]);
  });

  it("collapses a near-straight dense line to just its endpoints", () => {
    // 100 points marching due north in a perfectly straight line — every
    // interior point lies on the first→last segment, so all drop out.
    const pts = Array.from({ length: 100 }, (_, i) => ({
      lat: 40 + i * M,
      lng: -105,
    }));
    const out = simplifyPolyline(pts, 3);
    expect(out).toHaveLength(2);
    expect(out).toEqual([pts[0], pts[99]]);
  });

  it("keeps a vertex whose deviation exceeds the tolerance (sharp turn)", () => {
    // A→B→C where B juts 10 m off the A–C line: a 3 m tolerance must keep B.
    const pts = [
      { lat: 40, lng: -105 },
      { lat: 40, lng: -105 + 10 * M }, // apex, ~10 m east of the A–C chord
      { lat: 40 + 20 * M, lng: -105 },
    ];
    const out = simplifyPolyline(pts, 3);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual(pts[1]);
  });

  it("drops a vertex whose deviation is below the tolerance", () => {
    // Same shape but the apex is only ~1 m off the chord → dropped at 3 m.
    const pts = [
      { lat: 40, lng: -105 },
      { lat: 40, lng: -105 + 1 * M },
      { lat: 40 + 20 * M, lng: -105 },
    ];
    const out = simplifyPolyline(pts, 3);
    expect(out).toHaveLength(2);
  });

  it("reduces the point count on a noisy jittered line", () => {
    // A straight north march with ±0.5 m east/west GPS jitter — most points are
    // within a 3 m tolerance of their neighbours and should be removed.
    const pts = Array.from({ length: 500 }, (_, i) => ({
      lat: 40 + i * M,
      lng: -105 + (i % 2 === 0 ? 0.5 : -0.5) * M,
    }));
    const out = simplifyPolyline(pts, 3);
    expect(out.length).toBeLessThan(pts.length / 5);
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("tolerance <= 0 keeps every point (copied)", () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({
      lat: 40 + i * M,
      lng: -105,
    }));
    expect(simplifyPolyline(pts, 0)).toHaveLength(10);
  });
});

describe("parseSimplifiedPath", () => {
  it("parses a valid >= 2 length lat/lng array", () => {
    const v = [
      { lat: 40, lng: -105 },
      { lat: 41, lng: -106 },
    ];
    expect(parseSimplifiedPath(v)).toEqual(v);
  });

  it("rejects non-arrays, short arrays, and malformed points", () => {
    expect(parseSimplifiedPath(undefined)).toBeUndefined();
    expect(parseSimplifiedPath([{ lat: 40, lng: -105 }])).toBeUndefined();
    expect(
      parseSimplifiedPath([
        { lat: 40, lng: -105 },
        { lat: "x", lng: -106 },
      ])
    ).toBeUndefined();
    expect(
      parseSimplifiedPath([
        { lat: 40, lng: -105 },
        { lat: Number.NaN, lng: -106 },
      ])
    ).toBeUndefined();
  });
});
