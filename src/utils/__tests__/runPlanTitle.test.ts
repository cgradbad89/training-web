import { describe, it, expect } from "vitest";
import {
  buildRunTitleMap,
  findActiveRunningPlan,
} from "@/utils/runPlanTitle";
import { type RunningPlan, type WorkoutPlan, type PlannedRunEntry } from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function runEntry(partial: Partial<PlannedRunEntry>): PlannedRunEntry {
  return {
    id: "e1",
    weekIndex: 0,
    weekday: 1, // Monday → plan.startDate itself
    dayOfWeek: 0,
    distanceMiles: 8,
    ...partial,
  };
}

function runningPlan(entries: PlannedRunEntry[], status: RunningPlan["status"] = "active"): RunningPlan {
  return {
    id: "plan-run",
    name: "Marathon Build",
    planType: "running",
    startDate: "2026-06-01", // a Monday
    weeks: [{ weekNumber: 1, entries }],
    status,
    isActive: status === "active",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

function workout(partial: Partial<HealthWorkout> & { workoutId: string }): HealthWorkout {
  // Run startDate uses UTC NOON so its toISOString() date is stable across test
  // timezones and lines up with the entry's locally-derived calendar date.
  return {
    name: "Run",
    activityType: "running",
    displayType: "Run",
    startDate: new Date("2026-06-01T12:00:00Z"),
    endDate: new Date("2026-06-01T13:00:00Z"),
    durationSeconds: 3600,
    sourceName: "test",
    isRunLike: true,
    hasRoute: false,
    syncedAt: new Date("2026-06-01T13:05:00Z"),
    calories: 800,
    avgHeartRate: 150,
    distanceMiles: 8,
    distanceMeters: 12875,
    avgPaceSecPerMile: 450,
    avgSpeedMPS: 3.5,
    hrDriftPct: null,
    cadenceSPM: null,
    efficiencyRaw: null,
    efficiencyScore: null,
    elevationGainM: null,
    ...partial,
  };
}

// ── buildRunTitleMap ────────────────────────────────────────────────────────

describe("buildRunTitleMap", () => {
  it("inverts the match to workoutId → { label, planned distance } for the right entry", () => {
    const plan = runningPlan([runEntry({ id: "e1", runType: "longRun", distanceMiles: 8 })]);
    const run = workout({ workoutId: "run-1", distanceMiles: 8 });

    const map = buildRunTitleMap(plan, [run]);

    expect(map.get("run-1")).toEqual({ label: "Long Run", distanceMiles: 8 });
  });

  it("uses the entry description as the label when present", () => {
    const plan = runningPlan([
      runEntry({ id: "e1", description: "Marathon-pace finish", distanceMiles: 8 }),
    ]);
    const run = workout({ workoutId: "run-1", distanceMiles: 8 });

    expect(buildRunTitleMap(plan, [run]).get("run-1")?.label).toBe(
      "Marathon-pace finish"
    );
  });

  it("returns an empty map when there is no active plan (no throw)", () => {
    const run = workout({ workoutId: "run-1" });
    expect(buildRunTitleMap(null, [run]).size).toBe(0);
    expect(buildRunTitleMap(undefined, [run]).size).toBe(0);
  });

  it("never labels a non-run workout (matcher filters isRunLike)", () => {
    const plan = runningPlan([runEntry({ id: "e1", distanceMiles: 8 })]);
    const strength = workout({
      workoutId: "w-1",
      isRunLike: false,
      activityType: "traditional_strength_training",
      displayType: "Strength",
    });

    const map = buildRunTitleMap(plan, [strength]);
    expect(map.size).toBe(0);
    expect(map.get("w-1")).toBeUndefined();
  });

  it("does not label a run that matches no entry (wrong date)", () => {
    const plan = runningPlan([runEntry({ id: "e1", distanceMiles: 8 })]);
    const farRun = workout({
      workoutId: "run-far",
      startDate: new Date("2026-08-15T12:00:00Z"),
    });

    expect(buildRunTitleMap(plan, [farRun]).get("run-far")).toBeUndefined();
  });
});

// ── findActiveRunningPlan ─────────────────────────────────────────────────────

describe("findActiveRunningPlan", () => {
  const workoutPlan: WorkoutPlan = {
    id: "plan-wk",
    name: "Strength block",
    planType: "workout",
    startDate: "2026-06-01",
    weeks: [],
    status: "active",
    isActive: true,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };

  it("returns the single active running plan, ignoring drafts and workout plans", () => {
    const draft = runningPlan([], "draft");
    const active = { ...runningPlan([]), id: "active-run" };
    const found = findActiveRunningPlan([workoutPlan, draft, active]);
    expect(found?.id).toBe("active-run");
  });

  it("returns null when no running plan is active", () => {
    expect(findActiveRunningPlan([workoutPlan, runningPlan([], "completed")])).toBeNull();
    expect(findActiveRunningPlan([])).toBeNull();
  });
});
