import { describe, it, expect, vi } from "vitest";
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
    expect(actual).not.toBeNull();
    expect(gap.runGapSecPerMile).toBeCloseTo(actual as number, 1);
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

  // ── Stop-time regression: GAP must reflect MOVING pace, not elapsed ───────
  // computeRunGap used elapsed time as the denominator baseline, so stop time
  // (lights, pauses) inflated GAP slower than actual on every run with stops.
  // GAP is now derived over moving segments only.

  /**
   * Stop-and-go route at lat 40: `movingCount` moving segments (~8.5 m / 3 s
   * each → ~2.84 m/s), then `stoppedCount` stopped segments (no position
   * change, 3 s each → speed 0). Flat elevation. Returns realistic samples.
   */
  function buildStopAndGoRoute(
    movingCount: number,
    stoppedCount: number,
    secPerSeg = 3
  ): RoutePoint[] {
    const pts: RoutePoint[] = [];
    let lng = -100;
    let tMs = BASE_MS;
    // Start point.
    pts.push({
      index: 0, lat: 40, lng, altitude: 100,
      timestamp: new Date(tMs).toISOString(), speed: null, hr: null,
    });
    for (let i = 0; i < movingCount; i++) {
      lng += 0.0001; // ~8.5 m east
      tMs += secPerSeg * 1000;
      pts.push({
        index: pts.length, lat: 40, lng, altitude: 100,
        timestamp: new Date(tMs).toISOString(), speed: null, hr: null,
      });
    }
    for (let i = 0; i < stoppedCount; i++) {
      // lng unchanged → 0 m moved → stopped.
      tMs += secPerSeg * 1000;
      pts.push({
        index: pts.length, lat: 40, lng, altitude: 100,
        timestamp: new Date(tMs).toISOString(), speed: null, hr: null,
      });
    }
    return pts;
  }

  /** Distance-weighted pace over MOVING segments only (sec/mi). */
  function movingPaceSecPerMile(pts: RoutePoint[]): number {
    const EARTH_RADIUS_MI = 3958.8;
    const toRad = (d: number) => (d * Math.PI) / 180;
    let miles = 0;
    let sec = 0;
    for (let i = 1; i < pts.length; i++) {
      const dLat = toRad(pts[i].lat - pts[i - 1].lat);
      const dLng = toRad(pts[i].lng - pts[i - 1].lng);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(pts[i - 1].lat)) *
          Math.cos(toRad(pts[i].lat)) *
          Math.sin(dLng / 2) ** 2;
      const segMi = 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
      const segSec =
        (Date.parse(pts[i].timestamp) - Date.parse(pts[i - 1].timestamp)) / 1000;
      const speedMs = segSec > 0 ? (segMi * 1609.344) / segSec : 0;
      if (segMi * 1609.344 >= 1 && speedMs >= 0.5) {
        miles += segMi;
        sec += segSec;
      }
    }
    return miles > 0 ? sec / miles : 0;
  }

  it("stopped segments → run GAP ≈ moving pace (not inflated by stop time)", () => {
    // 300 moving segs (900 s) + 130 stopped segs (390 s) → 30.2% of elapsed
    // time stopped. Flat, so GAP should track the moving pace, ignoring stops.
    const pts = buildStopAndGoRoute(300, 130);
    const elapsedSec =
      (Date.parse(pts[pts.length - 1].timestamp) - Date.parse(pts[0].timestamp)) /
      1000;
    const stoppedSec = 130 * 3;
    expect(stoppedSec / elapsedSec).toBeGreaterThan(0.29); // ~30% stopped

    const gap = computeRunGap(pts, 0, elapsedSec);
    const movingPace = movingPaceSecPerMile(pts);
    const errPct = Math.abs(gap.runGapSecPerMile - movingPace) / movingPace;
    expect(errPct).toBeLessThanOrEqual(0.01); // within 1%

    // Sanity: had we used elapsed time, GAP would be ~30% slower.
    const elapsedPaceWouldBe = movingPace * (elapsedSec / (300 * 3));
    expect(gap.runGapSecPerMile).toBeLessThan(elapsedPaceWouldBe * 0.95);

    // Stopped tail segments carry a null pace (line break), not a bogus value.
    const nullCount = gap.perPointGap.filter(
      (p) => p.gradeAdjPaceSecPerMile === null
    ).length;
    expect(nullCount).toBeGreaterThanOrEqual(130);
  });

  it("all-moving route → unchanged (no stop-time regression on clean runs)", () => {
    // No stops: every segment moving, so GAP equals the moving pace exactly.
    const pts = buildStopAndGoRoute(400, 0);
    const gap = computeRunGap(pts, 0, 0);
    const movingPace = movingPaceSecPerMile(pts);
    const errPct = Math.abs(gap.runGapSecPerMile - movingPace) / movingPace;
    expect(errPct).toBeLessThanOrEqual(0.005);
    // No stopped segments → no null pace entries.
    expect(
      gap.perPointGap.every((p) => p.gradeAdjPaceSecPerMile !== null)
    ).toBe(true);
  });

  it("degenerate timestamps → falls back to movingTimeSec param, warns, no crash", () => {
    // All-equal timestamps → segSec = 0 everywhere → derived moving time 0.
    const pts: RoutePoint[] = Array.from({ length: 30 }, (_, i) => ({
      index: i,
      lat: 40,
      lng: -100 + i * 0.0001,
      altitude: 100,
      timestamp: new Date(BASE_MS).toISOString(), // identical for all points
      speed: null,
      hr: null,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gap = computeRunGap(pts, 0, 600);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("computeRunGap");
    // No crash; segments still classified as moving by distance, so perPointGap
    // is produced (panes don't blow up). adjSec uses segSec=0 → GAP 0 here, but
    // the contract under test is "no crash + warn + fallback path taken".
    expect(Array.isArray(gap.perPointGap)).toBe(true);
    expect(gap.perPointGap.length).toBe(pts.length - 1);
    warn.mockRestore();
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

// ─── Ratio-based GAP (root causes #1/#2/#3) ─────────────────────────────────
// GAP is now the TRUSTED raw pace (avgPaceSecPerMile) scaled by a unitless grade
// ratio from the aggregate smoothed elevation profile. Flat → identity; net-up →
// faster; net-down → slower; symmetric rolling → no slow-bias; gentle sub-1.5%
// sustained climb still earns credit (dead-band no longer eats the aggregate).
describe("computeRunGap — ratio applied to trusted raw pace", () => {
  const AVG_PACE = 588; // 9:48/mi — arbitrary trusted device pace

  // Long enough that 11-pt smoothing preserves interior grade; ~8.5 m segs.
  function makeAlts(fn: (i: number) => number, count = 400): number[] {
    return Array.from({ length: count }, (_, i) => fn(i));
  }

  it("flat run → GAP == avgPaceSecPerMile exactly (identity regression guard)", () => {
    const pts = buildNoisyRoute(400, () => 100, 0); // perfectly flat, no noise
    const gap = computeRunGap(pts, 0, 0, AVG_PACE);
    expect(gap.runGapSecPerMile).toBeCloseTo(AVG_PACE, 6);
  });

  it("net-uphill run → GAP < avgPaceSecPerMile (faster)", () => {
    // +0.25 m per ~8.5 m seg ≈ +3% sustained climb.
    const pts = buildNoisyRoute(400, (i) => 100 + i * 0.25, 0);
    const gap = computeRunGap(pts, 0, 0, AVG_PACE);
    expect(gap.runGapSecPerMile).toBeLessThan(AVG_PACE);
  });

  it("net-downhill run → GAP > avgPaceSecPerMile (slower)", () => {
    const pts = buildNoisyRoute(400, (i) => 100 - i * 0.25, 0);
    const gap = computeRunGap(pts, 0, 0, AVG_PACE);
    expect(gap.runGapSecPerMile).toBeGreaterThan(AVG_PACE);
  });

  it("symmetric rolling grades → no slow-bias vs flat (Jensen convexity fixed)", () => {
    // Up to +100 m then back to 0 over the route → net 0, but each span's grade
    // far exceeds the dead-band. Old per-span 1/factor summation biased slow.
    const half = 200;
    const rolling = makeAlts((i) =>
      i <= half ? 100 + i * 0.5 : 100 + (400 - i) * 0.5
    );
    const pts = buildNoisyRoute(400, (i) => rolling[i], 0);
    const gap = computeRunGap(pts, 0, 0, AVG_PACE);
    // Net elevation ≈ 0 → ratio ≈ 1 → GAP ≈ avg pace, NOT inflated slower.
    const errPct = Math.abs(gap.runGapSecPerMile - AVG_PACE) / AVG_PACE;
    expect(errPct).toBeLessThan(0.01); // within 1% of flat — no Jensen slow-bias
    expect(gap.runGapSecPerMile).toBeLessThanOrEqual(AVG_PACE + 1);
  });

  it("gentle sustained sub-1.5% climb → still earns a faster GAP (dead-band re-scope)", () => {
    // ~0.4% average grade: every per-span grade sits BELOW the ±1.5% dead-band,
    // so the old logic would zero it and return GAP == pace. The aggregate net
    // grade (no dead-band) must still credit the climb → GAP faster.
    const pts = buildNoisyRoute(400, (i) => 100 + i * 0.035, 0);
    const gap = computeRunGap(pts, 0, 0, AVG_PACE);
    expect(gap.runGapSecPerMile).toBeLessThan(AVG_PACE);
    // But only slightly faster — a gentle grade, not a wall.
    expect(gap.runGapSecPerMile).toBeGreaterThan(AVG_PACE * 0.9);
  });

  it("omitting avgPaceSecPerMile → falls back to GPS raw-pace basis (back-compat)", () => {
    const pts = buildNoisyRoute(400, () => 100, 0);
    const withArg = computeRunGap(pts, 0, 0);
    const actual = actualPaceSecPerMile(pts);
    // No trusted pace → basis is GPS raw moving pace; flat → GAP ≈ actual.
    expect(withArg.runGapSecPerMile).toBeCloseTo(actual, 1);
  });
});

// ─── Phase 1: robust net-grade endpoints ────────────────────────────────────
// A single noisy altitude at the first/last MOVING point must not tilt the
// whole-run net grade, because the net is averaged over the first/last 5 points.
describe("computeRunGap — endpoint-averaged net grade (Phase 1)", () => {
  const AVG_PACE = 588;

  /** Linear-ramp route: ~8.5 m segs, controllable per-segment slope (m). */
  function buildRamp(
    count: number,
    startAlt: number,
    slopePerSeg: number
  ): RoutePoint[] {
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      lat: 40,
      lng: -100 + i * 0.0001,
      altitude: startAlt + i * slopePerSeg,
      timestamp: new Date(BASE_MS + i * 3 * 1000).toISOString(),
      speed: null,
      hr: null,
    }));
  }

  it("outlier at the FIRST moving point barely moves GAP (vs clean)", () => {
    const clean = buildRamp(800, 100, 0.2); // sustained ~2.35% climb
    const outlier = clean.map((p, i) =>
      i === 0 ? { ...p, altitude: p.altitude + 25 } : p
    );
    const gClean = computeRunGap(clean, 0, 0, AVG_PACE);
    const gOut = computeRunGap(outlier, 0, 0, AVG_PACE);
    expect(Math.abs(gClean.runGapSecPerMile - gOut.runGapSecPerMile)).toBeLessThan(2);
  });

  it("outlier at the LAST moving point barely moves GAP (vs clean)", () => {
    const clean = buildRamp(800, 100, 0.2);
    const outlier = clean.map((p, i) =>
      i === clean.length - 1 ? { ...p, altitude: p.altitude - 25 } : p
    );
    const gClean = computeRunGap(clean, 0, 0, AVG_PACE);
    const gOut = computeRunGap(outlier, 0, 0, AVG_PACE);
    expect(Math.abs(gClean.runGapSecPerMile - gOut.runGapSecPerMile)).toBeLessThan(2);
  });

  it("exposes netRiseM (negative for net descent)", () => {
    const down = buildRamp(800, 200, -0.1);
    const g = computeRunGap(down, 0, 0, AVG_PACE);
    expect(g.netRiseM).not.toBeNull();
    expect(g.netRiseM as number).toBeLessThan(0);
  });
});

// ─── Phase 2: tight aggregate-grade dead-band ───────────────────────────────
// Pure endpoint-noise jitter (|grade| ≤ 0.10%) snaps to flat (GAP == pace), but
// real shallow descents (e.g. the −0.229% reference run) must NOT be snapped.
describe("computeRunGap — aggregate-grade dead-band (Phase 2)", () => {
  const AVG_PACE = 588;

  function buildRamp(count: number, startAlt: number, slope: number): RoutePoint[] {
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      lat: 40,
      lng: -100 + i * 0.0001,
      altitude: startAlt + i * slope,
      timestamp: new Date(BASE_MS + i * 3 * 1000).toISOString(),
      speed: null,
      hr: null,
    }));
  }

  it("net grade ≈ +0.05% → snapped to flat (GAP == avgPace)", () => {
    // slope chosen so net grade lands ~0.05% (< 0.10% dead-band).
    const pts = buildRamp(400, 100, 0.0043);
    const g = computeRunGap(pts, 0, 0, AVG_PACE);
    expect(g.runGapSecPerMile).toBeCloseTo(AVG_PACE, 6);
  });

  it("net grade ≈ −0.05% → snapped to flat (GAP == avgPace)", () => {
    const pts = buildRamp(400, 120, -0.0043);
    const g = computeRunGap(pts, 0, 0, AVG_PACE);
    expect(g.runGapSecPerMile).toBeCloseTo(AVG_PACE, 6);
  });

  it("reference net grade ≈ −0.229% → NOT snapped, GAP stays ~+7 sec slower", () => {
    // slope chosen so net grade ≈ −0.229% (the real reference-run value).
    const pts = buildRamp(400, 200, -0.0198);
    const g = computeRunGap(pts, 0, 0, AVG_PACE);
    expect(g.runGapSecPerMile).toBeGreaterThan(AVG_PACE + 5); // clearly not snapped
    expect(g.runGapSecPerMile).toBeLessThan(AVG_PACE + 10);
  });
});
