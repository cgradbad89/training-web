import { describe, expect, it } from "vitest";
import { type RoutePoint } from "@/services/routes";
import {
  BEST_EFFORT_DISTANCES_M,
  computeBestEfforts,
  shouldRecomputeBestEfforts,
  withBestEffortsFreshness,
} from "@/utils/bestEfforts";
import { BEST_EFFORTS_COMPUTATION_VERSION } from "@/utils/fastestMileSegment";

const EARTH_RADIUS_M = 3958.8 * 1609.344;
const START_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

function pointAt(index: number, meters: number, seconds: number): RoutePoint {
  return {
    index,
    lat: (meters / EARTH_RADIUS_M) * (180 / Math.PI),
    lng: 0,
    altitude: 0,
    timestamp: new Date(START_MS + seconds * 1000).toISOString(),
    speed: null,
    hr: null,
  };
}

function route(samples: Array<[meters: number, seconds: number]>): RoutePoint[] {
  return samples.map(([meters, seconds], index) =>
    pointAt(index, meters, seconds)
  );
}

describe("computeBestEfforts", () => {
  it("returns 1mi when the run is longer than 1mi but shorter than 5K", () => {
    const oneMile = BEST_EFFORT_DISTANCES_M["1mi"];
    const efforts = computeBestEfforts(
      route([
        [0, 0],
        [oneMile, 600],
        [oneMile * 2, 1200],
      ])
    );

    expect(efforts["1mi"]).toBeCloseTo(600, 2);
    expect(efforts["5k"]).toBeNull();
    expect(efforts["10k"]).toBeNull();
    expect(efforts["10mi"]).toBeNull();
    expect(efforts.half).toBeNull();
  });

  it("finds the fastest 1mi as a mid-run segment instead of the run average", () => {
    const oneMile = BEST_EFFORT_DISTANCES_M["1mi"];
    const efforts = computeBestEfforts(
      route([
        [0, 0],
        [oneMile, 700],
        [oneMile * 2, 1000],
        [oneMile * 3, 1700],
      ])
    );

    expect(efforts["1mi"]).toBeCloseTo(300, 2);
  });

  it("interpolates the exact 1mi boundary between bracketing route points", () => {
    const efforts = computeBestEfforts(
      route([
        [0, 0],
        [1000, 300],
        [2000, 600],
      ])
    );

    expect(efforts["1mi"]).toBeGreaterThan(300);
    expect(efforts["1mi"]).toBeLessThan(600);
    expect(efforts["1mi"]).toBeCloseTo(482.8032, 3);
  });

  it("returns null for every distance when the run is shorter than all targets", () => {
    const efforts = computeBestEfforts(
      route([
        [0, 0],
        [1000, 600],
      ])
    );

    expect(efforts).toEqual({
      "1mi": null,
      "5k": null,
      "10k": null,
      "10mi": null,
      half: null,
    });
  });

  it("handles empty and single-point routes without crashing", () => {
    expect(computeBestEfforts([])).toEqual({
      "1mi": null,
      "5k": null,
      "10k": null,
      "10mi": null,
      half: null,
    });
    expect(computeBestEfforts(route([[0, 0]]))).toEqual({
      "1mi": null,
      "5k": null,
      "10k": null,
      "10mi": null,
      half: null,
    });
  });

  it("returns a 1mi best effort close to overall pace for an even-paced run", () => {
    const paceSecPerMile = 360;
    const samples: Array<[number, number]> = [];
    for (let meters = 0; meters <= 6000; meters += 1000) {
      samples.push([
        meters,
        (meters / BEST_EFFORT_DISTANCES_M["1mi"]) * paceSecPerMile,
      ]);
    }

    const efforts = computeBestEfforts(route(samples));

    expect(efforts["1mi"]).toBeCloseTo(paceSecPerMile, 2);
  });

  it.each([
    ["near-zero", 0.001],
    ["lower boundary", 180],
    ["upper boundary", 1200],
    ["over-limit", 1575.873],
  ])("returns null for a %s computed 1mi result", (_label, seconds) => {
    const efforts = computeBestEfforts(
      route([
        [0, 0],
        [BEST_EFFORT_DISTANCES_M["1mi"], seconds],
      ])
    );

    expect(efforts["1mi"]).toBeNull();
  });
});

describe("best-effort freshness basis", () => {
  it("attaches route completeness, point count, and the current algorithm version", () => {
    const points = route([
      [0, 0],
      [BEST_EFFORT_DISTANCES_M["1mi"], 500],
    ]);
    const persisted = withBestEffortsFreshness(
      computeBestEfforts(points),
      true,
      points.length
    );

    expect(persisted.computedFromRouteComplete).toBe(true);
    expect(persisted.computedFromPointCount).toBe(2);
    expect(persisted.computationVersion).toBe(
      BEST_EFFORTS_COMPUTATION_VERSION
    );
  });

  it("recomputes when bestEfforts is missing", () => {
    expect(shouldRecomputeBestEfforts(undefined, true)).toBe(true);
  });

  it("recomputes exactly when a previously partial route becomes complete", () => {
    const partial = withBestEffortsFreshness(
      computeBestEfforts([]),
      false,
      20
    );
    expect(shouldRecomputeBestEfforts(partial, false)).toBe(false);
    expect(shouldRecomputeBestEfforts(partial, true)).toBe(true);
  });

  it("recomputes stale versions but leaves a current complete basis alone", () => {
    const current = withBestEffortsFreshness(
      computeBestEfforts([]),
      true,
      10
    );
    expect(shouldRecomputeBestEfforts(current, true)).toBe(false);
    expect(
      shouldRecomputeBestEfforts(
        { ...current, computationVersion: BEST_EFFORTS_COMPUTATION_VERSION - 1 },
        true
      )
    ).toBe(true);
  });
});
