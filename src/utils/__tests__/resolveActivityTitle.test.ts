import { describe, it, expect } from "vitest";
import {
  resolveActivityTitle,
  buildRunEntryLabel,
  friendlyWorkoutLabel,
} from "@/utils/resolveActivityTitle";
import { type PlannedRunEntry } from "@/types/plan";

function entry(partial: Partial<PlannedRunEntry>): PlannedRunEntry {
  return {
    id: "e1",
    weekIndex: 0,
    weekday: 1,
    dayOfWeek: 0,
    distanceMiles: 5,
    ...partial,
  };
}

describe("resolveActivityTitle — priority chain", () => {
  // ── Priority 1: plan-entry label ──────────────────────────────────────────
  it("1. a digit-free plan label is prefixed with the run's rounded distance", () => {
    expect(
      resolveActivityTitle({
        activityType: "Run",
        matchedPlanEntry: { label: "Long Run", distanceMiles: 8 },
        distanceMiles: 8.01,
      })
    ).toBe("8mi Long Run");
  });

  it("1. a label that already carries a number is used verbatim (no double distance)", () => {
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

  it("1. falls back to the planned distance when the run has no usable distance", () => {
    expect(
      resolveActivityTitle({
        activityType: "Run",
        matchedPlanEntry: { label: "Tempo", distanceMiles: 6 },
      })
    ).toBe("6mi Tempo");
  });

  it("1. an empty/whitespace plan-entry label falls through to the next level", () => {
    expect(
      resolveActivityTitle({
        activityType: "Run",
        matchedPlanEntry: { label: "   " },
        distanceMiles: 9,
      })
    ).toBe("9mi Run");
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
  it("3. route distance with no name → '{n}mi route' (default shape)", () => {
    expect(
      resolveActivityTitle({
        activityType: "Run",
        routeCluster: { distanceMiles: 9 },
        distanceMiles: 9,
      })
    ).toBe("9mi route");
  });

  it("3. route distance with isLoop=true → '{n}mi loop' (rounded)", () => {
    expect(
      resolveActivityTitle({
        activityType: "Run",
        routeCluster: { distanceMiles: 2.2, isLoop: true },
      })
    ).toBe("2mi loop");
  });

  it("3. a route cluster with no name and no usable distance falls through", () => {
    expect(
      resolveActivityTitle({
        activityType: "Run",
        routeCluster: { distanceMiles: 0 },
        distanceMiles: 4,
      })
    ).toBe("4mi Run");
  });

  // ── Priority 4: workout friendly label (raw activityType) ─────────────────
  it("4. maps a raw HK activityType to its friendly category label", () => {
    expect(
      resolveActivityTitle({
        activityType: "Traditional Strength Training",
        rawActivityType: "traditional_strength_training",
      })
    ).toBe("Strength Training");
    expect(
      resolveActivityTitle({
        activityType: "Workout",
        rawActivityType: "high_intensity_interval_training",
      })
    ).toBe("HIIT");
    expect(
      resolveActivityTitle({ activityType: "Workout", rawActivityType: "pilates" })
    ).toBe("Pilates");
  });

  it("4. an unmapped raw activityType falls back to the displayType (graceful)", () => {
    expect(
      resolveActivityTitle({
        activityType: "Mixed Cardio",
        rawActivityType: "mixed_cardio",
      })
    ).toBe("Mixed Cardio");
  });

  it("4. a workoutOverride still wins — overridden displayType is shown verbatim", () => {
    // applyOverride sets BOTH displayType and a derived activityType; an
    // override like "Treadmill" does not map to a category, so the override
    // value is what renders.
    expect(
      resolveActivityTitle({
        activityType: "Treadmill",
        rawActivityType: "treadmill",
      })
    ).toBe("Treadmill");
  });

  // ── Priority 4b: known non-generic displayType (no raw type) ──────────────
  it("4b. a known non-generic type is used as-is when no raw type is given", () => {
    expect(resolveActivityTitle({ activityType: "Strength" })).toBe("Strength");
    expect(resolveActivityTitle({ activityType: "Yoga" })).toBe("Yoga");
  });

  it("4b. workout types pass through unchanged even WITH a distance", () => {
    expect(
      resolveActivityTitle({ activityType: "Pilates", distanceMiles: 1.2 })
    ).toBe("Pilates");
  });

  // ── Priority 5: generic type + distance (rounded) ─────────────────────────
  it("5. generic 'Run' + distance → '{n}mi Run' (rounded)", () => {
    expect(
      resolveActivityTitle({ activityType: "Run", distanceMiles: 3.1 })
    ).toBe("3mi Run");
  });

  it("5. distance rounds to the nearest whole mile", () => {
    expect(resolveActivityTitle({ activityType: "Run", distanceMiles: 8.01 })).toBe("8mi Run");
    expect(resolveActivityTitle({ activityType: "Run", distanceMiles: 4.4 })).toBe("4mi Run");
    expect(resolveActivityTitle({ activityType: "Run", distanceMiles: 9.01 })).toBe("9mi Run");
    // Boundary: 0.5 rounds up (Math.round) → "1mi".
    expect(resolveActivityTitle({ activityType: "Run", distanceMiles: 0.5 })).toBe("1mi Run");
  });

  it("5. generic is case-insensitive", () => {
    expect(
      resolveActivityTitle({ activityType: "run", distanceMiles: 9 })
    ).toBe("9mi run");
    expect(
      resolveActivityTitle({ activityType: "Workout", distanceMiles: 3.14159 })
    ).toBe("3mi Workout");
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
    ).toBe("6mi Run");
  });
});

describe("buildRunEntryLabel", () => {
  it("uses an authored description when present", () => {
    expect(buildRunEntryLabel(entry({ description: "Hill repeats" }))).toBe(
      "Hill repeats"
    );
  });

  it("maps each run-type to its friendly label", () => {
    expect(buildRunEntryLabel(entry({ runType: "longRun" }))).toBe("Long Run");
    expect(buildRunEntryLabel(entry({ runType: "otf" }))).toBe("OTF");
    expect(buildRunEntryLabel(entry({ runType: "outdoor" }))).toBe("Outdoor");
    expect(buildRunEntryLabel(entry({ runType: "treadmill" }))).toBe("Treadmill");
  });

  it("prefers description over run-type", () => {
    expect(
      buildRunEntryLabel(entry({ description: "Easy shakeout", runType: "longRun" }))
    ).toBe("Easy shakeout");
  });

  it("falls back to 'Run' when there is neither description nor run-type", () => {
    expect(buildRunEntryLabel(entry({}))).toBe("Run");
    expect(buildRunEntryLabel(entry({ description: "   " }))).toBe("Run");
  });
});

describe("friendlyWorkoutLabel", () => {
  it("maps snake_case and camelCase HK types to the same category label", () => {
    expect(friendlyWorkoutLabel("traditional_strength_training")).toBe(
      "Strength Training"
    );
    expect(friendlyWorkoutLabel("functionalStrengthTraining")).toBe(
      "Strength Training"
    );
    expect(friendlyWorkoutLabel("cross_training")).toBe("HIIT");
    expect(friendlyWorkoutLabel("cycling")).toBe("Cycling");
    expect(friendlyWorkoutLabel("yoga")).toBe("Yoga");
  });

  it("returns null for unmapped or empty types (graceful fallback)", () => {
    expect(friendlyWorkoutLabel("mixed_cardio")).toBeNull();
    expect(friendlyWorkoutLabel("running")).toBeNull();
    expect(friendlyWorkoutLabel(undefined)).toBeNull();
    expect(friendlyWorkoutLabel(null)).toBeNull();
    expect(friendlyWorkoutLabel("")).toBeNull();
  });

  it("does not derive Orangetheory from any raw type (OTF has no HK mapping)", () => {
    expect(friendlyWorkoutLabel("orangetheory")).toBeNull();
  });
});
