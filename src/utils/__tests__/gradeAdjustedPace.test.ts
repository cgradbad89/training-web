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

const N = 5; // 5 points → 4 segments
const flatAlts = Array(N).fill(100);
const upAlts = [0, 30, 60, 90, 120]; // steady climb
const downAlts = [120, 90, 60, 30, 0]; // steady descent

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
