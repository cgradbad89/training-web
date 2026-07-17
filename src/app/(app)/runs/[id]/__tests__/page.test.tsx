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
  saveRunDetailCaches: vi.fn().mockResolvedValue(undefined),
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

  it("fetches core data on mount, then reads mileSplits + the route once core resolves (route now gated)", async () => {
    let resolveWorkout: (val: any) => void;
    const workoutPromise = new Promise((res) => { resolveWorkout = res; });
    (fetchHealthWorkout as any).mockReturnValue(workoutPromise);

    (getRoutePoints as any).mockResolvedValue([]);
    (getMileSplits as any).mockResolvedValue([]);

    act(() => {
      root = createRoot(container);
      root.render(<RunDetailPage />);
    });

    // Core is fetched on mount, but the mileSplits + route reads are now
    // sequenced AFTER core resolves (the route read is gated on cache state).
    expect(fetchHealthWorkout).toHaveBeenCalledWith("u1", "workout_123");
    expect(getMileSplits).not.toHaveBeenCalled();
    expect(getRoutePoints).not.toHaveBeenCalled();

    await act(async () => {
      resolveWorkout!({
        workoutId: "workout_123",
        startDate: "2024-01-01T10:00:00Z",
        distanceMiles: 3,
        durationSeconds: 1800,
        isRunLike: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // After core resolves: mileSplits is read, and because this uncached routed
    // run has no route-derived caches yet, the full route IS read.
    expect(getMileSplits).toHaveBeenCalledWith("u1", "workout_123");
    expect(getRoutePoints).toHaveBeenCalledWith("u1", "workout_123");
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

  it("fetches weather only after the (gated) route read resolves", async () => {
    let resolveRoute: (val: any) => void;
    const routePromise = new Promise((res) => { resolveRoute = res; });

    (fetchHealthWorkout as any).mockResolvedValue({
      workoutId: "workout_123",
      startDate: "2024-01-01T10:00:00Z",
      distanceMiles: 3,
      durationSeconds: 1800,
      isRunLike: true,
      weather: null,
    });
    (getMileSplits as any).mockResolvedValue([]);
    (getRoutePoints as any).mockReturnValue(routePromise);
    (fetchWeatherForRun as any).mockResolvedValue({ tempF: 60 });

    act(() => {
      root = createRoot(container);
      root.render(<RunDetailPage />);
    });

    // Core + mileSplits resolve and the uncached run triggers the route read,
    // but weather waits until the route itself resolves.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getRoutePoints).toHaveBeenCalledWith("u1", "workout_123");
    expect(fetchWeatherForRun).not.toHaveBeenCalled();

    // Resolve the route
    await act(async () => {
      resolveRoute!([{ lat: 40, lng: -74 }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchWeatherForRun).toHaveBeenCalledWith(40, -74, "2024-01-01T10:00:00Z");
  });
});
