import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AutoMatchRunner from "@/components/AutoMatchRunner";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type WorkoutOverride } from "@/types/workoutOverride";
import { type WorkoutPlan } from "@/types/plan";

// React 19 requires this flag for act() to flush effects/microtasks in tests.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  fetchPlans: vi.fn(),
  onHealthWorkoutsSnapshot: vi.fn(),
  autoMatchCrossTrainingSessions: vi.fn(),
  refreshPlans: vi.fn(),
  overrides: {} as Record<string, WorkoutOverride>,
  plans: [] as WorkoutPlan[],
  plansLoading: false,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { uid: "u1" }, loading: false }),
}));
vi.mock("@/services/plans", () => ({ fetchPlans: h.fetchPlans }));
vi.mock("@/services/healthWorkouts", () => ({
  onHealthWorkoutsSnapshot: h.onHealthWorkoutsSnapshot,
}));
vi.mock("@/services/autoMatch", async () => {
  const actual = await vi.importActual("@/services/autoMatch");
  return {
    ...actual,
    autoMatchCrossTrainingSessions: h.autoMatchCrossTrainingSessions,
  };
});
// AutoMatchRunner reaches overrides + refreshPlans through the shared
// AppDataContext it is already mounted inside ((app)/layout.tsx).
vi.mock("@/contexts/AppDataContext", () => ({
  useAppData: () => ({
    overrides: h.overrides,
    refreshPlans: h.refreshPlans,
    plans: h.plans,
    plansLoading: h.plansLoading,
  }),
}));

function workoutPlan({
  status = "active",
  completed = false,
  startDate = "2020-01-06",
}: {
  status?: WorkoutPlan["status"];
  completed?: boolean;
  startDate?: string;
} = {}): WorkoutPlan {
  return {
    id: "wp1",
    name: "Workout plan",
    planType: "workout",
    startDate,
    status,
    isActive: status === "active",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    weeks: [
      {
        weekNumber: 1,
        entries: [
          {
            id: "entry-1",
            weekIndex: 0,
            weekday: 1,
            dayOfWeek: 0,
            type: "workout",
            category: "strength",
            completed,
          },
        ],
      },
    ],
  };
}

function nonRunWorkout(id: string): HealthWorkout {
  return {
    workoutId: id,
    isRunLike: false,
    activityType: "traditionalStrengthTraining",
    startDate: new Date("2026-01-19T12:00:00Z"),
  } as unknown as HealthWorkout;
}

let container: HTMLDivElement;
let root: Root;
/** Captured snapshot callback, so tests can push a workout pool at will. */
let emit: ((workouts: HealthWorkout[]) => void) | null = null;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<AutoMatchRunner />);
  });
  await act(async () => {});
}

describe("AutoMatchRunner — AppDataContext wiring", () => {
  beforeEach(() => {
    emit = null;
    h.overrides = {};
    h.plans = [workoutPlan()];
    h.plansLoading = false;
    h.fetchPlans.mockReset().mockImplementation(async () => h.plans);
    h.refreshPlans.mockReset().mockResolvedValue(undefined);
    h.autoMatchCrossTrainingSessions.mockReset().mockResolvedValue({
      plans: [],
      result: { matched: 0, updatedPlanIds: [] },
    });
    h.onHealthWorkoutsSnapshot.mockReset().mockImplementation(
      (_uid: string, _opts: unknown, onNext: (w: HealthWorkout[]) => void) => {
        emit = onNext;
        return () => {};
      }
    );
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
  });

  it("calls refreshPlans() after the matcher persists a plan update", async () => {
    h.autoMatchCrossTrainingSessions.mockResolvedValue({
      plans: [],
      result: { matched: 1, updatedPlanIds: ["wp1"] },
    });
    await mount();

    await act(async () => {
      emit!([nonRunWorkout("w1")]);
    });
    await act(async () => {});

    expect(h.autoMatchCrossTrainingSessions).toHaveBeenCalledTimes(1);
    expect(h.refreshPlans).toHaveBeenCalledTimes(1);
  });

  it("does NOT call refreshPlans() when the matcher wrote nothing", async () => {
    await mount();

    await act(async () => {
      emit!([nonRunWorkout("w1")]);
    });
    await act(async () => {});

    expect(h.autoMatchCrossTrainingSessions).toHaveBeenCalledTimes(1);
    expect(h.refreshPlans).not.toHaveBeenCalled();
  });

  it("passes the shared overrides map to the matcher so exclusions are honored", async () => {
    h.overrides = {
      w1: {
        workoutId: "w1",
        userId: "u1",
        isExcluded: true,
        excludedAt: null,
        excludedReason: null,
        distanceMilesOverride: null,
        durationSecondsOverride: null,
        runTypeOverride: null,
        updatedAt: "2026-01-20T00:00:00.000Z",
      },
    };
    await mount();

    await act(async () => {
      emit!([nonRunWorkout("w1")]);
    });
    await act(async () => {});

    expect(h.autoMatchCrossTrainingSessions).toHaveBeenCalledWith(
      "u1",
      h.plans,
      [expect.objectContaining({ workoutId: "w1" })],
      h.overrides
    );
  });

  it("subscribes only to non-run workouts in the actionable plan window", async () => {
    await mount();

    expect(h.onHealthWorkoutsSnapshot).toHaveBeenCalledWith(
      "u1",
      { isRunLike: false, startDate: new Date(2020, 0, 6) },
      expect.any(Function),
      expect.any(Function)
    );
  });

  it("does not subscribe when there is no active workout plan", async () => {
    h.plans = [workoutPlan({ status: "draft" })];
    await mount();

    expect(h.onHealthWorkoutsSnapshot).not.toHaveBeenCalled();
  });

  it("does not subscribe when every due workout entry is complete", async () => {
    h.plans = [workoutPlan({ completed: true })];
    await mount();

    expect(h.onHealthWorkoutsSnapshot).not.toHaveBeenCalled();
  });

  it("does not subscribe for an active plan whose entries are all future", async () => {
    h.plans = [workoutPlan({ startDate: "2999-01-04" })];
    await mount();

    expect(h.onHealthWorkoutsSnapshot).not.toHaveBeenCalled();
  });

  it("preserves the content-key guard for duplicate snapshots", async () => {
    await mount();
    const pool = [nonRunWorkout("w1")];

    await act(async () => {
      emit!(pool);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      emit!(pool);
      await Promise.resolve();
    });

    expect(h.autoMatchCrossTrainingSessions).toHaveBeenCalledTimes(1);
  });

  it("preserves the in-flight guard for bursty changed snapshots", async () => {
    let finishMatch!: (value: {
      plans: never[];
      result: { matched: number; updatedPlanIds: string[] };
    }) => void;
    h.autoMatchCrossTrainingSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishMatch = resolve;
        })
    );
    await mount();

    await act(async () => {
      emit!([nonRunWorkout("w1")]);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      emit!([nonRunWorkout("w2")]);
      await Promise.resolve();
    });

    expect(h.autoMatchCrossTrainingSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishMatch({
        plans: [],
        result: { matched: 0, updatedPlanIds: [] },
      });
      await Promise.resolve();
    });
  });
});
