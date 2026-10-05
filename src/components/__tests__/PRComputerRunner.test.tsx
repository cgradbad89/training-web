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
  trainingActivated: true,
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
    trainingActivated: h.trainingActivated,
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
  h.trainingActivated = true;
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
  it("does not schedule before a dormant Health owner has activated training", async () => {
    h.trainingActivated = false;
    await mount();
    expect(requestIdleCallback).not.toHaveBeenCalled();
  });

  it("Strict Mode reschedules cancelled idle work and computes once", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<React.StrictMode><PRComputerRunner /></React.StrictMode>);
    });
    expect(requestIdleCallback).toHaveBeenCalledTimes(2);
    expect(cancelIdleCallback).toHaveBeenCalledTimes(1);
    await runIdleWork();
    expect(h.computeAllPRs).toHaveBeenCalledTimes(1);
  });

  it("a workout update before idle reschedules the cancelled attempt with the current snapshot", async () => {
    await mount();
    const retiredIdle = h.runIdle!;
    h.workouts = [workout("current-run")];
    await act(async () => root.render(<PRComputerRunner />));
    expect(requestIdleCallback).toHaveBeenCalledTimes(2);
    await act(async () => retiredIdle());
    expect(h.computeAllPRs).not.toHaveBeenCalled();
    await runIdleWork();
    expect(h.computeAllPRs).toHaveBeenCalledWith(h.workouts);
  });

  it("unmount cancels pending all-time reads without computing or updating the persisted throttle", async () => {
    let resolve!: (value: HealthWorkout[]) => void;
    h.workoutsHistoryComplete = false;
    h.fetchHealthWorkouts.mockReturnValue(new Promise<HealthWorkout[]>(res => { resolve = res; }));
    await mount();
    await runIdleWork();
    await act(async () => root.render(null));
    await act(async () => resolve([workout("retired-run")]));
    expect(h.computeAllPRs).not.toHaveBeenCalled();
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it("a completed attempt keeps the persisted 24-hour throttle across runner recreation", async () => {
    await mount(); await runIdleWork();
    expect(localStorage.setItem).toHaveBeenCalledWith("pr_last_computed", expect.any(String));
    await act(async () => root.render(null));
    await act(async () => root.render(<PRComputerRunner />));
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(h.computeAllPRs).toHaveBeenCalledTimes(1);
  });

  it("the unchanged persisted throttle allows a new attempt after 24 hours", async () => {
    localStorage.setItem("pr_last_computed", String(Date.now() - 24 * 60 * 60 * 1000 - 1));
    await mount(); await runIdleWork();
    expect(h.computeAllPRs).toHaveBeenCalledTimes(1);
  });

});
