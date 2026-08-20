import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchAndComputeAggregatedStats,
  getAggregationLockKey,
  isAggregationReady,
  logAggregationEvent,
} from "../useAggregatedStats";
import * as firestore from "firebase/firestore";
import { AGGREGATED_STATS_VERSION } from "@/utils/aggregatedStats";
import { type HealthWorkout } from "@/types/healthWorkout";
import { getRoutePoints } from "@/utils/routeCache";

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
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getRoutePoints).mockResolvedValue([]);
  });

  function mockMissingCache(): void {
    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => false,
      data: () => undefined,
    } as any);
    vi.mocked(firestore.getDocs).mockResolvedValue({ docs: [] } as any);
    vi.mocked(firestore.setDoc).mockResolvedValue(undefined);
  }

  it("builds a stable lock key from uid and latest workout", () => {
    expect(getAggregationLockKey("uid-1", "workout-1")).toBe(
      "uid-1:workout-1"
    );
    expect(getAggregationLockKey("uid-1", "workout-1")).toBe(
      getAggregationLockKey("uid-1", "workout-1")
    );
  });

  it("uses a different lock key when either uid or latest workout changes", () => {
    const original = getAggregationLockKey("uid-1", "workout-1");
    expect(getAggregationLockKey("uid-2", "workout-1")).not.toBe(original);
    expect(getAggregationLockKey("uid-1", "workout-2")).not.toBe(original);
  });

  it("reports ready only after workouts, settings, and races finish loading", () => {
    expect(
      isAggregationReady("uid-1", {
        workoutsLoading: false,
        settingsLoading: false,
        racesLoading: false,
      })
    ).toBe(true);
  });

  it("blocks aggregation while auth or any required dependency is not ready", () => {
    const readyFlags = {
      workoutsLoading: false,
      settingsLoading: false,
      racesLoading: false,
    };
    expect(isAggregationReady(null, readyFlags)).toBe(false);
    expect(
      isAggregationReady("uid-1", { ...readyFlags, workoutsLoading: true })
    ).toBe(false);
    expect(
      isAggregationReady("uid-1", { ...readyFlags, settingsLoading: true })
    ).toBe(false);
    expect(
      isAggregationReady("uid-1", { ...readyFlags, racesLoading: true })
    ).toBe(false);
  });

  it("logs lifecycle events with the greppable prefix", () => {
    logAggregationEvent("start", {
      uid: mockUid,
      latestWorkoutId,
    });
    logAggregationEvent("error", {
      uid: mockUid,
      latestWorkoutId,
      error: "boom",
    });

    expect(console.log).toHaveBeenCalledWith(
      "[aggregated-stats]",
      expect.objectContaining({ event: "start", uid: mockUid, latestWorkoutId })
    );
    expect(console.warn).toHaveBeenCalledWith(
      "[aggregated-stats]",
      expect.objectContaining({ event: "error", error: "boom" })
    );
  });

  it("returns cached data immediately if not stale", async () => {
    const cachedDoc = {
      computationVersion: AGGREGATED_STATS_VERSION,
      latestWorkoutId: "workout1",
      racePredictions: { t5k: 1200 }, // mock data
      // Revival normalizes these two; include them so equality holds.
      fastestMileSegment: null,
      personalRecordsByYear: { prs: [], specificPrs: [] },
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

  it("revives string dates to Date instances on the cache-hit path (regression)", async () => {
    // Shaped like real Firestore output: dates round-tripped to ISO strings.
    const cachedDoc = {
      computationVersion: AGGREGATED_STATS_VERSION,
      latestWorkoutId: "workout1",
      racePredictions: { t5k: 1200 },
      fastestMileSegment: { seconds: 360, date: "2024-01-07T10:00:00.000Z" },
      personalRecordsByYear: {
        prs: [{ pace: 480, miles: 2, date: "2024-01-05T10:00:00.000Z" }, null],
        specificPrs: [
          {
            pace: 420,
            miles: 3.1,
            totalSeconds: 1302,
            date: "2024-01-06T10:00:00.000Z",
          },
          null,
        ],
      },
    };

    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => true,
      data: () => cachedDoc,
    } as any);

    const result = await fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, latestWorkoutId
    );

    expect(result.fastestMileSegment!.date instanceof Date).toBe(true);
    expect(result.personalRecordsByYear.prs[0]!.date instanceof Date).toBe(true);
    expect(
      result.personalRecordsByYear.specificPrs[0]!.date instanceof Date
    ).toBe(true);
    // Null entries survive without throwing or fabricating a date.
    expect(result.personalRecordsByYear.prs[1]).toBeNull();
    expect(firestore.getDocs).not.toHaveBeenCalled();
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

  it("does not resolve the computation or release its lock until the cache write completes", async () => {
    mockMissingCache();
    let resolveWrite!: () => void;
    const writePending = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    vi.mocked(firestore.setDoc).mockReturnValue(writePending);

    let settled = false;
    const first = fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, latestWorkoutId
    ).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => expect(firestore.setDoc).toHaveBeenCalledTimes(1));
    const overlapping = fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, latestWorkoutId
    );
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(firestore.getDoc).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(
      "[aggregated-stats]",
      expect.objectContaining({ event: "skip-in-flight" })
    );

    resolveWrite();
    const [firstResult, overlappingResult] = await Promise.all([
      first,
      overlapping,
    ]);
    expect(firstResult).toEqual(overlappingResult);
    expect(settled).toBe(true);
  });

  it("collapses overlapping triggers into one computation and one route read per workout", async () => {
    mockMissingCache();
    let resolveRoute!: (points: []) => void;
    vi.mocked(getRoutePoints).mockReturnValue(
      new Promise<[]>((resolve) => {
        resolveRoute = resolve;
      })
    );

    const first = fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, latestWorkoutId
    );
    const second = fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, latestWorkoutId
    );

    expect(second).toBe(first);
    expect(firestore.getDoc).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(getRoutePoints).toHaveBeenCalledTimes(1));

    resolveRoute([]);
    await Promise.all([first, second]);
    expect(firestore.setDoc).toHaveBeenCalledTimes(1);
  });

  it("does not deduplicate computations for different latest-workout keys", async () => {
    mockMissingCache();

    await Promise.all([
      fetchAndComputeAggregatedStats(
        mockUid, mockWorkouts, maxHr, restingHr, races, "workout1"
      ),
      fetchAndComputeAggregatedStats(
        mockUid, mockWorkouts, maxHr, restingHr, races, "workout2"
      ),
    ]);

    expect(firestore.getDoc).toHaveBeenCalledTimes(2);
    expect(firestore.setDoc).toHaveBeenCalledTimes(2);
  });

  it("releases the lock after a successful computation", async () => {
    mockMissingCache();

    await fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, latestWorkoutId
    );
    await fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, latestWorkoutId
    );

    expect(firestore.getDoc).toHaveBeenCalledTimes(2);
    expect(firestore.setDoc).toHaveBeenCalledTimes(2);
  });

  it("logs a failed cache write, rejects, and releases the lock for retry", async () => {
    mockMissingCache();
    vi.mocked(firestore.setDoc)
      .mockRejectedValueOnce(new Error("Permission denied"))
      .mockResolvedValueOnce(undefined);

    await expect(
      fetchAndComputeAggregatedStats(
        mockUid, mockWorkouts, maxHr, restingHr, races, latestWorkoutId
      )
    ).rejects.toThrow("Permission denied");

    expect(console.warn).toHaveBeenCalledWith(
      "[aggregated-stats]",
      expect.objectContaining({
        event: "error",
        uid: mockUid,
        latestWorkoutId,
        error: "Permission denied",
      })
    );
    expect(firestore.setDoc).toHaveBeenCalledTimes(1);

    await expect(
      fetchAndComputeAggregatedStats(
        mockUid, mockWorkouts, maxHr, restingHr, races, latestWorkoutId
      )
    ).resolves.toEqual(expect.objectContaining({ latestWorkoutId }));
    expect(firestore.getDoc).toHaveBeenCalledTimes(2);
    expect(firestore.setDoc).toHaveBeenCalledTimes(2);
  });
});
