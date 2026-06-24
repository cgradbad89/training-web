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

/** Fixed longitude step used by the explicit-point test routes below. */
const STEP = 0.005;

/**
 * Build one route point at `lngUnits` × STEP east of LNG0, at `tSec` seconds.
 * Repeating the same `lngUnits` on consecutive points yields a STOPPED segment
 * (zero distance, advancing time).
 */
function pt(index: number, lngUnits: number, tSec: number): RoutePoint {
  return {
    index,
    lat: LAT,
    lng: LNG0 + lngUnits * STEP,
    altitude: 100,
    timestamp: new Date(BASE_MS + tSec * 1000).toISOString(),
    speed: null,
    hr: null,
  };
}

/**
 * Sum of effective (moving) seconds the splits imply: paceSecPerMile ×
 * segmentMiles per mile, summed. When every mile has some moving time, this
 * equals the total MOVING seconds of the whole run (stopped time excluded).
 */
function impliedMovingSec(
  splits: { paceSecPerMile: number; segmentMiles: number }[]
): number {
  return splits.reduce((acc, s) => acc + s.paceSecPerMile * s.segmentMiles, 0);
}

/**
 * Independent oracle for the UNFILTERED interpolated elapsed time from the run
 * start to the `targetMiles` boundary, on the same scaled distance axis the
 * implementation uses. Mirrors only the (uncontested) boundary interpolation —
 * NOT the moving-time exclusion under test — so it is a fair reference.
 */
