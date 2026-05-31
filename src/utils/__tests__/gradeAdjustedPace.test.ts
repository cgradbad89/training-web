import { describe, it, expect } from "vitest";
import {
  gradeAdjustmentFactor,
  computeRunGap,
} from "../gradeAdjustedPace";
import { type RoutePoint } from "@/services/routes";

// ─── Helpers ──────────────────────────────────────────────────────────────

const BASE_MS = Date.parse("2024-01-01T00:00:00Z");
const SEC_PER_SEG = 180;

/** Build a straight-line route at lat 40, stepping longitude by 0.01°/segment. */
function buildRoute(altitudes: number[]): RoutePoint[] {
  return altitudes.map((altitude, i) => ({
    index: i,
    lat: 40,
    lng: -100 + i * 0.01,
    altitude,
    timestamp: new Date(BASE_MS + i * SEC_PER_SEG * 1000).toISOString(),
    speed: null,
    hr: null,
  }));
}

// Routes are long enough (≥ ALT_SMOOTHING_WINDOW points) that the centered
// altitude moving-average preserves a linear ramp at interior points; a route
// shorter than the window collapses to its mean (flat) and would hide grade.
const N = 15; // 15 points → 14 segments
const flatAlts = Array(N).fill(100);
// Steady ~5.9%/seg climb: each ~853 m segment rises 50 m → above the dead-band.
const upAlts = Array.from({ length: N }, (_, i) => i * 50); // 0 → 700
const downAlts = Array.from({ length: N }, (_, i) => (N - 1 - i) * 50); // 700 → 0

/**
 * Deterministic pseudo-random sequence in [-amp, +amp] (seeded LCG) so altitude
 * noise is reproducible across test runs.
 */
function seededNoise(count: number, amp: number, seed = 12345): number[] {
  const out: number[] = [];
  let s = seed >>> 0;
  for (let i = 0; i < count; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    out.push((s / 0x7fffffff) * 2 * amp - amp);
  }
  return out;
}

/**
 * Build a realistic-resolution route: ~8.5 m segments (lng step 0.0001° @ lat
 * 40), 3 s apart, with base elevation `baseAlt(i)` plus ±`noiseAmp` m of GPS
 * altitude noise — the conditions that expose the Jensen convexity bias.
 */
function buildNoisyRoute(
  count: number,
  baseAlt: (i: number) => number,
  noiseAmp: number,
  secPerSeg = 3,
  seed = 12345
): RoutePoint[] {
  const noise = seededNoise(count, noiseAmp, seed);
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    lat: 40,
    lng: -100 + i * 0.0001,
    altitude: baseAlt(i) + noise[i],
    timestamp: new Date(BASE_MS + i * secPerSeg * 1000).toISOString(),
    speed: null,
    hr: null,
  }));
}

/** Actual distance-weighted pace (sec/mi) implied by a route's GPS samples. */
function actualPaceSecPerMile(pts: RoutePoint[]): number {
  const EARTH_RADIUS_MI = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  let miles = 0;
  for (let i = 1; i < pts.length; i++) {
    const dLat = toRad(pts[i].lat - pts[i - 1].lat);
    const dLng = toRad(pts[i].lng - pts[i - 1].lng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(pts[i - 1].lat)) *
        Math.cos(toRad(pts[i].lat)) *
        Math.sin(dLng / 2) ** 2;
    miles += 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
  }
  const sec =
    (Date.parse(pts[pts.length - 1].timestamp) - Date.parse(pts[0].timestamp)) /
    1000;
  return miles > 0 ? sec / miles : 0;
}

