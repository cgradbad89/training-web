import { describe, expect, it } from "vitest";
import { ruleMatchesRun } from "@/utils/shoeAutoAssign";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { ShoeAutoAssignRule } from "@/types/shoe";

const rule: ShoeAutoAssignRule = {
  id: "rule-1",
  scope: "any",
  isEnabled: true,
  startDate: "2026-08-29",
  endDate: "2026-08-31",
};

function runAt(year: number, month: number, day: number, hour = 12): HealthWorkout {
  return {
    workoutId: `${year}-${month}-${day}-${hour}`,
    displayType: "Outdoor Run",
    activityType: "running",
    isRunLike: true,
    distanceMiles: 5,
    startDate: new Date(year, month - 1, day, hour),
  } as HealthWorkout;
}

describe("shoe rule local date-only boundaries", () => {
  it("includes the full local start and end dates", () => {
    expect(ruleMatchesRun(rule, runAt(2026, 8, 29, 0))).toBe(true);
    expect(ruleMatchesRun(rule, runAt(2026, 8, 31, 23))).toBe(true);
  });

  it("excludes the local dates immediately outside the range", () => {
    expect(ruleMatchesRun(rule, runAt(2026, 8, 28, 23))).toBe(false);
    expect(ruleMatchesRun(rule, runAt(2026, 9, 1, 0))).toBe(false);
  });
});
