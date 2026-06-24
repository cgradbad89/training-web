import { describe, it, expect } from "vitest";
import { computeMileSplits, haversineMi } from "@/utils/mileSplits";
import { type RoutePoint } from "@/services/routes";

// ─── Helpers ──────────────────────────────────────────────────────────────

const BASE_MS = Date.parse("2024-01-01T00:00:00Z");
const LAT = 40;
const LNG0 = -100;

/**
 * Build a straight-line, constant-speed route at lat 40 stepping longitude by
 * `lngStep` degrees every `dtSec` seconds. Distance per segment is fixed, so the
 * raw haversine total is deterministic and the route is entirely "moving".
 */
function buildLineRoute(
  numPoints: number,
  lngStep: number,
  dtSec: number
): RoutePoint[] {
  return Array.from({ length: numPoints }, (_, i) => ({
    index: i,
    lat: LAT,
    lng: LNG0 + i * lngStep,
    altitude: 100,
    timestamp: new Date(BASE_MS + i * dtSec * 1000).toISOString(),
    speed: null,
    hr: null,
  }));
}

/** Distance (miles) of one segment of the line route above. */
function segMiles(lngStep: number): number {
  return haversineMi(LAT, LNG0, LAT, LNG0 + lngStep);
}

/** Sum of all segmentMiles across the returned splits. */
function totalSegmentMiles(splits: { segmentMiles: number }[]): number {
  return splits.reduce((acc, s) => acc + s.segmentMiles, 0);
}

// ─── Phase 1: distance anchoring ────────────────────────────────────────────

describe("computeMileSplits — Phase 1 distance anchoring", () => {
  it("scales the distance axis so the cumulative endpoint equals the authoritative total", () => {
    // 12 segments × 0.2646 mi ≈ 3.175 mi raw, 60 s each.
    const lngStep = 0.005;
    const dtSec = 60;
    const points = buildLineRoute(13, lngStep, dtSec);
    const rawTotal = 12 * segMiles(lngStep);

    // Authoritative total is ~0.8% LONGER than raw (raw is 0.8% short).
    const authoritative = rawTotal / 0.992;

    const scaled = computeMileSplits(points, null, authoritative);

    // Cumulative endpoint (sum of all segment miles) equals the stored total.
    expect(totalSegmentMiles(scaled)).toBeCloseTo(authoritative, 6);

    // Full-mile count = floor(scaled total); plus one partial.
    const fullMiles = Math.floor(authoritative);
    expect(scaled.filter((s) => !s.isPartial)).toHaveLength(fullMiles);
    expect(scaled.filter((s) => s.isPartial)).toHaveLength(1);
    scaled
      .filter((s) => !s.isPartial)
      .forEach((s) => expect(s.segmentMiles).toBeCloseTo(1.0, 6));
  });

  it("places mile boundaries on the SCALED axis (full-mile pace scales by raw/authoritative)", () => {
    const lngStep = 0.005;
    const dtSec = 60;
    const points = buildLineRoute(13, lngStep, dtSec);
    const rawTotal = 12 * segMiles(lngStep);
    const authoritative = rawTotal / 0.992;

    const unscaled = computeMileSplits(points); // no authoritative → raw axis
    const scaled = computeMileSplits(points, null, authoritative);

    const ratio = rawTotal / authoritative; // < 1 (scaled miles are longer)

    // Constant-speed route → every full mile has the same pace. The scaled
    // full-mile pace is the unscaled pace × (raw/authoritative): a scaled mile
    // spans MORE physical ground, so it is covered FASTER.
    const unscaledFull = unscaled.find((s) => !s.isPartial)!;
    scaled
      .filter((s) => !s.isPartial)
      .forEach((s) =>
        expect(s.paceSecPerMile).toBeCloseTo(
          unscaledFull.paceSecPerMile * ratio,
          4
        )
      );
    // Scaling longer → faster pace (smaller sec/mile).
    expect(scaled[0].paceSecPerMile).toBeLessThan(unscaledFull.paceSecPerMile);
  });
});

// ─── Backward compatibility ───────────────────────────────────────────────

