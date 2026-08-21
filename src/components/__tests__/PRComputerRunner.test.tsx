import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type HealthWorkout } from "@/types/healthWorkout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  user: { uid: "u1" },
  workouts: [] as HealthWorkout[],
  workoutsLoading: false,
  workoutsHistoryComplete: true,
  fetchHealthWorkouts: vi.fn(),
  computeAllPRs: vi.fn(),
  buildPRBadgeMap: vi.fn(),
  batchUpdate: vi.fn(),
  batchCommit: vi.fn(),
  runIdle: null as (() => void) | null,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: h.user, loading: false }),
}));
vi.mock("@/contexts/AppDataContext", () => ({
  useAppData: () => ({
    workouts: h.workouts,
    workoutsLoading: h.workoutsLoading,
    workoutsHistoryComplete: h.workoutsHistoryComplete,
  }),
}));
vi.mock("@/services/healthWorkouts", () => ({
  fetchHealthWorkouts: h.fetchHealthWorkouts,
}));
vi.mock("@/utils/prComputation", () => ({
  computeAllPRs: h.computeAllPRs,
  buildPRBadgeMap: h.buildPRBadgeMap,
}));
vi.mock("firebase/firestore", () => ({
  doc: vi.fn(),
  writeBatch: () => ({ update: h.batchUpdate, commit: h.batchCommit }),
}));
vi.mock("@/lib/firebase", () => ({ db: {} }));

import PRComputerRunner from "@/components/PRComputerRunner";

let container: HTMLDivElement;
let root: Root;

function workout(workoutId: string): HealthWorkout {
  return {
    workoutId,
    isRunLike: true,
    prBadges: [],
  } as unknown as HealthWorkout;
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<PRComputerRunner />);
  });
}

async function runIdleWork() {
  await act(async () => {
    h.runIdle?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    removeItem: vi.fn((key: string) => storage.delete(key)),
    clear: vi.fn(() => storage.clear()),
  });
  h.workouts = [workout("shared-run")];
  h.workoutsLoading = false;
  h.workoutsHistoryComplete = true;
  h.runIdle = null;
  h.fetchHealthWorkouts.mockReset().mockResolvedValue([]);
  h.computeAllPRs.mockReset().mockReturnValue([]);
  h.buildPRBadgeMap.mockReset().mockReturnValue(new Map());
  h.batchUpdate.mockReset();
  h.batchCommit.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "requestIdleCallback",
    vi.fn((callback: IdleRequestCallback) => {
      h.runIdle = () =>
        callback({ didTimeout: false, timeRemaining: () => 50 });
      return 1;
    })
  );
  vi.stubGlobal("cancelIdleCallback", vi.fn());
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe("PRComputerRunner", () => {
  it("waits for browser idle and reuses complete shared workout history", async () => {
    await mount();

    expect(h.runIdle).toBeTypeOf("function");
    expect(h.computeAllPRs).not.toHaveBeenCalled();
    expect(h.fetchHealthWorkouts).not.toHaveBeenCalled();

    await runIdleWork();

    expect(h.fetchHealthWorkouts).not.toHaveBeenCalled();
    expect(h.computeAllPRs).toHaveBeenCalledWith(h.workouts);
  });

  it("falls back to all-time workouts only when the shared read hit its cap", async () => {
    const allTime = [workout("all-time-run")];
    h.workoutsHistoryComplete = false;
    h.fetchHealthWorkouts.mockResolvedValue(allTime);
    await mount();

    await runIdleWork();

    expect(h.fetchHealthWorkouts).toHaveBeenCalledWith("u1", {});
    expect(h.computeAllPRs).toHaveBeenCalledWith(allTime);
  });

  it("does not schedule PR work before the initial workout read completes", async () => {
    h.workoutsLoading = true;
    await mount();

    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(h.fetchHealthWorkouts).not.toHaveBeenCalled();
    expect(h.computeAllPRs).not.toHaveBeenCalled();
  });
});