function unfilteredElapsedToBoundary(
  points: RoutePoint[],
  targetMiles: number,
  authoritative: number
): number {
  const cum = [0];
  const ts = [Date.parse(points[0].timestamp)];
  for (let i = 1; i < points.length; i++) {
    cum.push(
      cum[i - 1] +
        haversineMi(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng)
    );
    ts.push(Date.parse(points[i].timestamp));
  }
  const raw = cum[cum.length - 1];
  const sf = authoritative > 0 && raw > 0 ? authoritative / raw : 1;
  for (let i = 0; i < cum.length; i++) cum[i] *= sf;
  let e = 0;
  while (e < cum.length - 1 && cum[e] < targetMiles) e++;
  const boundaryTs =
    e === 0
      ? ts[0]
      : ts[e - 1] +
        ((targetMiles - cum[e - 1]) / (cum[e] - cum[e - 1])) * (ts[e] - ts[e - 1]);
  return (boundaryTs - ts[0]) / 1000;
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

// ─── Full-mile moving-time exclusion ────────────────────────────────────────

describe("computeMileSplits — full-mile stopped-time exclusion", () => {
  it("a full mile with a mid-mile stop excludes the stopped seconds (faster than unfiltered)", () => {
    // 5 moving segments (60 s each) + 1 stopped 60 s segment inside mile 1.
    // lngUnits: 0,1,2,2(stop),3,4,5 → 1.32 mi raw, stop adds 0 distance.
    const points = [
      pt(0, 0, 0),
      pt(1, 1, 60),
      pt(2, 2, 120),
      pt(3, 2, 180), // STOP (mid-mile, within full mile 1)
      pt(4, 3, 240),
      pt(5, 4, 300),
      pt(6, 5, 360),
    ];
    const authoritative = 5 * segMiles(STEP); // stop adds ~0 → raw == moving dist
    const splits = computeMileSplits(points, null, authoritative);

    const full = splits.find((s) => !s.isPartial)!;
    expect(full).toBeDefined();
    expect(full.mile).toBe(1);
    expect(full.segmentMiles).toBeCloseTo(1.0, 6);

    // The mile-1 numerator drops the 60 s stop: filtered pace is faster than the
    // unfiltered interpolated elapsed pace by ≈ the stopped time (segMiles == 1).
    const unfilteredMile1Sec = unfilteredElapsedToBoundary(points, 1, authoritative);
    expect(full.paceSecPerMile).toBeLessThan(unfilteredMile1Sec);
    expect(unfilteredMile1Sec - full.paceSecPerMile).toBeCloseTo(60, 1);

    // Whole-run check: implied moving seconds == 5 × 60 (stopped 60 s excluded),
    // well below the 6 × 60 = 360 s of elapsed wall-clock.
    expect(impliedMovingSec(splits)).toBeCloseTo(300, 1);
  });

  it("a full mile with NO stops is unchanged (pace == unfiltered interpolated pace)", () => {
    // 9 moving segments → ~2.38 mi, all moving, constant speed.
    const points = buildLineRoute(10, STEP, 60);
    const authoritative = 9 * segMiles(STEP);
    const splits = computeMileSplits(points, null, authoritative);

    const fulls = splits.filter((s) => !s.isPartial);
    expect(fulls.length).toBe(2);

    // No stops → each full mile's moving time equals its interpolated elapsed
    // time, so pace matches the unfiltered oracle exactly (no regression).
    const unfilteredMile1 = unfilteredElapsedToBoundary(points, 1, authoritative);
    const unfilteredMile2 =
      unfilteredElapsedToBoundary(points, 2, authoritative) - unfilteredMile1;
    expect(fulls[0].paceSecPerMile).toBeCloseTo(unfilteredMile1, 4);
    expect(fulls[1].paceSecPerMile).toBeCloseTo(unfilteredMile2, 4);

    // Whole run: implied moving seconds == total elapsed (nothing excluded).
    expect(impliedMovingSec(splits)).toBeCloseTo(9 * 60, 3);
  });

  it("a route with BOTH a mid-run stop and an end stop excludes both, under one rule for full + partial", () => {
    // lngUnits: 0,1,2,2(stop),3,4,5,5(stop) → 5 moving (60 s) + 2 stops (60 s).
    const points = [
      pt(0, 0, 0),
      pt(1, 1, 60),
      pt(2, 2, 120),
      pt(3, 2, 180), // STOP #1 (mid-run, inside full mile 1)
      pt(4, 3, 240),
      pt(5, 4, 300),
      pt(6, 5, 360),
      pt(7, 5, 420), // STOP #2 (end, inside the partial mile)
    ];
    const authoritative = 5 * segMiles(STEP);
    const splits = computeMileSplits(points, null, authoritative);

    const full = splits.find((s) => !s.isPartial)!;
    const partial = splits.find((s) => s.isPartial)!;
    expect(full).toBeDefined();
    expect(partial).toBeDefined();

    // Full mile excludes the mid-run stop; partial excludes the end stop — same
    // moving-time rule for both. Implied moving seconds == 5 × 60, with both
    // 60 s stops (120 s total) removed from the 7 × 60 = 420 s of wall-clock.
    expect(impliedMovingSec(splits)).toBeCloseTo(300, 1);

    // The full mile specifically is faster than its unfiltered elapsed pace.
    const unfilteredMile1Sec = unfilteredElapsedToBoundary(points, 1, authoritative);
    expect(full.paceSecPerMile).toBeLessThan(unfilteredMile1Sec);
  });

  it("a mile entirely below the moving-speed threshold falls back to elapsed (no NaN / 0:00)", () => {
    // Slow walk: ~85 m segments over 200 s each → ~0.43 m/s < MIN_MOVING_SPEED_MS,
    // yet real distance accrues, so a FULL mile forms while every segment is
    // classified "stopped". Chosen fallback: use the interpolated elapsed time
    // (not a nonsensical 0) so the very-slow pace is reported, not dropped.
    const points = buildLineRoute(21, 0.001, 200); // 20 segs × ~0.053 mi ≈ 1.06 mi
    const rawTotal = 20 * segMiles(0.001);
    const splits = computeMileSplits(points, null, rawTotal);

    const full = splits[0];
    expect(full.isPartial).toBe(false);
    expect(Number.isFinite(full.paceSecPerMile)).toBe(true);
    expect(full.paceSecPerMile).toBeGreaterThan(0); // fallback fired (not 0:00)

    // Fallback value equals the interpolated elapsed pace for the full mile.
    const elapsedMile1 = unfilteredElapsedToBoundary(points, 1, rawTotal);
    expect(full.paceSecPerMile).toBeCloseTo(elapsedMile1, 4);
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
