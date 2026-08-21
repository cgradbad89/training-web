import { describe, it, expect, vi, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  fetchAndComputeAggregatedStats,
  getAggregationLockKey,
  isAggregationReady,
  logAggregationEvent,
  useAggregatedStats,
} from "../useAggregatedStats";
import * as firestore from "firebase/firestore";
import * as mileSplitsCache from "@/utils/mileSplitsCache";
import {
  AGGREGATED_STATS_VERSION,
  computeFreshnessFingerprint,
  computeVo2FreshnessKey,
  type AggregatedStatsDoc,
} from "@/utils/aggregatedStats";
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
    limit: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    getDocs: vi.fn(),
  };
});

vi.mock("@/utils/mileSplitsCache", () => ({
  getMileSplits: vi.fn().mockResolvedValue([]),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

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

  function currentFingerprint(overrides: unknown = {}) {
    return computeFreshnessFingerprint({
      latestWorkoutId,
      computationVersion: AGGREGATED_STATS_VERSION,
      maxHr,
      restingHr,
      activeRaceId: null,
      activeRaceDate: null,
      overrides,
    });
  }

  function cachedStats(
    overrides: Partial<AggregatedStatsDoc> = {}
  ): AggregatedStatsDoc {
    const vo2FreshnessKey =
      overrides.vo2FreshnessKey ?? computeVo2FreshnessKey(null);
    return {
      computationVersion: AGGREGATED_STATS_VERSION,
      freshnessFingerprint: currentFingerprint(),
      vo2FreshnessKey,
      latestVo2SampleDate: vo2FreshnessKey.latestVo2SampleDate,
      computedAt: "2026-08-20T12:00:00.000Z",
      latestWorkoutId,
      latestWorkoutStartDate: "2024-01-01T10:00:00.000Z",
      trainingLoad: { series: [] },
      vo2History: [],
      racePredictions: {
        t5k: 1200,
        t10: null,
        tHalf: null,
        tMar: null,
        confidenceLevel: "low",
        modelFit: null,
      },
      personalRecordsByYear: { prs: [], specificPrs: [] },
      paceTrends: [],
      hrZoneDistribution: {
        runsCounted: 0,
        totalMiles: 0,
        zoneMiles: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      },
      fastestMileSegment: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(firestore.getDocs).mockResolvedValue({ docs: [] } as any);
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
        overridesLoading: false,
      })
    ).toBe(true);
  });

  it("blocks aggregation while auth or any required dependency is not ready", () => {
    const readyFlags = {
      workoutsLoading: false,
      settingsLoading: false,
      racesLoading: false,
      overridesLoading: false,
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

  it("waits for workout overrides before aggregation is ready", () => {
    expect(
      isAggregationReady("uid-1", {
        workoutsLoading: false,
        settingsLoading: false,
        racesLoading: false,
        overridesLoading: true,
      })
    ).toBe(false);
  });

  it("does not fetch or compute when aggregation is disabled", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness() {
      const result = useAggregatedStats(
        mockUid,
        mockWorkouts,
        maxHr,
        restingHr,
        races,
        {
          workoutsLoading: false,
          settingsLoading: false,
          racesLoading: false,
          overridesLoading: false,
        },
        { enabled: false }
      );
      return React.createElement("span", null, String(result.loading));
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });

    expect(container.textContent).toBe("false");
    expect(firestore.getDoc).not.toHaveBeenCalled();
    expect(firestore.getDocs).not.toHaveBeenCalled();
    expect(firestore.setDoc).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("renders a cached aggregate before larger dependencies finish loading", async () => {
    const cachedDoc = cachedStats();
    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => true,
      data: () => cachedDoc,
    } as any);
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness() {
      const result = useAggregatedStats(
        mockUid,
        [],
        maxHr,
        restingHr,
        races,
        {
          workoutsLoading: true,
          settingsLoading: true,
          racesLoading: true,
          overridesLoading: true,
        }
      );
      return React.createElement(
        "span",
        null,
        `${result.loading}:${result.data?.computedAt ?? "none"}`
      );
    }

    await act(async () => {
      root.render(React.createElement(Harness));
    });
    await vi.waitFor(() =>
      expect(container.textContent).toBe(`false:${cachedDoc.computedAt}`)
    );

    expect(firestore.getDoc).toHaveBeenCalledTimes(1);
    expect(firestore.getDocs).not.toHaveBeenCalled();
    act(() => root.unmount());
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
    const cachedDoc = cachedStats();

    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => true,
      data: () => cachedDoc,
    } as any);

    const result = await fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, currentFingerprint()
    );

    expect(result).toEqual(cachedDoc);
    expect(firestore.getDocs).toHaveBeenCalledTimes(1);
    expect(firestore.setDoc).not.toHaveBeenCalled();
  });

  it("starts the aggregate and VO2 freshness reads in parallel", async () => {
    const cachedDoc = cachedStats();
    let resolveCache!: (value: any) => void;
    let resolveVo2!: (value: any) => void;
    vi.mocked(firestore.getDoc).mockReturnValue(
      new Promise((resolve) => {
        resolveCache = resolve;
      }) as any
    );
    vi.mocked(firestore.getDocs).mockReturnValue(
      new Promise((resolve) => {
        resolveVo2 = resolve;
      }) as any
    );

    const pending = fetchAndComputeAggregatedStats(
      mockUid,
      mockWorkouts,
      maxHr,
      restingHr,
      races,
      currentFingerprint()
    );

    await vi.waitFor(() => {
      expect(firestore.getDoc).toHaveBeenCalledTimes(1);
      expect(firestore.getDocs).toHaveBeenCalledTimes(1);
    });

    resolveCache({ exists: () => true, data: () => cachedDoc });
    resolveVo2({ docs: [] });
    await expect(pending).resolves.toEqual(cachedDoc);
  });

  it("revives string dates to Date instances on the cache-hit path (regression)", async () => {
    // Shaped like real Firestore output: dates round-tripped to ISO strings.
    const cachedDoc = cachedStats({
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
    } as unknown as Partial<AggregatedStatsDoc>);

    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => true,
      data: () => cachedDoc,
    } as any);

    const result = await fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, currentFingerprint()
    );

    expect(result.fastestMileSegment!.date instanceof Date).toBe(true);
    expect(result.personalRecordsByYear.prs[0]!.date instanceof Date).toBe(true);
    expect(
      result.personalRecordsByYear.specificPrs[0]!.date instanceof Date
    ).toBe(true);
    // Null entries survive without throwing or fabricating a date.
    expect(result.personalRecordsByYear.prs[1]).toBeNull();
    expect(firestore.getDocs).toHaveBeenCalledTimes(1);
    expect(firestore.setDoc).not.toHaveBeenCalled();
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
      mockUid, mockWorkouts, maxHr, restingHr, races, currentFingerprint()
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
      mockUid, mockWorkouts, maxHr, restingHr, races, currentFingerprint()
    );

    expect(result.computationVersion).toBe(AGGREGATED_STATS_VERSION);
    expect(firestore.setDoc).toHaveBeenCalledTimes(1);
  });

  it("computes fresh data if latestWorkoutId mismatched", async () => {
    const cachedDoc = cachedStats({
      latestWorkoutId: "old-workout",
      freshnessFingerprint: {
        ...currentFingerprint(),
        latestWorkoutId: "old-workout",
      },
    });
    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => true,
      data: () => cachedDoc,
    } as any);
    vi.mocked(firestore.getDocs).mockResolvedValue({ docs: [] } as any);
    vi.mocked(firestore.setDoc).mockResolvedValue(undefined);

    const result = await fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, currentFingerprint()
    );

    expect(result.latestWorkoutId).toBe("workout1");
    expect(firestore.setDoc).toHaveBeenCalledTimes(1);
  });

  it("recomputes the main domain without rebuilding unchanged VO2 history", async () => {
    const sampleDate = "2026-08-19";
    const cachedDoc = cachedStats({
      freshnessFingerprint: {
        ...currentFingerprint(),
        maxHr: maxHr - 5,
      },
      vo2FreshnessKey: computeVo2FreshnessKey(sampleDate),
      vo2History: [{ date: sampleDate, value: 44 }],
    });
    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => true,
      data: () => cachedDoc,
    } as any);
    vi.mocked(firestore.getDocs).mockResolvedValue({
      docs: [
        { id: sampleDate, data: () => ({ date: sampleDate, vo2_max: 55 }) },
      ],
    } as any);
    vi.mocked(firestore.setDoc).mockResolvedValue(undefined);

    const result = await fetchAndComputeAggregatedStats(
      mockUid,
      mockWorkouts,
      maxHr,
      restingHr,
      races,
      currentFingerprint()
    );

    expect(result.freshnessFingerprint.maxHr).toBe(maxHr);
    expect(result.vo2History).toEqual(cachedDoc.vo2History);
    expect(firestore.getDocs).toHaveBeenCalledTimes(1);
    expect(firestore.setDoc).toHaveBeenCalledTimes(1);
  });

  it("updates only VO2 fields when the main fingerprint is still fresh", async () => {
    const cachedDoc = cachedStats({
      vo2FreshnessKey: computeVo2FreshnessKey("2026-08-18"),
      vo2History: [{ date: "2026-08-18", value: 44 }],
      trainingLoad: {
        series: [{ date: "2026-08-18", ctl: 10, atl: 12, tsb: -2 }],
      },
    });
    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => true,
      data: () => cachedDoc,
    } as any);
    vi.mocked(firestore.getDocs).mockResolvedValue({
      docs: [
        {
          id: "2026-08-20",
          data: () => ({ date: "2026-08-20", vo2_max: 51 }),
        },
      ],
    } as any);
    vi.mocked(firestore.setDoc).mockResolvedValue(undefined);

    const result = await fetchAndComputeAggregatedStats(
      mockUid,
      mockWorkouts,
      maxHr,
      restingHr,
      races,
      currentFingerprint()
    );

    expect(result.vo2History).toEqual([{ date: "2026-08-20", value: 51 }]);
    expect(result.vo2FreshnessKey).toEqual({
      latestVo2SampleDate: "2026-08-20",
    });
    expect(result.trainingLoad).toEqual(cachedDoc.trainingLoad);
    expect(mileSplitsCache.getMileSplits).not.toHaveBeenCalled();
    expect(firestore.setDoc).toHaveBeenCalledTimes(1);
  });

  it("self-repairs the production cache shape with a current key and empty history", async () => {
    const sampleDate = "2026-08-14";
    const cachedDoc = cachedStats({
      vo2FreshnessKey: computeVo2FreshnessKey(sampleDate),
      vo2History: [],
    });
    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => true,
      data: () => cachedDoc,
    } as any);
    vi.mocked(firestore.getDocs).mockResolvedValue({
      docs: [
        { id: sampleDate, data: () => ({ date: sampleDate, vo2_max: 50 }) },
      ],
    } as any);
    vi.mocked(firestore.setDoc).mockResolvedValue(undefined);

    const result = await fetchAndComputeAggregatedStats(
      mockUid,
      mockWorkouts,
      maxHr,
      restingHr,
      races,
      currentFingerprint()
    );

    expect(result.vo2History).toEqual([{ date: sampleDate, value: 50 }]);
    expect(result.trainingLoad).toEqual(cachedDoc.trainingLoad);
    expect(mileSplitsCache.getMileSplits).not.toHaveBeenCalled();
    expect(firestore.setDoc).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite a consistent VO2 cache when both domains are fresh", async () => {
    const sampleDate = "2026-08-14";
    const cachedDoc = cachedStats({
      vo2FreshnessKey: computeVo2FreshnessKey(sampleDate),
      vo2History: [{ date: sampleDate, value: 50 }],
    });
    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => true,
      data: () => cachedDoc,
    } as any);
    vi.mocked(firestore.getDocs).mockResolvedValue({
      docs: [
        { id: sampleDate, data: () => ({ date: sampleDate, vo2_max: 50 }) },
      ],
    } as any);

    const result = await fetchAndComputeAggregatedStats(
      mockUid,
      mockWorkouts,
      maxHr,
      restingHr,
      races,
      currentFingerprint()
    );

    expect(result).toEqual(cachedDoc);
    expect(firestore.getDocs).toHaveBeenCalledTimes(1);
    expect(firestore.setDoc).not.toHaveBeenCalled();
  });

  it("rebuilds poisoned VO2 history while also refreshing the main domain", async () => {
    const sampleDate = "2026-08-14";
    const cachedDoc = cachedStats({
      freshnessFingerprint: {
        ...currentFingerprint(),
        maxHr: maxHr - 5,
      },
      vo2FreshnessKey: computeVo2FreshnessKey(sampleDate),
      vo2History: [],
    });
    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => true,
      data: () => cachedDoc,
    } as any);
    vi.mocked(firestore.getDocs).mockResolvedValue({
      docs: [
        { id: sampleDate, data: () => ({ date: sampleDate, vo2_max: 50 }) },
      ],
    } as any);
    vi.mocked(firestore.setDoc).mockResolvedValue(undefined);

    const result = await fetchAndComputeAggregatedStats(
      mockUid,
      mockWorkouts,
      maxHr,
      restingHr,
      races,
      currentFingerprint()
    );

    expect(result.freshnessFingerprint.maxHr).toBe(maxHr);
    expect(result.vo2History).toEqual([{ date: sampleDate, value: 50 }]);
    expect(firestore.setDoc).toHaveBeenCalledTimes(1);
  });

  it("persists the observed VO2 date as the top-level baseline on recompute", async () => {
    const sampleDate = "2026-08-14";
    mockMissingCache();
    vi.mocked(firestore.getDocs)
      .mockResolvedValueOnce({
        docs: [
          { id: sampleDate, data: () => ({ date: sampleDate, vo2_max: 50 }) },
        ],
      } as any)
      .mockResolvedValueOnce({
        docs: [
          { id: sampleDate, data: () => ({ date: sampleDate, vo2_max: 50 }) },
        ],
      } as any);

    const result = await fetchAndComputeAggregatedStats(
      mockUid,
      mockWorkouts,
      maxHr,
      restingHr,
      races,
      currentFingerprint()
    );

    expect(result.latestVo2SampleDate).toBe(sampleDate);
    expect(result.vo2FreshnessKey.latestVo2SampleDate).toBe(sampleDate);
    expect(firestore.getDocs).toHaveBeenCalledTimes(2);
    expect(firestore.setDoc).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ latestVo2SampleDate: sampleDate })
    );
  });

  it("handles a legacy cache with no top-level VO2 baseline", async () => {
    const sampleDate = "2026-08-14";
    const cachedDoc = cachedStats({
      vo2FreshnessKey: computeVo2FreshnessKey(sampleDate),
      vo2History: [{ date: sampleDate, value: 50 }],
    });
    delete cachedDoc.latestVo2SampleDate;
    vi.mocked(firestore.getDoc).mockResolvedValue({
      exists: () => true,
      data: () => cachedDoc,
    } as any);
    vi.mocked(firestore.getDocs)
      .mockResolvedValueOnce({
        docs: [
          { id: sampleDate, data: () => ({ date: sampleDate, vo2_max: 50 }) },
        ],
      } as any)
      .mockResolvedValueOnce({
        docs: [
          { id: sampleDate, data: () => ({ date: sampleDate, vo2_max: 50 }) },
        ],
      } as any);
    vi.mocked(firestore.setDoc).mockResolvedValue(undefined);

    const result = await fetchAndComputeAggregatedStats(
      mockUid,
      mockWorkouts,
      maxHr,
      restingHr,
      races,
      currentFingerprint()
    );

    expect(result.latestVo2SampleDate).toBe(sampleDate);
    expect(result.vo2History).toEqual(cachedDoc.vo2History);
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
      mockUid, mockWorkouts, maxHr, restingHr, races, currentFingerprint()
    ).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => expect(firestore.setDoc).toHaveBeenCalledTimes(1));
    const overlapping = fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, currentFingerprint()
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

  it("collapses overlapping triggers and performs no route reads", async () => {
    mockMissingCache();

    const first = fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, currentFingerprint()
    );
    const second = fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, currentFingerprint()
    );

    expect(second).toBe(first);
    expect(firestore.getDoc).toHaveBeenCalledTimes(1);
    await Promise.all([first, second]);
    expect(firestore.setDoc).toHaveBeenCalledTimes(1);
  });

  it("does not deduplicate computations for different latest-workout keys", async () => {
    mockMissingCache();

    await Promise.all([
      fetchAndComputeAggregatedStats(
        mockUid, mockWorkouts, maxHr, restingHr, races, currentFingerprint()
      ),
      fetchAndComputeAggregatedStats(
        mockUid,
        mockWorkouts,
        maxHr,
        restingHr,
        races,
        { ...currentFingerprint(), latestWorkoutId: "workout2" }
      ),
    ]);

    expect(firestore.getDoc).toHaveBeenCalledTimes(2);
    expect(firestore.setDoc).toHaveBeenCalledTimes(2);
  });

  it("releases the lock after a successful computation", async () => {
    mockMissingCache();

    await fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, currentFingerprint()
    );
    await fetchAndComputeAggregatedStats(
      mockUid, mockWorkouts, maxHr, restingHr, races, currentFingerprint()
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
        mockUid, mockWorkouts, maxHr, restingHr, races, currentFingerprint()
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
        mockUid, mockWorkouts, maxHr, restingHr, races, currentFingerprint()
      )
    ).resolves.toEqual(expect.objectContaining({ latestWorkoutId }));
    expect(firestore.getDoc).toHaveBeenCalledTimes(2);
    expect(firestore.setDoc).toHaveBeenCalledTimes(2);
  });
});
