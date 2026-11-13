import { describe, it, expect } from "vitest";
import { matchPlanToActual } from "@/utils/planMatching";
import type { RunningPlan, PlannedRunEntry } from "@/types/plan";
import type { HealthWorkout } from "@/types/healthWorkout";

function entry(id: string, weekIndex: number, weekday: number, miles: number): PlannedRunEntry {
  return { id, weekIndex, weekday, dayOfWeek: weekday - 1, distanceMiles: miles, runType: "easy" };
}
function planOf(startDate: string, weeks: PlannedRunEntry[][]): RunningPlan {
  return {
    id: "p", name: "t", startDate,
    weeks: weeks.map((entries, i) => ({ weekNumber: i + 1, entries })),
    status: "active", isActive: true, createdAt: "", updatedAt: "",
  } as RunningPlan;
}
function runAt(id: string, y: number, m: number, d: number, miles: number): HealthWorkout {
  const start = new Date(y, m, d, 8, 0);
  return {
    workoutId: id, name: "Run", displayType: "Run", activityType: "HKWorkoutActivityTypeRunning",
    startDate: start, endDate: new Date(start.getTime() + 3600_000), durationSeconds: 3600,
    distanceMiles: miles, isRunLike: true, sourceName: "Watch", calories: 500,
  } as unknown as HealthWorkout;
}

describe("plan matching across ISO 2026-W53 → 2027-W01", () => {
  it("run Sun 2027-01-03: the Sat 01-02 (same week) entry wins over Mon 01-04 (next week)", () => {
    // Mon 2026-12-28 start: Sat 01-02 = week 0 / weekday 6; Mon 01-04 = week 1 / weekday 1.
    const plan = planOf("2026-12-28", [[entry("sat", 0, 6, 3)], [entry("mon", 1, 1, 6)]]);
    const m = matchPlanToActual(plan, [runAt("r", 2027, 0, 3, 6)]);
    expect(m.get("sat")).not.toBeNull();
    expect(m.get("mon")).toBeNull();
  });

  it("run Mon 2027-01-04: the previous-week Sun 01-03 entry stays eligible (closer distance wins the tie)", () => {
    const plan = planOf("2026-12-28", [[entry("sun", 0, 7, 6)], [entry("tue", 1, 2, 3)]]);
    const m = matchPlanToActual(plan, [runAt("r", 2027, 0, 4, 6)]);
    expect(m.get("sun")).not.toBeNull();
    expect(m.get("tue")).toBeNull();
  });

  it("mid-year control (June 2026) keeps the same outcome as case 1", () => {
    const plan = planOf("2026-06-01", [[entry("sat", 0, 6, 3)], [entry("mon", 1, 1, 6)]]);
    const m = matchPlanToActual(plan, [runAt("r", 2026, 5, 7, 6)]);
    expect(m.get("sat")).not.toBeNull();
    expect(m.get("mon")).toBeNull();
  });

  it("mid-year control for case 2 keeps the previous-week entry eligible", () => {
    const plan = planOf("2026-06-01", [[entry("sun", 0, 7, 6)], [entry("tue", 1, 2, 3)]]);
    const m = matchPlanToActual(plan, [runAt("r", 2026, 5, 8, 6)]);
    expect(m.get("sun")).not.toBeNull();
    expect(m.get("tue")).toBeNull();
  });

  it("year-start W01 → W02 (2026-W01 begins Mon 2025-12-29) behaves like mid-year", () => {
    const plan = planOf("2025-12-29", [[entry("sat", 0, 6, 3)], [entry("mon", 1, 1, 6)]]);
    const m = matchPlanToActual(plan, [runAt("r", 2026, 0, 4, 6)]); // Sun 2026-01-04
    expect(m.get("sat")).not.toBeNull();
    expect(m.get("mon")).toBeNull();
  });
});
