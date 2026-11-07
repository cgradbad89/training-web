import { describe, expect, it } from "vitest";
import { CLUSTER_GRID_DEG, deriveRouteClusterId } from "../routeClusterId";
import { haversineMeters } from "../routeCache";

/**
 * Phase 3L characterization (not a behavior change). The scheme approximates the
 * Routes page's pairwise rule (distance ±0.5 mi AND start ≤ 300 m). On the
 * 2026-09-22 export, 12 % of pairs that satisfy the pairwise rule received
 * different ids (bucket/grid straddling) and 7 % of same-id pairs violated it.
 * These cases pin the two mechanisms so a future migration is judged against facts.
 */
describe("deriveRouteClusterId — documented approximation, pinned", () => {
  const start = { lat: 38.8, lng: -77.05 };

  it("same run inputs always yield the same id (deterministic)", () => {
    expect(deriveRouteClusterId(5.2, start)).toBe(deriveRouteClusterId(5.2, start));
  });

  it("splits runs that the pairwise rule would group when distances straddle a mile bucket", () => {
    const a = deriveRouteClusterId(5.49, start);
    const b = deriveRouteClusterId(5.51, start);
    expect(Math.abs(5.49 - 5.51)).toBeLessThanOrEqual(0.5);
    expect(a).not.toBe(b);
  });

  it("splits runs whose starts are within 300 m when they straddle a grid line", () => {
    const edge = (Math.round(start.lat / CLUSTER_GRID_DEG) + 0.5) * CLUSTER_GRID_DEG;
    const p = { lat: edge - 0.00002, lng: start.lng };
    const q = { lat: edge + 0.00002, lng: start.lng };
    expect(haversineMeters(p.lat, p.lng, q.lat, q.lng)).toBeLessThan(10);
    expect(deriveRouteClusterId(5, p)).not.toBe(deriveRouteClusterId(5, q));
  });

  it("groups runs the pairwise rule would reject: distances up to ~1 mile apart share a bucket", () => {
    // 4.5 and 5.49 both round to ... 5 → same id although 0.99 mi apart (> 0.5 mi rule).
    expect(deriveRouteClusterId(4.5, start)).toBe(deriveRouteClusterId(5.49, start));
  });

  it("an unresolved start falls back to a distance-only bucket", () => {
    expect(deriveRouteClusterId(5, null)).toBe("v1_d5_noloc");
    expect(deriveRouteClusterId(5, { lat: NaN, lng: 1 })).toBe("v1_d5_noloc");
  });
});
