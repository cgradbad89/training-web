import { describe, it, expect } from "vitest";
import {
  computePaceAxisDomain,
  MIN_PACE_FLOOR_SEC,
  MAX_PACE_CEIL_SEC,
} from "../paceAxisDomain";

describe("computePaceAxisDomain", () => {
  it("normal spread → domain ≈ [min-pad, max-pad] within absolute bounds", () => {
    const values = Array.from({ length: 100 }, (_, i) => 400 + i); // 400..499
    const [lo, hi] = computePaceAxisDomain(values);
    // p5 ≈ 404, p95 ≈ 494; padding small → just outside that band.
    expect(lo).toBeGreaterThanOrEqual(MIN_PACE_FLOOR_SEC);
    expect(hi).toBeLessThanOrEqual(MAX_PACE_CEIL_SEC);
    expect(lo).toBeLessThan(hi);
    expect(lo).toBeGreaterThan(380);
    expect(lo).toBeLessThan(410);
    expect(hi).toBeGreaterThan(490);
    expect(hi).toBeLessThan(515);
  });

  it("extreme low outliers → domain ignores them (not pulled to the floor)", () => {
    const values = [
      ...Array.from({ length: 100 }, () => 600), // real band ~600 s/mi
      2,
      5,
      8, // GPS-glitch near-zero spikes (<3% of points)
    ];
    const [lo, hi] = computePaceAxisDomain(values);
    // The low spikes must not drag domainMin toward the floor.
    expect(lo).toBeGreaterThan(500);
    expect(lo).toBeGreaterThan(MIN_PACE_FLOOR_SEC);
    expect(hi).toBeLessThanOrEqual(MAX_PACE_CEIL_SEC);
    expect(lo).toBeLessThan(hi);
  });

  it("all-equal values → non-zero-width domain (no divide-by-zero)", () => {
    const [lo, hi] = computePaceAxisDomain([500, 500, 500, 500]);
    expect(hi).toBeGreaterThan(lo);
    expect(hi - lo).toBeCloseTo(20, 5); // padding 10 on each side
  });

  it("empty / all-null (non-finite) → safe fallback domain", () => {
    const empty = computePaceAxisDomain([]);
    expect(empty).toEqual([MIN_PACE_FLOOR_SEC, MAX_PACE_CEIL_SEC]);

    const nonFinite = computePaceAxisDomain([NaN, Infinity, -Infinity]);
    expect(nonFinite).toEqual([MIN_PACE_FLOOR_SEC, MAX_PACE_CEIL_SEC]);
    expect(nonFinite[0]).toBeLessThan(nonFinite[1]);
  });
});
