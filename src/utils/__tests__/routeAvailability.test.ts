import { describe, it, expect } from "vitest";
import {
  MIN_ROUTE_POINTS,
  isRoutePresent,
  deriveEffectiveHasRoute,
  isRouteSyncing,
} from "../routeAvailability";

describe("isRoutePresent", () => {
  it("requires at least MIN_ROUTE_POINTS (2) points", () => {
    expect(MIN_ROUTE_POINTS).toBe(2);
    expect(isRoutePresent(0)).toBe(false);
    expect(isRoutePresent(1)).toBe(false);
    expect(isRoutePresent(2)).toBe(true);
    expect(isRoutePresent(500)).toBe(true);
  });
});

describe("deriveEffectiveHasRoute — falsely-flagged run (iOS headless-sync race)", () => {
  it("Scenario 1: hasRoute=false but route read returns >=2 points → routed (map/splits on)", () => {
    expect(deriveEffectiveHasRoute(false, 2)).toBe(true);
    expect(deriveEffectiveHasRoute(false, 350)).toBe(true);
    // The same data signal gates fetching the dependent subcollections.
    expect(isRoutePresent(350)).toBe(true);
  });

  it("Scenario 2: hasRoute=false and route read returns 0 (or <2) points → no-route, no crash", () => {
    expect(deriveEffectiveHasRoute(false, 0)).toBe(false);
    expect(deriveEffectiveHasRoute(false, 1)).toBe(false);
    expect(isRoutePresent(0)).toBe(false);
    expect(isRoutePresent(1)).toBe(false);
  });
});

describe("deriveEffectiveHasRoute — existing behavior preserved", () => {
  it("Scenario 3: hasRoute=true is routed regardless of points (unchanged)", () => {
    expect(deriveEffectiveHasRoute(true, 0)).toBe(true);
    expect(deriveEffectiveHasRoute(true, 1)).toBe(true);
    expect(deriveEffectiveHasRoute(true, 999)).toBe(true);
  });

  it("genuinely route-less workout (flag false, no points) stays no-route", () => {
    expect(deriveEffectiveHasRoute(false, 0)).toBe(false);
  });
});

describe("isRouteSyncing — routeComplete display hint (never gates rendering)", () => {
  it("only routeComplete === false flags syncing; true/absent do not", () => {
    expect(isRouteSyncing(false)).toBe(true);
    expect(isRouteSyncing(true)).toBe(false);
    expect(isRouteSyncing(undefined)).toBe(false); // legacy doc → treated complete
  });

  it("a partial route (routeComplete=false) with >=2 points still renders as routed", () => {
    // Availability is derived from the data and is independent of routeComplete:
    // the hint may show, but the run is routed and the points render.
    const points = 120;
    expect(deriveEffectiveHasRoute(false, points)).toBe(true);
    expect(isRoutePresent(points)).toBe(true);
    expect(isRouteSyncing(false)).toBe(true); // hint shows, render still on
  });
});
