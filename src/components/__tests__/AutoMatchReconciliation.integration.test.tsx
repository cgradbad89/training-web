import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AutoMatchRunner from "@/components/AutoMatchRunner";
import {
  AppDataProvider,
  useAppData,
  workoutDeltaStartDate,
  type AppDataContextValue,
} from "@/contexts/AppDataContext";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type Plan, type WorkoutPlan } from "@/types/plan";
import { type WorkoutOverride } from "@/types/workoutOverride";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  fetchHealthWorkouts: vi.fn(),
  fetchHealthWorkoutsInRange: vi.fn(),
  fetchAutoMatchCandidatesThroughDate: vi.fn(),
  onHealthWorkoutsSnapshot: vi.fn(),
  fetchPlans: vi.fn(),
  updatePlan: vi.fn(),
  fetchRaces: vi.fn(),
  fetchAllOverrides: vi.fn(),
  fetchUserSettings: vi.fn(),
  delayedAvailable: false,
  planStore: [] as Plan[],
  candidatePools: [] as HealthWorkout[][],
  events: [] as string[],
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { uid: "u1" }, loading: false }),
}));
vi.mock("@/services/healthWorkouts", () => ({
  AUTO_MATCH_CANDIDATE_PAGE_SIZE: 250,
  fetchHealthWorkouts: h.fetchHealthWorkouts,
  fetchHealthWorkoutsInRange: h.fetchHealthWorkoutsInRange,
  fetchAutoMatchCandidatesThroughDate:
    h.fetchAutoMatchCandidatesThroughDate,
  onHealthWorkoutsSnapshot: h.onHealthWorkoutsSnapshot,
}));
vi.mock("@/services/plans", () => ({
  fetchPlans: h.fetchPlans,
  updatePlan: h.updatePlan,
}));
vi.mock("@/services/races", () => ({ fetchRaces: h.fetchRaces }));
vi.mock("@/services/workoutOverrides", () => ({
  fetchAllOverrides: h.fetchAllOverrides,
}));
vi.mock("@/services/userSettings", () => ({
  fetchUserSettings: h.fetchUserSettings,
}));

const uid = "u1";
const dueDate = new Date(2026, 7, 10, 9);
const newestDate = new Date(2026, 7, 20, 10);

function nonRunWorkout(
  workoutId: string,
  startDate: Date,
  activityType = "traditionalStrengthTraining"
): HealthWorkout {
  return {
    workoutId,
    isRunLike: false,
    activityType,
    startDate,
    endDate: new Date(startDate.getTime() + 45 * 60 * 1000),
    durationSeconds: 45 * 60,
  } as HealthWorkout;
}

const newestWorkout = nonRunWorkout(
  "newest",
  newestDate,
  "highIntensityIntervalTraining"
);
const excludedCompetitor = nonRunWorkout("excluded-competitor", dueDate);
const delayedWorkout = nonRunWorkout("delayed-x", dueDate);

function incompletePlan(): WorkoutPlan {
  return {
    id: "workout-plan",
    name: "Strength block",
    planType: "workout",
    startDate: "2026-08-10",
    status: "active",
    isActive: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    weeks: [
      {
        weekNumber: 1,
        entries: [
          {
            id: "due-strength",
            weekIndex: 0,
            weekday: 1,
            dayOfWeek: 0,
            type: "workout",
            category: "strength",
            completed: false,
          },
        ],
      },
    ],
  };
}

function excludedOverride(): WorkoutOverride {
  return {
    workoutId: excludedCompetitor.workoutId,
    userId: uid,
    isExcluded: true,
    excludedAt: "2026-08-10T10:00:00.000Z",
    excludedReason: "duplicate",
    distanceMilesOverride: null,
    durationSecondsOverride: null,
    runTypeOverride: null,
    updatedAt: "2026-08-10T10:00:00.000Z",
  };
}

function clonePlans(): Plan[] {
  return structuredClone(h.planStore);
}

let latest: AppDataContextValue | null = null;
let container: HTMLDivElement;
let root: Root;

function Probe() {
  const value = useAppData();
  React.useEffect(() => {
    latest = value;
  }, [value]);
  return null;
}

