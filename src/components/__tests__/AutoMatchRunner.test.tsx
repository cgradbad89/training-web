import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AutoMatchRunner from "@/components/AutoMatchRunner";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type WorkoutOverride } from "@/types/workoutOverride";

// React 19 requires this flag for act() to flush effects/microtasks in tests.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  fetchPlans: vi.fn(),
  onHealthWorkoutsSnapshot: vi.fn(),
  autoMatchCrossTrainingSessions: vi.fn(),
  refreshPlans: vi.fn(),
  overrides: {} as Record<string, WorkoutOverride>,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { uid: "u1" }, loading: false }),
}));
vi.mock("@/services/plans", () => ({ fetchPlans: h.fetchPlans }));
vi.mock("@/services/healthWorkouts", () => ({
  onHealthWorkoutsSnapshot: h.onHealthWorkoutsSnapshot,
}));
vi.mock("@/services/autoMatch", () => ({
  autoMatchCrossTrainingSessions: h.autoMatchCrossTrainingSessions,
}));
// AutoMatchRunner reaches overrides + refreshPlans through the shared
// AppDataContext it is already mounted inside ((app)/layout.tsx).
vi.mock("@/contexts/AppDataContext", () => ({
  useAppData: () => ({ overrides: h.overrides, refreshPlans: h.refreshPlans }),
}));

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
    h.fetchPlans.mockReset().mockResolvedValue([]);
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
      [],
      [expect.objectContaining({ workoutId: "w1" })],
      h.overrides
    );
  });
});