describe("computeMileSplits — backward compatibility", () => {
  it("with no authoritative total, endpoint equals the raw haversine total", () => {
    const lngStep = 0.005;
    const points = buildLineRoute(13, lngStep, 60);
    const rawTotal = 12 * segMiles(lngStep);

    const splits = computeMileSplits(points);
    expect(totalSegmentMiles(splits)).toBeCloseTo(rawTotal, 6);
  });

  it("the avgHeartRate param does not change pace output (output identical with/without it)", () => {
    const points = buildLineRoute(13, 0.005, 60);
    const withoutHr = computeMileSplits(points);
    const withHr = computeMileSplits(points, 150);
    expect(withHr).toEqual(withoutHr);
  });

  it("on an all-moving route, the partial pace equals the elapsed pace (no regression vs pre-filter behavior)", () => {
    // 5 segments × 0.2646 ≈ 1.32 mi raw → 1 full + 1 partial, all moving.
    const lngStep = 0.005;
    const dtSec = 60;
    const points = buildLineRoute(6, lngStep, dtSec);
    const splits = computeMileSplits(points); // raw axis, all moving

    const partial = splits.find((s) => s.isPartial)!;
    // For a constant-speed, all-moving route the per-mile pace is uniform; the
    // partial's pace must match the full-mile pace (moving filter is a no-op).
    const full = splits.find((s) => !s.isPartial)!;
    expect(partial.paceSecPerMile).toBeCloseTo(full.paceSecPerMile, 2);
  });
});

// ─── Phase 2: partial-mile moving-time exclusion ────────────────────────────

describe("computeMileSplits — Phase 2 partial-mile stopped-time exclusion", () => {
  it("excludes trailing stopped time from the partial pace and references the scaled total", () => {
    const lngStep = 0.005;
    const dtSec = 10;
    const movingSegs = 2; // 2 moving segments → < 1 mile total (partial only)
    const stoppedSegs = 4; // 4 stopped segments (advancing time, static position)

    const points: RoutePoint[] = [];
    // Moving phase: points 0..movingSegs
    for (let i = 0; i <= movingSegs; i++) {
      points.push({
        index: i,
        lat: LAT,
        lng: LNG0 + i * lngStep,
        altitude: 100,
        timestamp: new Date(BASE_MS + i * dtSec * 1000).toISOString(),
        speed: null,
        hr: null,
      });
    }
    // Stopped tail: position frozen at the last moving lng, time keeps advancing.
    const frozenLng = LNG0 + movingSegs * lngStep;
    for (let k = 1; k <= stoppedSegs; k++) {
      points.push({
        index: movingSegs + k,
        lat: LAT,
        lng: frozenLng,
        altitude: 100,
        timestamp: new Date(
          BASE_MS + (movingSegs + k) * dtSec * 1000
        ).toISOString(),
        speed: null,
        hr: null,
      });
    }

    const rawTotal = movingSegs * segMiles(lngStep); // stopped tail adds ~0
    const authoritative = rawTotal; // scaleFactor 1 for a clean assertion

    const splits = computeMileSplits(points, null, authoritative);
    expect(splits).toHaveLength(1);
    const partial = splits[0];
    expect(partial.isPartial).toBe(true);

    // Label/pace basis: segmentMiles references the scaled total.
    expect(partial.segmentMiles).toBeCloseTo(authoritative, 6);

    // Moving-only pace: only the moving segments' time counts.
    const movingSec = movingSegs * dtSec;
    const expectedMovingPace = movingSec / authoritative;
    expect(partial.paceSecPerMile).toBeCloseTo(expectedMovingPace, 4);

    // The unfiltered (elapsed-including-stops) pace would be much slower; the
    // filtered value must be materially closer to the moving-only pace.
    const unfilteredSec = (movingSegs + stoppedSegs) * dtSec;
    const unfilteredPace = unfilteredSec / authoritative;
    expect(partial.paceSecPerMile).toBeLessThan(unfilteredPace);
    expect(unfilteredPace - partial.paceSecPerMile).toBeGreaterThan(
      (unfilteredPace - expectedMovingPace) * 0.9
    );
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe("computeMileSplits — edge cases", () => {
  it("returns [] for zero points", () => {
    expect(computeMileSplits([])).toEqual([]);
    expect(computeMileSplits([], null, 5)).toEqual([]);
  });

  it("returns [] for a single point", () => {
    const one = buildLineRoute(1, 0.005, 60);
    expect(computeMileSplits(one, null, 5)).toEqual([]);
  });

  it("returns [] when the raw total distance is ~0 (all points coincident)", () => {
    const pts: RoutePoint[] = Array.from({ length: 5 }, (_, i) => ({
      index: i,
      lat: LAT,
      lng: LNG0,
      altitude: 100,
      timestamp: new Date(BASE_MS + i * 1000).toISOString(),
      speed: null,
      hr: null,
    }));
    // Even with an authoritative total, a zero raw total cannot be split.
    expect(computeMileSplits(pts, null, 2)).toEqual([]);
  });
});