describe("gradeAdjustmentFactor", () => {
  it("≈ 1 on flat ground", () => {
    expect(gradeAdjustmentFactor(0)).toBeCloseTo(1, 5);
  });

  it("> 1 uphill (costlier)", () => {
    expect(gradeAdjustmentFactor(10)).toBeGreaterThan(1);
  });

  it("< 1 on moderate downhill (cheaper)", () => {
    expect(gradeAdjustmentFactor(-10)).toBeLessThan(1);
  });

  it("clamps grade beyond ±30%", () => {
    expect(gradeAdjustmentFactor(100)).toBe(gradeAdjustmentFactor(30));
    expect(gradeAdjustmentFactor(-100)).toBe(gradeAdjustmentFactor(-30));
  });
});

describe("computeRunGap", () => {
  it("flat course → GAP ≈ actual pace", () => {
    const pts = buildRoute(flatAlts);
    const gap = computeRunGap(pts, 0, (N - 1) * SEC_PER_SEG);
    // On flat ground every factor is 1, so run GAP equals the actual
    // timestamp-derived pace. perPointGap pace is constant and equals it.
    const actual = gap.perPointGap[0].gradeAdjPaceSecPerMile;
    expect(gap.runGapSecPerMile).toBeCloseTo(actual, 1);
    expect(gap.perPointGap).toHaveLength(N - 1);
    expect(gap.perMileGapSecPerMile.length).toBeGreaterThan(0);
  });

  it("net uphill → run GAP faster (lower sec/mi) than the same-route flat pace", () => {
    const flat = computeRunGap(buildRoute(flatAlts), 0, (N - 1) * SEC_PER_SEG);
    const up = computeRunGap(buildRoute(upAlts), 0, (N - 1) * SEC_PER_SEG);
    expect(up.runGapSecPerMile).toBeLessThan(flat.runGapSecPerMile);
  });

  it("net downhill → run GAP slower (higher sec/mi) than the same-route flat pace", () => {
    const flat = computeRunGap(buildRoute(flatAlts), 0, (N - 1) * SEC_PER_SEG);
    const down = computeRunGap(buildRoute(downAlts), 0, (N - 1) * SEC_PER_SEG);
    expect(down.runGapSecPerMile).toBeGreaterThan(flat.runGapSecPerMile);
  });

  // ── Jensen-bias regression: this is the suite's old blind spot ────────────
  // The original adjacent-point grade logic squared GPS altitude noise into
  // spurious grades whose convex 1/factor cost does NOT cancel, biasing GAP
  // systematically slow on flat ground. These tests FAIL against that logic and
  // PASS with the resampled-baseline + smoothing + dead-band fix.

  it("noisy-flat → run GAP ≈ actual pace (no convexity slow-bias)", () => {
    // Net-zero elevation, constant pace, ±0.5 m altitude noise on ~8.5 m segs.
    const pts = buildNoisyRoute(400, () => 100, 0.5);
    const gap = computeRunGap(pts, 0, 0);
    const actual = actualPaceSecPerMile(pts);
    const errPct = Math.abs(gap.runGapSecPerMile - actual) / actual;
    expect(errPct).toBeLessThanOrEqual(0.015); // within 1.5%
  });

  it("gentle net uphill + noise → run GAP faster than actual (sign survives)", () => {
    // ~3% true grade (0.25 m rise per ~8.5 m seg) buried under ±0.5 m noise.
    const pts = buildNoisyRoute(400, (i) => 100 + i * 0.25, 0.5);
    const gap = computeRunGap(pts, 0, 0);
    const actual = actualPaceSecPerMile(pts);
    expect(gap.runGapSecPerMile).toBeLessThan(actual);
  });

  it("empty input → safe (falls back to actual pace, no crash)", () => {
    const gap = computeRunGap([], 2, 1200);
    expect(gap.runGapSecPerMile).toBeCloseTo(600, 5); // 1200s / 2mi
    expect(gap.perPointGap).toEqual([]);
    expect(gap.perMileGapSecPerMile).toEqual([]);
  });

  it("single point → safe (returns 0 when no distance/time, no crash)", () => {
    const gap = computeRunGap(buildRoute([100]), 0, 0);
    expect(gap.runGapSecPerMile).toBe(0);
    expect(gap.perPointGap).toEqual([]);
  });
});
