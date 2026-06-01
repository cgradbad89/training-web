import { describe, it, expect } from "vitest";
import { resolveShoeAssignment } from "../useResolvedShoeAssignment";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type RunningShoe } from "@/types/shoe";

// resolveShoeAssignment is the pure core of useResolvedShoeAssignment (the hook
// is a thin useMemo wrapper around it), so these tests exercise the full
// resolution + precedence logic without a React renderer.

function makeWorkout(id: string, miles = 5): HealthWorkout {
  return {
    workoutId: id,
    displayType: "Run",
    startDate: new Date("2026-05-15T12:00:00"),
    distanceMiles: miles,
    isRunLike: true,
  } as unknown as HealthWorkout;
}

// A shoe with an enabled "any-run" auto-assign rule → matches every run.
function makeShoeWithRule(id: string): RunningShoe {
  return {
    id,
    name: `Shoe ${id}`,
    brand: "Test",
    model: "Runner",
    startMileageOffset: 0,
    isRetired: false,
    addedAt: "2026-01-01",
    autoAssignRules: [
      { id: `${id}-r1`, shoeId: id, isEnabled: true, scope: "any" },
    ],
  } as RunningShoe;
}

const autoShoe = makeShoeWithRule("auto-shoe");

describe("resolveShoeAssignment", () => {
  it("returns the auto-assigned shoe when no manual assignment exists", () => {
    const workout = makeWorkout("w1");
    expect(resolveShoeAssignment(workout, [autoShoe], {})).toBe("auto-shoe");
  });

  it("manual shoe wins over the auto-assigned shoe", () => {
    const workout = makeWorkout("w1");
    const manualMap = { w1: "manual-shoe" };
    expect(resolveShoeAssignment(workout, [autoShoe], manualMap)).toBe(
      "manual-shoe"
    );
  });

  it("explicit manual null (\"no shoe\") wins over the auto-assigned shoe", () => {
    const workout = makeWorkout("w1");
    const manualMap = { w1: null };
    // The user deliberately removed the shoe — an auto-rule must NOT bring it back.
    expect(resolveShoeAssignment(workout, [autoShoe], manualMap)).toBeNull();
  });

  it("returns null when workout is null (safe call before data loads)", () => {
    expect(resolveShoeAssignment(null, [autoShoe], {})).toBeNull();
  });
});
