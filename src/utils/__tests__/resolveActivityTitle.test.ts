import { describe, it, expect } from "vitest";
import { resolveActivityTitle } from "@/utils/resolveActivityTitle";

describe("resolveActivityTitle — priority chain", () => {
  // ── Priority 1: plan-entry label ──────────────────────────────────────────
  it("1. uses the plan-entry label verbatim when present", () => {
    expect(
      resolveActivityTitle({
        activityType: "Run",
        matchedPlanEntry: { label: "2 easy + 3 @ tempo" },
        distanceMiles: 5,
      })
    ).toBe("2 easy + 3 @ tempo");
  });

  it("1. plan-entry label beats route name, route distance, and type+distance", () => {
    expect(
      resolveActivityTitle({
        activityType: "Run",
        matchedPlanEntry: { label: "9 miles easy" },
        routeCluster: { name: "Alexandria Loop", distanceMiles: 9 },
        distanceMiles: 9,
      })
    ).toBe("9 miles easy");
  });

  it("1. an empty/whitespace plan-entry label falls through to the next level", () => {
    expect(
      resolveActivityTitle({
        activityType: "Run",
        matchedPlanEntry: { label: "   " },
        distanceMiles: 9,
      })
    ).toBe("9.0 mi Run");
  });

  // ── Priority 2: route-cluster name ────────────────────────────────────────
  it("2. uses the route-cluster name when present", () => {
    expect(
      resolveActivityTitle({
        activityType: "Run",
        routeCluster: { name: "Alexandria 9.0 mi route", distanceMiles: 9 },
        distanceMiles: 9,
      })
    ).toBe("Alexandria 9.0 mi route");
  });

  // ── Priority 3: route-cluster distance (no name) ──────────────────────────
  it("3. route distance with no name → '{X.X} mi route' (default shape)", () => {
    expect(
      resolveActivityTitle({
        activityType: "Run",
        routeCluster: { distanceMiles: 9 },
        distanceMiles: 9,
      })
    ).toBe("9.0 mi route");
  });

  it("3. route distance with isLoop=true → '{X.X} mi loop'", () => {
    expect(
      resolveActivityTitle({
        activityType: "Run",
        routeCluster: { distanceMiles: 2.2, isLoop: true },
      })
    ).toBe("2.2 mi loop");
  });

  it("3. a route cluster with no name and no usable distance falls through", () => {
    expect(
      resolveActivityTitle({
        activityType: "Run",
        routeCluster: { distanceMiles: 0 },
        distanceMiles: 4,
      })
    ).toBe("4.0 mi Run");
  });

  // ── Priority 4: known non-generic (descriptive) type ──────────────────────
  it("4. a known non-generic type is used as-is", () => {
    expect(resolveActivityTitle({ activityType: "Strength" })).toBe("Strength");
    expect(resolveActivityTitle({ activityType: "Yoga" })).toBe("Yoga");
  });

  it("4. workout types pass through unchanged even WITH a distance", () => {
    expect(
      resolveActivityTitle({ activityType: "Pilates", distanceMiles: 1.2 })
    ).toBe("Pilates");
  });

  // ── Priority 5: generic type + distance ───────────────────────────────────
  it("5. generic 'Run' + distance → '{X.X} mi Run'", () => {
    expect(
      resolveActivityTitle({ activityType: "Run", distanceMiles: 3.1 })
    ).toBe("3.1 mi Run");
  });

  it("5. generic is case-insensitive and distance is formatted to 1 dp", () => {
    expect(
      resolveActivityTitle({ activityType: "run", distanceMiles: 9 })
    ).toBe("9.0 mi run");
    expect(
      resolveActivityTitle({ activityType: "Workout", distanceMiles: 3.14159 })
    ).toBe("3.1 mi Workout");
  });

  // ── Priority 6: generic type only ─────────────────────────────────────────
  it("6. generic type with no distance → type as-is", () => {
    expect(resolveActivityTitle({ activityType: "Run" })).toBe("Run");
  });

  it("6. zero/negative distance is ignored → bare generic type", () => {
    expect(
      resolveActivityTitle({ activityType: "Run", distanceMiles: 0 })
    ).toBe("Run");
    expect(
      resolveActivityTitle({ activityType: "Run", distanceMiles: -2 })
    ).toBe("Run");
  });

  // ── Null inputs fall through cleanly ──────────────────────────────────────
  it("null plan entry and null route cluster fall through to type+distance", () => {
    expect(
      resolveActivityTitle({
        activityType: "Run",
        matchedPlanEntry: null,
        routeCluster: null,
        distanceMiles: 6.2,
      })
    ).toBe("6.2 mi Run");
  });
});
