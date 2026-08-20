import { describe, it, expect, beforeEach, vi } from "vitest";
import { autoMatchCrossTrainingSessions } from "@/services/autoMatch";
import { type Plan, type WorkoutPlan } from "@/types/plan";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type WorkoutOverride } from "@/types/workoutOverride";

const h = vi.hoisted(() => ({ updatePlan: vi.fn() }));
vi.mock("@/services/plans", () => ({ updatePlan: h.updatePlan }));

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Yesterday, so the session date is never in the future (matcher skips those). */
function yesterday(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

/** A one-week workout plan whose only session lands on `date`'s weekday. */
function workoutPlan(date: Date): WorkoutPlan {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  // startDate === the session date, weekIndex 0 / weekday 1 → offset 0 days.
  return {
    id: "wp1",
    name: "Strength Block",
    planType: "workout",
    startDate: `${y}-${m}-${d}`,
    status: "active",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    weeks: [
      {
        weekNumber: 1,
        entries: [
          {
            id: "s1",
            weekIndex: 0,
            weekday: 1,
            dayOfWeek: 0,
            type: "workout",
            label: "Upper Body",
            category: "strength",
            exercises: [],
          },
        ],
      },
    ],
  };
}

function strengthWorkout(date: Date, id: string): HealthWorkout {
  return {
    workoutId: id,
    isRunLike: false,
    activityType: "traditionalStrengthTraining",
    startDate: date,
    distanceMiles: 0,
    durationSeconds: 2400,
  } as unknown as HealthWorkout;
}

function excluded(workoutId: string): WorkoutOverride {
  return {
    workoutId,
    userId: "u1",
    isExcluded: true,
    excludedAt: "2026-01-20T00:00:00.000Z",
    excludedReason: "duplicate",
    distanceMilesOverride: null,
    durationSecondsOverride: null,
    runTypeOverride: null,
    updatedAt: "2026-01-20T00:00:00.000Z",
  };
}

function sessionOf(plans: Plan[]) {
  const plan = plans[0] as WorkoutPlan;
  return plan.weeks[0].entries[0];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("autoMatchCrossTrainingSessions — excluded workouts never write completion", () => {
  beforeEach(() => {
    h.updatePlan.mockReset();
    h.updatePlan.mockResolvedValue(undefined);
  });

  it("marks the session completed when the workout is NOT excluded (control)", async () => {
    const date = yesterday();
    const { plans, result } = await autoMatchCrossTrainingSessions(
      "u1",
      [workoutPlan(date)],
      [strengthWorkout(date, "w1")],
      {}
    );

    expect(result.matched).toBe(1);
    expect(result.updatedPlanIds).toEqual(["wp1"]);
    expect(sessionOf(plans).completed).toBe(true);
    expect(h.updatePlan).toHaveBeenCalledTimes(1);
  });

  it("does NOT mark completed — and writes nothing — when the workout is excluded", async () => {
    const date = yesterday();
    const { plans, result } = await autoMatchCrossTrainingSessions(
      "u1",
      [workoutPlan(date)],
      [strengthWorkout(date, "w1")],
      { w1: excluded("w1") }
    );

    expect(result.matched).toBe(0);
    expect(result.updatedPlanIds).toEqual([]);
    expect(sessionOf(plans).completed).toBeUndefined();
    expect(h.updatePlan).not.toHaveBeenCalled();
  });

  it("falls through to a non-excluded same-day workout instead of writing nothing", async () => {
    const date = yesterday();
    const later = new Date(date.getTime() + 60 * 60 * 1000);
    const { plans, result } = await autoMatchCrossTrainingSessions(
      "u1",
      [workoutPlan(date)],
      [strengthWorkout(date, "w1"), strengthWorkout(later, "w2")],
      { w1: excluded("w1") }
    );

    expect(result.matched).toBe(1);
    expect(sessionOf(plans).completed).toBe(true);
    // completedAt comes from the surviving (non-excluded) workout.
    expect(sessionOf(plans).completedAt).toBe(later.toISOString());
  });

  it("omitting the overrides argument preserves the pre-existing behaviour", async () => {
    const date = yesterday();
    const { result } = await autoMatchCrossTrainingSessions(
      "u1",
      [workoutPlan(date)],
      [strengthWorkout(date, "w1")]
    );
    expect(result.matched).toBe(1);
  });
});
