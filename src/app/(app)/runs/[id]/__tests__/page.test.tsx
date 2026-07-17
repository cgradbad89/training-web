import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fetchHealthWorkout } from "@/services/healthWorkouts";
import { getRoutePoints } from "@/utils/routeCache";
import { getMileSplits } from "@/utils/mileSplitsCache";
import { fetchWeatherForRun } from "@/lib/weather";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mocks
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "workout_123" }),
  useRouter: () => ({ back: vi.fn() }),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { uid: "u1" } }),
}));

vi.mock("@/hooks/useUnsavedChanges", () => ({
  useUnsavedChanges: vi.fn(),
}));

// Mock services
vi.mock("@/services/healthWorkouts", () => ({
  fetchHealthWorkout: vi.fn(),
  fetchHealthWorkouts: vi.fn().mockResolvedValue([]),
  fetchWorkoutsByRouteCluster: vi.fn().mockResolvedValue([]),
  backfillRouteClusterIds: vi.fn().mockResolvedValue(undefined),
  computeAndStoreBestEfforts: vi.fn().mockResolvedValue(undefined),
  saveRouteClusterId: vi.fn().mockResolvedValue(undefined),
  saveOverlayChartCache: vi.fn().mockResolvedValue(undefined),
  saveWeatherForWorkout: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/shoes", () => ({
  fetchShoes: vi.fn().mockResolvedValue([]),
  fetchManualShoeAssignmentsMap: vi.fn().mockResolvedValue({}),
  saveManualAssignments: vi.fn(),
}));
vi.mock("@/services/workoutOverrides", () => ({
  fetchOverride: vi.fn().mockResolvedValue(null),
  fetchAllOverrides: vi.fn().mockResolvedValue({}),
  saveOverride: vi.fn(),
  deleteOverride: vi.fn(),
  excludeWorkout: vi.fn(),
  restoreWorkout: vi.fn(),
}));
vi.mock("@/services/userSettings", () => ({
  fetchUserSettings: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/services/races", () => ({
  fetchRaces: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/services/plans", () => ({
  fetchPlans: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/services/fastFinishSplits", () => ({
  hydrateFastFinishSplits: vi.fn().mockResolvedValue({ runs: [] }),
}));
vi.mock("@/utils/routeCache", () => ({
  getRoutePoints: vi.fn(),
}));
vi.mock("@/utils/mileSplitsCache", () => ({
  getMileSplits: vi.fn(),
  saveMileSplitCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/weather", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/weather")>();
  return {
    ...actual,
    fetchWeatherForRun: vi.fn(),
  };
});

import RunDetailPage from "../page";

describe("RunDetailPage Execution Structure", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      if (root) root.unmount();
    });
    container.remove();
  });

  it("invokes getRoutePoints and getMileSplits immediately without waiting for core fetches", async () => {
    let resolveWorkout: (val: any) => void;
    const workoutPromise = new Promise((res) => { resolveWorkout = res; });
    (fetchHealthWorkout as any).mockReturnValue(workoutPromise);

    (getRoutePoints as any).mockResolvedValue([]);
    (getMileSplits as any).mockResolvedValue([]);

    act(() => {
      root = createRoot(container);
      root.render(<RunDetailPage />);
    });

    // On mount, the component should immediately call all 3 concurrently
    expect(fetchHealthWorkout).toHaveBeenCalledWith("u1", "workout_123");
    expect(getRoutePoints).toHaveBeenCalledWith("u1", "workout_123");
    expect(getMileSplits).toHaveBeenCalledWith("u1", "workout_123");

    // Clean up pending promise to avoid leaks
    await act(async () => {
      resolveWorkout!({ workoutId: "workout_123", startDate: "2024-01-01T10:00:00Z" });
      await Promise.resolve();
    });
  });

  it("handles a routeless workout gracefully (empty splits) and does not fetch weather", async () => {
    (fetchHealthWorkout as any).mockResolvedValue({
      workoutId: "workout_123",
      startDate: "2024-01-01T10:00:00Z",
      distanceMiles: 3,
      durationSeconds: 1800,
      isRunLike: true,
      weather: null,
    });
    // Routeless
    (getRoutePoints as any).mockResolvedValue([]);
    (getMileSplits as any).mockResolvedValue([]);

    act(() => {
      root = createRoot(container);
      root.render(<RunDetailPage />);
    });
    
    // Allow state to settle
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchWeatherForRun).not.toHaveBeenCalled();
    expect(container.textContent).toContain("3.00");
  });

  it("only fetches weather after BOTH workout and route are resolved", async () => {
    let resolveWorkout: (val: any) => void;
    let resolveRoute: (val: any) => void;
    
    const workoutPromise = new Promise((res) => { resolveWorkout = res; });
    const routePromise = new Promise((res) => { resolveRoute = res; });

    (fetchHealthWorkout as any).mockReturnValue(workoutPromise);
    (getRoutePoints as any).mockReturnValue(routePromise);
    (getMileSplits as any).mockResolvedValue([]);
    (fetchWeatherForRun as any).mockResolvedValue({ tempF: 60 });

    act(() => {
      root = createRoot(container);
      root.render(<RunDetailPage />);
    });

    // Neither resolved yet
    expect(fetchWeatherForRun).not.toHaveBeenCalled();

    // Resolve workout only
    await act(async () => {
      resolveWorkout!({
        workoutId: "workout_123",
        startDate: "2024-01-01T10:00:00Z",
        weather: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchWeatherForRun).not.toHaveBeenCalled();

    // Resolve route
    await act(async () => {
      resolveRoute!([{ lat: 40, lng: -74 }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Now it should fetch
    expect(fetchWeatherForRun).toHaveBeenCalledWith(40, -74, "2024-01-01T10:00:00Z");
  });
});
