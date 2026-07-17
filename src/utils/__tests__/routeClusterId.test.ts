import { describe, it, expect } from "vitest";
import {
  deriveRouteClusterId,
  isNolocClusterId,
  CLUSTER_GRID_DEG,
} from "@/utils/routeClusterId";

const START = { lat: 40.001, lng: -74.001 };

describe("deriveRouteClusterId", () => {
  it("is deterministic — identical inputs always produce the identical ID", () => {
    const a = deriveRouteClusterId(6.2, { ...START });
    const b = deriveRouteClusterId(6.2, { ...START });
    expect(a).toBe(b);
    expect(a).toMatch(/^v1_d6_/);
  });

  it("is stable across repeated calls (no hidden state)", () => {
    const ids = new Set(
      Array.from({ length: 25 }, () => deriveRouteClusterId(9.05, START))
    );
    expect(ids.size).toBe(1);
  });

  it("groups starts that fall in the same grid cell", () => {
    // Both snap to the same 0.003° cell.
    const a = deriveRouteClusterId(6.0, { lat: 40.001, lng: -74.001 });
    const b = deriveRouteClusterId(6.0, { lat: 40.0016, lng: -74.0016 });
    expect(a).toBe(b);
  });

  it("separates starts in clearly different cells (~1km apart)", () => {
    const a = deriveRouteClusterId(6.0, START);
    const b = deriveRouteClusterId(6.0, {
      lat: START.lat + 3 * CLUSTER_GRID_DEG,
      lng: START.lng,
    });
    expect(a).not.toBe(b);
  });

  it("buckets distance to the nearest integer mile (±0.5 tolerance analogue)", () => {
    const a = deriveRouteClusterId(5.4, START);
    const b = deriveRouteClusterId(4.6, START);
    const c = deriveRouteClusterId(5.6, START);
    expect(a).toBe(b); // both round to 5
    expect(a).not.toBe(c); // 5.6 rounds to 6
  });

  it("falls back to a distance-only bucket when the start point is missing", () => {
    expect(deriveRouteClusterId(6.2, null)).toBe("v1_d6_noloc");
    expect(
      deriveRouteClusterId(6.2, { lat: Number.NaN, lng: -74.001 })
    ).toBe("v1_d6_noloc");
  });

  it("treats non-finite / non-positive distance as bucket 0", () => {
    expect(deriveRouteClusterId(Number.NaN, null)).toBe("v1_d0_noloc");
    expect(deriveRouteClusterId(-3, null)).toBe("v1_d0_noloc");
  });

  it("produces the documented fixed-format ID", () => {
    expect(deriveRouteClusterId(6.2, { lat: 40.001, lng: -74.001 })).toBe(
      "v1_d6_40.0020_-74.0010"
    );
  });

  it("isNolocClusterId flags only the distance-only fallback IDs", () => {
    expect(isNolocClusterId(deriveRouteClusterId(6.2, null))).toBe(true);
    expect(isNolocClusterId(deriveRouteClusterId(6.2, START))).toBe(false);
  });
});