async function flushEffects(rounds = 8) {
  for (let index = 0; index < rounds; index++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mountHarness() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <AppDataProvider uid={uid}>
        <AutoMatchRunner />
        <Probe />
      </AppDataProvider>
    );
  });
  await flushEffects();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 20, 12));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

  latest = null;
  h.delayedAvailable = false;
  h.planStore = [incompletePlan()];
  h.candidatePools = [];
  h.events = [];

  h.fetchHealthWorkouts.mockReset().mockResolvedValueOnce([newestWorkout]);
  h.fetchHealthWorkoutsInRange.mockReset().mockResolvedValue([]);
  h.fetchPlans.mockReset().mockImplementation(async () => {
    h.events.push("fetchPlans");
    return clonePlans();
  });
  h.updatePlan.mockReset().mockImplementation(async (_uid: string, plan: Plan) => {
    h.events.push("updatePlan");
    h.planStore = h.planStore.map((current) =>
      current.id === plan.id ? structuredClone(plan) : current
    );
  });
  h.fetchRaces.mockReset().mockResolvedValue([]);
  h.fetchAllOverrides.mockReset().mockResolvedValue({
    [excludedCompetitor.workoutId]: excludedOverride(),
  });
  h.fetchUserSettings.mockReset().mockResolvedValue(null);
  h.fetchAutoMatchCandidatesThroughDate
    .mockReset()
    .mockImplementation(
      async (
        _uid: string,
        _earliestDueDate: Date,
        options: { initialCandidates: HealthWorkout[] }
      ) => {
        const candidates = h.delayedAvailable
          ? [...options.initialCandidates, delayedWorkout]
          : [...options.initialCandidates];
        h.candidatePools.push(candidates);
        return candidates;
      }
    );
  h.onHealthWorkoutsSnapshot.mockReset().mockImplementation(
    (
      _uid: string,
      _options: unknown,
      onData: (workouts: HealthWorkout[], cursor?: { id: string }) => void
    ) => {
      let subscribed = true;
      void Promise.resolve().then(() => {
        if (subscribed) {
          onData([excludedCompetitor], { id: excludedCompetitor.workoutId });
        }
      });
      return () => {
        subscribed = false;
      };
    }
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("delayed workout full-reconciliation AutoMatch integration", () => {
  it("reconciles an old delayed workout through AppData, persists completion, refreshes shared plans, and stays idempotent", async () => {
    await mountHarness();

    expect(latest).toEqual(
      expect.objectContaining({
        workoutsResolution: "success",
        plansResolution: "success",
        workoutsFullReconciliationVersion: 1,
      })
    );
    expect(latest?.workouts.map((workout) => workout.workoutId)).toEqual([
      "newest",
    ]);
    expect(h.candidatePools).toEqual([[excludedCompetitor]]);
    expect(h.updatePlan).not.toHaveBeenCalled();
    expect((latest?.plans[0] as WorkoutPlan).weeks[0].entries[0].completed)
      .toBe(false);

    expect(dueDate.getTime()).toBeLessThan(
      workoutDeltaStartDate(newestDate).getTime()
    );
    vi.setSystemTime(new Date(2026, 7, 20, 12, 1));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    await flushEffects();

    expect(h.fetchHealthWorkoutsInRange).toHaveBeenCalledTimes(1);
    expect(h.fetchHealthWorkoutsInRange).toHaveBeenCalledWith(
      uid,
      workoutDeltaStartDate(newestDate)
    );
    expect(latest?.workouts.map((workout) => workout.workoutId)).not.toContain(
      delayedWorkout.workoutId
    );
    expect(h.updatePlan).not.toHaveBeenCalled();
    expect((latest?.plans[0] as WorkoutPlan).weeks[0].entries[0].completed)
      .toBe(false);

    h.fetchHealthWorkouts.mockImplementationOnce(async () => {
      h.delayedAvailable = true;
      return [newestWorkout, delayedWorkout];
    });
    await act(async () => {
      await latest!.refreshWorkouts();
    });
    await flushEffects();

    expect(latest?.workouts.map((workout) => workout.workoutId)).toEqual([
      "newest",
      "delayed-x",
    ]);
    expect(latest?.workoutsFullReconciliationVersion).toBe(2);
    expect(h.onHealthWorkoutsSnapshot).toHaveBeenCalledTimes(2);
    expect(h.candidatePools.at(-1)?.map((workout) => workout.workoutId)).toEqual([
      "excluded-competitor",
      "delayed-x",
    ]);
    expect(h.updatePlan).toHaveBeenCalledTimes(1);
    expect(h.updatePlan).toHaveBeenCalledWith(
      uid,
      expect.objectContaining({ id: "workout-plan" })
    );
    const persistedEntry = (h.planStore[0] as WorkoutPlan).weeks[0].entries[0];
    expect(persistedEntry).toMatchObject({
      completed: true,
      completedAt: delayedWorkout.startDate.toISOString(),
    });
    expect(h.events.slice(-2)).toEqual(["updatePlan", "fetchPlans"]);
    expect((latest?.plans[0] as WorkoutPlan).weeks[0].entries[0]).toMatchObject({
      completed: true,
      completedAt: delayedWorkout.startDate.toISOString(),
    });

    const candidateAcquisitionCount =
      h.fetchAutoMatchCandidatesThroughDate.mock.calls.length;
    h.fetchHealthWorkouts.mockResolvedValueOnce([newestWorkout, delayedWorkout]);
    await act(async () => {
      await latest!.refreshWorkouts();
    });
    await flushEffects();

    expect(latest?.workoutsFullReconciliationVersion).toBe(3);
    expect(h.onHealthWorkoutsSnapshot).toHaveBeenCalledTimes(2);
    expect(h.fetchAutoMatchCandidatesThroughDate).toHaveBeenCalledTimes(
      candidateAcquisitionCount
    );
    expect(h.updatePlan).toHaveBeenCalledTimes(1);
    expect((latest?.plans[0] as WorkoutPlan).weeks[0].entries[0].completed)
      .toBe(true);
  });
});
