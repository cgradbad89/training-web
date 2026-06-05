import { describe, expect, it } from "vitest";
import { buildWorkoutPlanSummary } from "@/utils/workoutPlanSummary";
import {
  type WorkoutPlan,
  type PlannedWorkoutEntry,
  type WorkoutCategory,
} from "@/types/plan";

let idc = 0;
function entry(
  weekIndex: number,
  weekday: number,
  opts: {
    type?: "rest" | "workout";
    category?: WorkoutCategory;
    completed?: boolean;
  } = {}
): PlannedWorkoutEntry {
  return {
    id: `e${idc++}`,
    weekIndex,
    weekday,
    dayOfWeek: weekday - 1,
    type: opts.type ?? "workout",
    category: opts.category,
    completed: opts.completed,
  };
}

function plan(weeks: PlannedWorkoutEntry[][]): WorkoutPlan {
  return {
    id: "wp1",
    name: "Workout Plan",
    planType: "workout",
    startDate: "2026-01-19",
    status: "completed",
    isActive: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    weeks: weeks.map((entries, i) => ({ weekNumber: i + 1, entries })),
  };
}

describe("buildWorkoutPlanSummary", () => {
  it("counts totals; rest entries are excluded from planned", () => {
    const p = plan([
      [
        entry(0, 1, { category: "orangetheory", completed: true }),
        entry(0, 2, { category: "strength" }),
        entry(0, 3, { type: "rest" }),
      ],
    ]);
    const r = buildWorkoutPlanSummary(p);
    expect(r.totalPlanned).toBe(2); // rest excluded
    expect(r.totalCompleted).toBe(1);
  });

  it("counts OT and Pilates planned vs completed by category", () => {
    const p = plan([
      [
        entry(0, 1, { category: "orangetheory", completed: true }),
        entry(0, 2, { category: "orangetheory" }),
        entry(0, 3, { category: "pilates", completed: true }),
        entry(0, 4, { category: "pilates", completed: true }),
      ],
    ]);
    const r = buildWorkoutPlanSummary(p);
    expect(r.otPlanned).toBe(2);
    expect(r.otCompleted).toBe(1);
    expect(r.pilatesPlanned).toBe(2);
    expect(r.pilatesCompleted).toBe(2);
  });

  it("buckets non-rest entries with NO category as uncategorized", () => {
    const p = plan([
      [
        entry(0, 1, { completed: true }), // no category, completed
        entry(0, 2, {}), // no category, not completed
        entry(0, 3, { category: "cycling" }), // categorized → not uncategorized
      ],
    ]);
    const r = buildWorkoutPlanSummary(p);
    expect(r.uncategorizedPlanned).toBe(2);
    expect(r.uncategorizedCompleted).toBe(1);
    // cycling is a session but neither OT/Pilates/uncategorized
    expect(r.totalPlanned).toBe(3);
    expect(r.otPlanned).toBe(0);
    expect(r.pilatesPlanned).toBe(0);
  });

  it("produces per-week planned/completed session arrays", () => {
    const p = plan([
      [
        entry(0, 1, { category: "strength", completed: true }),
        entry(0, 2, { category: "strength" }),
        entry(0, 7, { type: "rest" }),
      ],
      [entry(1, 1, { category: "hiit", completed: true })],
    ]);
    const r = buildWorkoutPlanSummary(p);
    expect(r.weeks).toHaveLength(2);
    expect(r.weeks[0]).toMatchObject({
      weekNumber: 1,
      label: "W1",
      plannedSessions: 2, // rest excluded
      completedSessions: 1,
    });
    expect(r.weeks[1]).toMatchObject({
      weekNumber: 2,
      plannedSessions: 1,
      completedSessions: 1,
    });
  });

  it("handles an empty plan (no weeks) → all zeros", () => {
    const r = buildWorkoutPlanSummary(plan([]));
    expect(r).toMatchObject({
      totalPlanned: 0,
      totalCompleted: 0,
      otPlanned: 0,
      otCompleted: 0,
      pilatesPlanned: 0,
      pilatesCompleted: 0,
      uncategorizedPlanned: 0,
      uncategorizedCompleted: 0,
      weeks: [],
    });
  });

  it("a week of only rest entries contributes zero sessions", () => {
    const r = buildWorkoutPlanSummary(
      plan([[entry(0, 1, { type: "rest" }), entry(0, 2, { type: "rest" })]])
    );
    expect(r.totalPlanned).toBe(0);
    expect(r.weeks[0].plannedSessions).toBe(0);
  });
});
