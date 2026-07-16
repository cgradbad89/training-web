import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchAndComputeAggregatedStats } from "../useAggregatedStats";
import * as firestore from "firebase/firestore";
import { AGGREGATED_STATS_VERSION } from "@/utils/aggregatedStats";
import { type HealthWorkout } from "@/types/healthWorkout";

// Mock external dependencies
vi.mock("firebase/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();
  return {
    ...actual,
    doc: vi.fn(),
    getDoc: vi.fn(),
    setDoc: vi.fn(),
    collection: vi.fn(),
    query: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    getDocs: vi.fn(),
  };
});

vi.mock("@/utils/routeCache", () => ({
  getRoutePoints: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/utils/mileSplitsCache", () => ({
  getMileSplits: vi.fn().mockResolvedValue([]),
}));

describe("useAggregatedStats / fetchAndComputeAggregatedStats", () => {
  const mockUid = "test-uid";
  const mockWorkouts = [
    {
      workoutId: "workout1",
      startDate: new Date("2024-01-01T10:00:00Z"),
      distanceMiles: 3.1,
      isRunLike: true,
      hasRoute: true,
    } as HealthWorkout,
  ];
  const maxHr = 185;
  const restingHr = 50;
  const races: any[] = [];
  const latestWorkoutId = "workout1";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns cached data immediately if not stale", async () => {
    const cachedDoc = {
      computationVersion: AGGREGATED_STATS_VERSION,
      latestWorkoutId: "workout1",
      racePredictions: { t5k: 1200 }, // mock data
    };
    
    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => true,
      data: () => cachedDoc,
    } as any);

    const result = await fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, latestWorkoutId
    );

    expect(result).toEqual(cachedDoc);
    expect(firestore.getDocs).not.toHaveBeenCalled(); // no heavy fetches
  });

  it("computes fresh data if cache is missing", async () => {
    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => false,
      data: () => undefined,
    } as any);

    vi.mocked(firestore.getDocs).mockResolvedValue({
      docs: [],
    } as any);

    vi.mocked(firestore.setDoc).mockResolvedValue(undefined);

    const result = await fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, latestWorkoutId
    );

    expect(result).not.toBeNull();
    expect(result.latestWorkoutId).toBe("workout1");
    expect(firestore.setDoc).toHaveBeenCalledTimes(1); // fires write
  });

  it("computes fresh data if version mismatched", async () => {
    const cachedDoc = {
      computationVersion: AGGREGATED_STATS_VERSION - 1,
      latestWorkoutId: "workout1",
    };
    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => true,
      data: () => cachedDoc,
    } as any);
    vi.mocked(firestore.getDocs).mockResolvedValue({ docs: [] } as any);
    vi.mocked(firestore.setDoc).mockResolvedValue(undefined);

    const result = await fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, latestWorkoutId
    );

    expect(result.computationVersion).toBe(AGGREGATED_STATS_VERSION);
    expect(firestore.setDoc).toHaveBeenCalledTimes(1);
  });

  it("computes fresh data if latestWorkoutId mismatched", async () => {
    const cachedDoc = {
      computationVersion: AGGREGATED_STATS_VERSION,
      latestWorkoutId: "old-workout",
    };
    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => true,
      data: () => cachedDoc,
    } as any);
    vi.mocked(firestore.getDocs).mockResolvedValue({ docs: [] } as any);
    vi.mocked(firestore.setDoc).mockResolvedValue(undefined);

    const result = await fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, latestWorkoutId
    );

    expect(result.latestWorkoutId).toBe("workout1");
    expect(firestore.setDoc).toHaveBeenCalledTimes(1);
  });

  it("returns computed data even if firestore setDoc fails", async () => {
    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => false,
      data: () => undefined,
    } as any);
    vi.mocked(firestore.getDocs).mockResolvedValue({ docs: [] } as any);

    // Mock write failure
    vi.mocked(firestore.setDoc).mockRejectedValue(new Error("Permission denied"));

    const result = await fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, latestWorkoutId
    );

    // Should not throw, and should return valid data
    expect(result.latestWorkoutId).toBe("workout1");
  });
});
