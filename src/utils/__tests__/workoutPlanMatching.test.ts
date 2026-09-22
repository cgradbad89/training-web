import { describe, expect, it } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { PlannedWorkoutEntry, WorkoutPlan } from "@/types/plan";
import {
  matchWorkoutPlanSessions, resolveCalendarWorkoutAssociations,
} from "@/utils/workoutPlanMatching";

const baseDate = new Date(2026, 0, 19, 9);
const today = new Date(2026, 0, 20, 12);
function workout(id: string, hour = 9, activityType = "traditionalStrengthTraining"): HealthWorkout {
  return {
    workoutId: id, startDate: new Date(2026, 0, 19, hour),
    activityType, displayType: "Workout", isRunLike: false,
  } as HealthWorkout;
}
function entry(id: string, patch: Partial<PlannedWorkoutEntry> = {}): PlannedWorkoutEntry {
  return { id, weekIndex: 0, weekday: 1, dayOfWeek: 0, type: "workout",
    category: "strength", ...patch };
}
function plan(entries: PlannedWorkoutEntry[], patch: Partial<WorkoutPlan> = {}): WorkoutPlan {
  return { id: "p1", name: "Plan", planType: "workout", startDate: "2026-01-19",
    status: "active", isActive: true, createdAt: "", updatedAt: "",
    weeks: [{ weekNumber: 1, entries }], ...patch };
}

const assign = (entries: PlannedWorkoutEntry[], workouts: HealthWorkout[]) =>
  matchWorkoutPlanSessions([plan(entries)], workouts, today);
const resolve = (entries: PlannedWorkoutEntry[], workouts: HealthWorkout[]) =>
  resolveCalendarWorkoutAssociations([plan(entries)], workouts);

describe("matchWorkoutPlanSessions", () => {
  it("matches one same-local-day workout", () => {
    expect(assign([entry("e1")], [workout("w1")])).toMatchObject([
      { planId: "p1", entryId: "e1", workout: { workoutId: "w1" } },
    ]);
  });
  it("uses the local date rather than the UTC date", () => {
    const late = workout("late", 23);
    expect(assign([entry("e1")], [late])).toHaveLength(1);
  });
  it("consumes candidates in chronological order", () => {
    expect(assign([entry("e1")], [workout("later", 16), workout("earlier", 8)])[0].workout.workoutId).toBe("earlier");
  });
  it("uses a workout at most once", () => {
    expect(assign([entry("e1"), entry("e2")], [workout("w1")])).toHaveLength(1);
  });
  it("assigns distinct workouts to two sessions", () => {
    expect(assign([entry("e1"), entry("e2")], [workout("w1"), workout("w2", 10)]).map((a) => a.workout.workoutId)).toEqual(["w1", "w2"]);
  });
  it("rejects a category mismatch", () => {
    expect(assign([entry("e1")], [workout("yoga", 9, "yoga")])).toHaveLength(0);
  });
  it("preserves the legacy duration-only predicate", () => {
    const legacy = entry("e1", { category: undefined, exercises: [], duration_mins: 45 });
    expect(assign([legacy], [workout("yoga", 9, "yoga")])).toHaveLength(1);
    expect(assign([legacy], [workout("strength")])).toHaveLength(0);
  });
  it("matches strict categories before OTF claims leftovers", () => {
    const matches = assign([entry("otf", { category: "orangetheory" }), entry("strength")],
      [workout("strength-1"), workout("yoga-1", 10, "yoga")]);
    expect(matches.map((a) => [a.entryId, a.workout.workoutId])).toEqual([
      ["strength", "strength-1"], ["otf", "yoga-1"],
    ]);
  });
  it("skips future sessions", () => {
    expect(matchWorkoutPlanSessions([plan([entry("future", { weekday: 7 })])], [workout("w1")], baseDate)).toHaveLength(0);
  });
  it("skips completed sessions", () => {
    expect(assign([entry("done", { completed: true })], [workout("w1")])).toHaveLength(0);
  });
});

describe("resolveCalendarWorkoutAssociations", () => {
  it("uses a durable matchedWorkoutId even when the timestamp differs", () => {
    const result = resolve([entry("e1", { completed: true, completedAt: "manual", matchedWorkoutId: "w1" })], [workout("w1")]);
    expect(result.matchedWorkoutIds.has("w1")).toBe(true);
    expect(result.matchedByEntryId.get("e1")?.workoutId).toBe("w1");
  });
  it("associates a unique exact legacy completion", () => {
    const w = workout("w1");
    expect(resolve([entry("e1", { completed: true, completedAt: w.startDate.toISOString() })], [w]).matchedWorkoutIds.has("w1")).toBe(true);
  });
  it("keeps duplicate exact historical candidates unresolved", () => {
    const w = workout("w1");
    const result = resolve([entry("e1", { completed: true, completedAt: w.startDate.toISOString() })], [w, workout("w2")]);
    expect(result.unresolvedEntryIds.has("e1")).toBe(true);
    expect(result.matchedWorkoutIds.size).toBe(0);
  });
  it("does not infer a workout from a manual-looking timestamp", () => {
    const result = resolve([entry("e1", { completed: true, completedAt: new Date(2026, 0, 19, 11).toISOString() })], [workout("w1")]);
    expect(result.unresolvedEntryIds.has("e1")).toBe(true);
  });
  it("does not associate an exact timestamp on a different planned local day", () => {
    const nextDay = { ...workout("w1"), startDate: new Date(2026, 0, 20, 9) };
    const result = resolve([entry("e1", { completed: true, completedAt: nextDay.startDate.toISOString() })], [nextDay]);
    expect(result.unresolvedEntryIds.has("e1")).toBe(true);
    expect(result.matchedWorkoutIds.size).toBe(0);
  });
  it("keeps two entries competing for one exact workout unresolved", () => {
    const w = workout("w1");
    const completedAt = w.startDate.toISOString();
    const result = resolve([entry("e1", { completed: true, completedAt }), entry("e2", { completed: true, completedAt })], [w]);
    expect(result.unresolvedEntryIds).toEqual(new Set(["e1", "e2"]));
    expect(result.matchedWorkoutIds.size).toBe(0);
  });
  it("leaves unresolved workouts unconsumed", () => {
    const result = resolve([entry("e1", { completed: true })], [workout("w1")]);
    expect(result.unresolvedEntryIds.has("e1")).toBe(true);
    expect(result.matchedWorkoutIds.size).toBe(0);
  });
  it("ignores inactive workout plans", () => {
    const w = workout("w1");
    const result = resolveCalendarWorkoutAssociations([plan([entry("e1", { completed: true, matchedWorkoutId: "w1" })], { status: "draft" })], [w]);
    expect(result.matchedWorkoutIds.size).toBe(0);
  });
});
