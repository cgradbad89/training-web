import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  computeAndStoreBestEfforts,
  fetchHealthWorkout,
  fetchHealthWorkoutsInRange,
  checkBestEffortsRouteGrowth,
  hasAttemptedBestEfforts,
} from "@/services/healthWorkouts";
import { evictRoute, getRoutePoints, isRouteCached } from "@/utils/routeCache";
import { getMileSplits } from "@/utils/mileSplitsCache";
import { fetchWeatherForRun } from "@/lib/weather";
import { BEST_EFFORTS_COMPUTATION_VERSION } from "@/utils/fastestMileSegment";
import {
  deleteOverride,
  excludeWorkout,
  fetchAllOverrides,
  fetchOverride,
  restoreWorkout,
  saveOverride,
} from "@/services/workoutOverrides";
import { fetchPlans } from "@/services/plans";
import { fetchShoes, fetchManualShoeAssignmentsMap, saveManualAssignments } from "@/services/shoes";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mocks
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "workout_123" }),
  usePathname: () => "/runs/workout_123",
  useRouter: () => ({ back: vi.fn() }),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

const authBoundary = vi.hoisted(() => ({ isSessionCurrent: () => true }));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { uid: "u1" }, sessionEpoch: 1, isSessionCurrent: authBoundary.isSessionCurrent }),
}));

const appData = vi.hoisted(() => ({
  patchOverrides: vi.fn(),
  workouts: [] as unknown[],
  races: [] as unknown[],
  overrides: {} as Record<string, unknown>,
  sourceHasLoaded: { workouts: true, overrides: true, races: true, plans: true, settings: true },
}));

// The page reads the shared workouts array for efficiency baselines and
// publishes successful override writes through patchOverrides.
vi.mock("@/contexts/AppDataContext", () => ({
  useAppData: () => ({
    workouts: appData.workouts,
    overrides: appData.overrides,
    patchOverrides: appData.patchOverrides,
    races: appData.races,
    sourceHasLoaded: appData.sourceHasLoaded,
    workoutsResolution: "success",
    racesResolution: "success",
    overridesResolution: "success",
  }),
}));

vi.mock("@/hooks/useUnsavedChanges", () => ({
  useUnsavedChanges: vi.fn(),
}));

// Mock services
vi.mock("@/services/healthWorkouts", () => ({
  fetchHealthWorkout: vi.fn(),
  fetchHealthWorkoutsInRange: vi.fn().mockResolvedValue([]),
  fetchLatestWorkoutId: vi.fn().mockResolvedValue(""),
  fetchWorkoutsByRouteCluster: vi.fn().mockResolvedValue([]),
  backfillRouteClusterIds: vi.fn().mockResolvedValue(undefined),
  computeAndStoreBestEfforts: vi.fn().mockResolvedValue(undefined),
  hasAttemptedBestEfforts: vi.fn().mockReturnValue(false),
  checkBestEffortsRouteGrowth: vi.fn().mockResolvedValue(false),
  saveRouteClusterId: vi.fn().mockResolvedValue(undefined),
  saveRunDetailCaches: vi.fn().mockResolvedValue(undefined),
  saveWeatherForWorkoutIfAbsent: vi.fn().mockResolvedValue("saved"),
}));
// The CTL-impact effect reads the aggregatedStats doc directly (getDoc). Keep it
// off the network: a non-existent snapshot forces the live-fallback path, which
// resolves to null over the (empty) mocked window reads.
vi.mock("firebase/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase/firestore")>();
  return {
    ...actual,
    getDoc: vi.fn().mockResolvedValue({ exists: () => false }),
  };
});
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
  getRouteCacheEpoch: () => 0,
  getRoutePoints: vi.fn(),
  isRouteCached: vi.fn().mockReturnValue(false),
  evictRoute: vi.fn(),
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

afterEach(() => {
  vi.mocked(fetchHealthWorkoutsInRange).mockReset().mockResolvedValue([]);
  vi.mocked(fetchAllOverrides).mockReset().mockResolvedValue({});
  vi.mocked(fetchOverride).mockReset().mockResolvedValue(null);
  vi.mocked(fetchPlans).mockReset().mockResolvedValue([]);
  appData.patchOverrides.mockReset();
  appData.workouts = [];
  appData.overrides = {};
});

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
        startDate: new Date("2024-01-01T10:00:00Z"),
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
    expect(getRoutePoints).toHaveBeenCalledWith("u1", "workout_123", { expectedPointCount: null });
  });

  it("handles a routeless workout gracefully (empty splits) and does not fetch weather", async () => {
    (fetchHealthWorkout as any).mockResolvedValue({
      workoutId: "workout_123",
      startDate: new Date("2024-01-01T10:00:00Z"),
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

  it("builds the viewed title from effective workouts in the narrow ±2-day window", async () => {
    const viewed = {
      workoutId: "workout_123",
      name: "Run",
      activityType: "running",
      displayType: "Run",
      startDate: new Date("2024-01-01T12:00:00Z"),
      endDate: new Date("2024-01-01T12:30:00Z"),
      distanceMiles: 3,
      durationSeconds: 1800,
      isRunLike: true,
      hasRoute: false,
      weather: null,
    };
    const competitor = { ...viewed, workoutId: "excluded", distanceMiles: 5 };
    const viewedOverride = {
      workoutId: "workout_123",
      userId: "u1",
      isExcluded: false,
      excludedAt: null,
      excludedReason: null,
      distanceMilesOverride: 5,
      durationSecondsOverride: null,
      runTypeOverride: null,
      updatedAt: "2024-01-02T00:00:00Z",
    };
    const excludedOverride = {
      ...viewedOverride,
      workoutId: "excluded",
      isExcluded: true,
      distanceMilesOverride: null,
    };
    vi.mocked(fetchHealthWorkout).mockResolvedValue(viewed as never);
    vi.mocked(fetchOverride).mockResolvedValue(viewedOverride as never);
    vi.mocked(fetchAllOverrides).mockResolvedValue({
      workout_123: viewedOverride,
      excluded: excludedOverride,
    } as never);
    vi.mocked(fetchHealthWorkoutsInRange).mockImplementation(
      (_uid: string, _start: Date, end?: Date) =>
        Promise.resolve((end ? [competitor, viewed] : []) as never)
    );
    vi.mocked(fetchPlans).mockResolvedValue([
      {
        id: "plan",
        name: "Plan",
        planType: "running",
        startDate: "2024-01-01",
        status: "active",
        isActive: true,
        createdAt: "2023-12-01T00:00:00Z",
        updatedAt: "2023-12-01T00:00:00Z",
        weeks: [
          {
            weekNumber: 1,
            entries: [
              {
                id: "entry",
                weekIndex: 0,
                weekday: 1,
                dayOfWeek: 0,
                distanceMiles: 5,
                runType: "longRun",
              },
            ],
          },
        ],
      },
    ] as never);
    vi.mocked(getRoutePoints).mockResolvedValue([]);
    vi.mocked(getMileSplits).mockResolvedValue([]);

    act(() => {
      root = createRoot(container);
      root.render(<RunDetailPage />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Long Run");
    expect(fetchHealthWorkoutsInRange).toHaveBeenCalledWith(
      "u1",
      expect.any(Date),
      expect.any(Date)
    );
  });

  it("fetches weather only after the (gated) route read resolves", async () => {
    let resolveRoute: (val: any) => void;
    const routePromise = new Promise((res) => { resolveRoute = res; });

    (fetchHealthWorkout as any).mockResolvedValue({
      workoutId: "workout_123",
      startDate: new Date("2024-01-01T10:00:00Z"),
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
    expect(getRoutePoints).toHaveBeenCalledWith("u1", "workout_123", { expectedPointCount: null });
    expect(fetchWeatherForRun).not.toHaveBeenCalled();

    // Resolve the route
    await act(async () => {
      resolveRoute!([{ lat: 40, lng: -74 }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchWeatherForRun).toHaveBeenCalledWith(40, -74, new Date("2024-01-01T10:00:00Z"));
  });
});

// ── GAP KPI + Total Ascent sublabels: cache-hit vs live fallback ──────────────
// Sharp edge #31: on the route-skip (cache-hit) path the GAP "flat" sublabel and
// the Total Ascent "Net ±X ft" sublabel must render from the cached
// gapAggregateGradeFlat / gapNetRiseM fields — not vanish because only
// gapSecPerMile was cached.

// A workout whose route-derived caches are ALL present & fresh, so the route
// read is skipped and everything renders from the doc. maxHr basis = 185
// (DEFAULT_MAX_HR, since fetchUserSettings resolves null), thresholdPace = null.
function cachedWorkout(
  overrides: Record<string, unknown>
): Record<string, unknown> {
  return {
    workoutId: "workout_123",
    startDate: new Date("2024-01-01T10:00:00Z"),
    distanceMiles: 3,
    durationSeconds: 1800,
    isRunLike: true,
    hasRoute: true,
    weather: { tempF: 60 }, // non-null so no weather backfill is attempted
    elevationGainM: 30, // Total Ascent renders a value (~98 ft)
    avgPaceSecPerMile: 500,
    gapSecPerMile: 490,
    routeClusterId: "cluster_a", // already assigned → no cluster backfill write
    bestEfforts: {
      "1mi": 500,
      "5k": null,
      "10k": null,
      "10mi": null,
      half: null,
      computedFromRouteComplete: true,
      computedFromPointCount: 1000,
      computationVersion: BEST_EFFORTS_COMPUTATION_VERSION,
    },
    overlayChartCache: {
      distancesMiles: [0, 1, 2, 3],
      paceSecPerMile: [500, 500, 500, 500],
      heartRateBpm: [150, 150, 150, 150],
      elevationFt: [0, 1, 2, 3],
      gapSecPerMile: [490, 490, 490, 490],
      sourcePointCount: 1000,
      computedAt: 1,
    },
    zoneBreakdown: {
      hrZones: [],
      paceZones: [],
      maxHr: 185,
      thresholdPaceSecPerMile: null,
      computedAt: 1,
    },
    simplifiedPath: [
      { lat: 40, lng: -105 },
      { lat: 41, lng: -106 },
    ],
    ...overrides,
  };
}

// mileSplits subcollection docs that make cachedGapPerMile() non-null (every
// mile 1..3 carries a gap under the matching basis) so the gate's splitsHaveGap
// arm is satisfied and the route read is skipped.
const CACHED_MILE_DOCS = [1, 2, 3].map((mile) => ({
  id: `m${mile}`,
  mile,
  distanceMiles: 1,
  paceSecPerMile: 500,
  gapSecPerMile: 490,
  basisTotalMiles: 3,
}));

describe("RunDetailPage GAP/elevation sublabels", () => {
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

  async function renderSettled() {
    act(() => {
      root = createRoot(container);
      root.render(<RunDetailPage />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("renders the Net ±ft sublabel from the cached gapNetRiseM (route skipped)", async () => {
    // Downhill run: gapNetRiseM −30.48 m → −100 ft. Not flat → no "flat" label.
    (fetchHealthWorkout as any).mockResolvedValue(
      cachedWorkout({ gapNetRiseM: -30.48, gapAggregateGradeFlat: false })
    );
    (getMileSplits as any).mockResolvedValue(CACHED_MILE_DOCS);
    (getRoutePoints as any).mockResolvedValue([]);

    await renderSettled();

    // Fully cached → the big route read is skipped entirely.
    expect(getRoutePoints).not.toHaveBeenCalled();
    // Net sublabel present, sourced from the cache (U+2212 minus for negative).
    expect(container.textContent).toContain("Net −100 ft");
    // Non-flat run → the GAP KPI carries no "flat" sublabel.
    expect(container.textContent).not.toContain("flat");
  });

  it("renders the GAP 'flat' sublabel from the cached gapAggregateGradeFlat (route skipped)", async () => {
    // Flat run: aggregate grade resolved to flat, net rise 0.
    (fetchHealthWorkout as any).mockResolvedValue(
      cachedWorkout({ gapNetRiseM: 0, gapAggregateGradeFlat: true })
    );
    (getMileSplits as any).mockResolvedValue(CACHED_MILE_DOCS);
    (getRoutePoints as any).mockResolvedValue([]);

    await renderSettled();

    expect(getRoutePoints).not.toHaveBeenCalled();
    expect(container.textContent).toContain("flat");
    expect(container.textContent).toContain("Net 0 ft");
  });

  it("forces one route read when the best-effort computation version is stale", async () => {
    (fetchHealthWorkout as any).mockResolvedValue(
      cachedWorkout({
        gapNetRiseM: 0,
        gapAggregateGradeFlat: true,
        bestEfforts: {
          "1mi": 500,
          "5k": null,
          "10k": null,
          "10mi": null,
          half: null,
          computedFromRouteComplete: true,
          computedFromPointCount: 1000,
          computationVersion: 0,
        },
      })
    );
    (getMileSplits as any).mockResolvedValue(CACHED_MILE_DOCS);
    (getRoutePoints as any).mockResolvedValue([
      { index: 0, lat: 0, lng: 0, timestamp: "2026-01-01T12:00:00Z" },
      { index: 1, lat: 0, lng: 0.02, timestamp: "2026-01-01T12:10:00Z" },
    ]);

    await renderSettled();

    expect(getRoutePoints).toHaveBeenCalledTimes(1);
    expect(computeAndStoreBestEfforts).toHaveBeenCalledWith(
      "u1",
      "workout_123",
      expect.any(Array),
      true,
      expect.objectContaining({ isCurrent: expect.any(Function) })
    );
  });

  describe("best-effort cache integrity on Run Detail", () => {
    const FULL_ROUTE = Array.from({ length: 5412 }, (_, i) => ({ index: i, lat: i * 0.00001, lng: 0, timestamp: new Date(Date.UTC(2026, 10, 7, 14, 0, i)).toISOString() }));
    const NULLS = { "1mi": null, "5k": null, "10k": null, "10mi": null, half: null };
    const longRun = (bestEfforts: Record<string, unknown>) => cachedWorkout({
      gapNetRiseM: 0, gapAggregateGradeFlat: true, distanceMiles: 9.18, durationSeconds: 5413, bestEfforts,
    });
    beforeEach(() => {
      vi.mocked(getMileSplits).mockResolvedValue(CACHED_MILE_DOCS as never);
      vi.mocked(getRoutePoints).mockResolvedValue(FULL_ROUTE as never);
      vi.mocked(hasAttemptedBestEfforts).mockReturnValue(false);
      vi.mocked(isRouteCached).mockReturnValue(false);
      vi.mocked(checkBestEffortsRouteGrowth).mockResolvedValue(false);
    });

    it("recovers a v2 'complete' all-null record computed from a truncated route: reads the route once and passes the workout facts", async () => {
      vi.mocked(fetchHealthWorkout).mockResolvedValue(longRun({ ...NULLS, computedFromRouteComplete: true, computedFromPointCount: 400, computationVersion: BEST_EFFORTS_COMPUTATION_VERSION }) as never);
      await renderSettled();
      expect(getRoutePoints).toHaveBeenCalledTimes(1);
      expect(computeAndStoreBestEfforts).toHaveBeenCalledWith("u1", "workout_123", FULL_ROUTE, true,
        expect.objectContaining({ facts: { distanceMiles: 9.18, durationSeconds: 5413 }, existing: expect.objectContaining({ computedFromPointCount: 400 }) }));
    });

    // The default fixture (3 mi, 30 min, every other route cache present) needs a route read ONLY for a best-effort reason.
    const small = (bestEfforts: Record<string, unknown>) => cachedWorkout({ gapNetRiseM: 0, gapAggregateGradeFlat: true, bestEfforts });
    const TRUNC = { ...NULLS, computedFromRouteComplete: true, computedFromPointCount: 100, computationVersion: BEST_EFFORTS_COMPUTATION_VERSION };

    it("does not read the route or recompute for a valid, current record (idempotent revisit)", async () => {
      vi.mocked(fetchHealthWorkout).mockResolvedValue(small({ "1mi": 540, "5k": null, "10k": null, "10mi": null, half: null, computedFromRouteComplete: true, computedFromPointCount: 1700, computationVersion: BEST_EFFORTS_COMPUTATION_VERSION }) as never);
      await renderSettled();
      expect(getRoutePoints).not.toHaveBeenCalled(); expect(computeAndStoreBestEfforts).not.toHaveBeenCalled();
    });

    it("a truncated-looking record on a fully cached run DOES force exactly one route read (the integrity reason alone)", async () => {
      vi.mocked(fetchHealthWorkout).mockResolvedValue(small(TRUNC) as never);
      await renderSettled();
      expect(getRoutePoints).toHaveBeenCalledTimes(1); expect(computeAndStoreBestEfforts).toHaveBeenCalledTimes(1);
    });

    it("does not retry in the same session against the same unchanged record", async () => {
      vi.mocked(hasAttemptedBestEfforts).mockReturnValue(true);
      vi.mocked(fetchHealthWorkout).mockResolvedValue(small(TRUNC) as never);
      await renderSettled();
      expect(getRoutePoints).not.toHaveBeenCalled(); expect(computeAndStoreBestEfforts).not.toHaveBeenCalled();
    });

    it("accepts a legitimately unavailable record after its bounded retries (no route read)", async () => {
      vi.mocked(fetchHealthWorkout).mockResolvedValue(small({ ...TRUNC, verificationAttempts: 2 }) as never);
      await renderSettled();
      expect(getRoutePoints).not.toHaveBeenCalled(); expect(computeAndStoreBestEfforts).not.toHaveBeenCalled();
    });

    it("re-opens an exhausted record only when independent evidence shows its route has grown", async () => {
      vi.mocked(checkBestEffortsRouteGrowth).mockResolvedValue(true);
      vi.mocked(fetchHealthWorkout).mockResolvedValue(small({ ...TRUNC, verificationAttempts: 2 }) as never);
      await renderSettled();
      expect(checkBestEffortsRouteGrowth).toHaveBeenCalledTimes(1);
      expect(getRoutePoints).toHaveBeenCalledTimes(1);
      expect(computeAndStoreBestEfforts).toHaveBeenCalledWith("u1", "workout_123", expect.any(Array), true, expect.objectContaining({ routeGrew: true }));
    });

    it("keeps a sparse route bounded: an unchanged route count triggers no route read and no recompute", async () => {
      vi.mocked(checkBestEffortsRouteGrowth).mockResolvedValue(false);
      vi.mocked(fetchHealthWorkout).mockResolvedValue(small({ ...TRUNC, verificationAttempts: 2 }) as never);
      await renderSettled();
      expect(checkBestEffortsRouteGrowth).toHaveBeenCalledTimes(1);
      expect(getRoutePoints).not.toHaveBeenCalled(); expect(computeAndStoreBestEfforts).not.toHaveBeenCalled();
    });

    it("never runs the growth check for a record that still has retries or is valid (no extra count read on normal visits)", async () => {
      vi.mocked(fetchHealthWorkout).mockResolvedValue(small({ "1mi": 540, "5k": null, "10k": null, "10mi": null, half: null, computedFromRouteComplete: true, computedFromPointCount: 1700, computationVersion: BEST_EFFORTS_COMPUTATION_VERSION }) as never);
      await renderSettled();
      expect(checkBestEffortsRouteGrowth).not.toHaveBeenCalled();
    });

    it("waits (no route read) while a partial-route record's route is still incomplete", async () => {
      vi.mocked(fetchHealthWorkout).mockResolvedValue(cachedWorkout({ gapNetRiseM: 0, gapAggregateGradeFlat: true, routeComplete: false,
        bestEfforts: { ...NULLS, "1mi": 500, computedFromRouteComplete: false, computedFromPointCount: 300, computationVersion: BEST_EFFORTS_COMPUTATION_VERSION } }) as never);
      await renderSettled();
      expect(computeAndStoreBestEfforts).not.toHaveBeenCalled();
    });

    it("a route cached in memory while it was still uploading is evicted and re-read once before recovering", async () => {
      vi.mocked(isRouteCached).mockReturnValue(true);
      vi.mocked(getRoutePoints).mockResolvedValueOnce(FULL_ROUTE.slice(0, 400) as never).mockResolvedValue(FULL_ROUTE as never);
      vi.mocked(fetchHealthWorkout).mockResolvedValue(longRun({ ...NULLS, computedFromRouteComplete: true, computedFromPointCount: 400, computationVersion: BEST_EFFORTS_COMPUTATION_VERSION }) as never);
      await renderSettled();
      expect(evictRoute).toHaveBeenCalledWith("u1", "workout_123"); expect(getRoutePoints).toHaveBeenCalledTimes(2);
      expect(computeAndStoreBestEfforts).toHaveBeenCalledWith("u1", "workout_123", FULL_ROUTE, true, expect.any(Object));
    });
  });

  it("falls back to the live GAP computation when the cached sublabel fields are absent", async () => {
    // A legacy doc cached gapSecPerMile only (no sublabel fields) → the gate
    // treats it as incomplete, the route IS read, and the sublabels come from
    // the freshly computed RunGap. A constant-altitude route → aggregate grade
    // flat → the live path shows "flat".
    (fetchHealthWorkout as any).mockResolvedValue(
      cachedWorkout({ gapNetRiseM: undefined, gapAggregateGradeFlat: undefined })
    );
    (getMileSplits as any).mockResolvedValue(CACHED_MILE_DOCS);
    // ~11 m spacing at the equator, 1 s apart, constant altitude 100 m.
    const flatRoute = Array.from({ length: 12 }, (_, i) => ({
      index: i,
      lat: 0,
      lng: i * 0.0001,
      altitude: 100,
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      speed: 10,
      hr: 150,
    }));
    (getRoutePoints as any).mockResolvedValue(flatRoute);

    await renderSettled();

    // Cache was incomplete → the route read happened (self-heal path).
    expect(getRoutePoints).toHaveBeenCalledWith("u1", "workout_123", { expectedPointCount: null });
    // Live-computed flat aggregate grade → GAP KPI labelled "flat".
    expect(container.textContent).toContain("flat");
  });
});

// ── Shared override continuity ───────────────────────────────────────────────

function mutationWorkout(): Record<string, unknown> {
  return {
    workoutId: "workout_123",
    name: "Run",
    activityType: "running",
    displayType: "Run",
    startDate: new Date("2026-08-24T10:00:00Z"),
    endDate: new Date("2026-08-24T10:30:00Z"),
    durationSeconds: 1800,
    sourceName: "Test",
    isRunLike: true,
    hasRoute: false,
    hasHRStream: false,
    syncedAt: new Date("2026-08-24T10:31:00Z"),
    calories: 300,
    avgHeartRate: 145,
    distanceMiles: 3,
    distanceMeters: 4828,
    avgPaceSecPerMile: 600,
    avgSpeedMPS: null,
    hrDriftPct: null,
    cadenceSPM: null,
    efficiencyRaw: null,
    efficiencyScore: null,
    elevationGainM: null,
    weather: null,
  };
}

function workoutOverride(
  overrides: Partial<import("@/types/workoutOverride").WorkoutOverride> = {}
): import("@/types/workoutOverride").WorkoutOverride {
  return {
    workoutId: "workout_123",
    userId: "u1",
    isExcluded: false,
    excludedAt: null,
    excludedReason: null,
    distanceMilesOverride: null,
    durationSecondsOverride: null,
    runTypeOverride: null,
    updatedAt: "2026-08-29T12:00:00.000Z",
    ...overrides,
  };
}

describe("RunDetailPage shared override continuity", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
    vi.mocked(fetchHealthWorkout).mockResolvedValue(mutationWorkout() as never);
    vi.mocked(fetchOverride).mockResolvedValue(null);
    vi.mocked(getMileSplits).mockResolvedValue([]);
    vi.mocked(getRoutePoints).mockResolvedValue([]);
    vi.mocked(saveOverride).mockImplementation(async (_uid, value) => value);
    vi.mocked(deleteOverride).mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
  });

  async function renderSettled() {
    await act(async () => {
      root = createRoot(container);
      root.render(<RunDetailPage />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function lastPatchedMap(
    initial: Record<string, import("@/types/workoutOverride").WorkoutOverride> = {}
  ) {
    const updater = appData.patchOverrides.mock.calls.at(-1)?.[0] as
      | ((prev: typeof initial) => typeof initial)
      | undefined;
    expect(updater).toBeTypeOf("function");
    return updater!(initial);
  }

  function setInput(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("publishes distance, duration, and run-type overrides after persistence", async () => {
    await renderSettled();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Edit workout"]')!.click();
    });
    const numberInput = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    const durationInput = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    await act(async () => {
      setInput(numberInput, "4.2");
      setInput(durationInput, "40:00");
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Treadmill Run"
      )!.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Save Changes"
      )!.click();
      await Promise.resolve();
    });

    expect(saveOverride).toHaveBeenCalledTimes(1);
    expect(lastPatchedMap().workout_123).toMatchObject({
      distanceMilesOverride: 4.2,
      durationSecondsOverride: 2400,
      runTypeOverride: "Treadmill Run",
    });
  });

  it("publishes exclusion only after excludeWorkout succeeds", async () => {
    const excluded = workoutOverride({
      isExcluded: true,
      excludedAt: "2026-08-29T12:00:00.000Z",
    });
    vi.mocked(excludeWorkout).mockResolvedValue(excluded);
    await renderSettled();

    await act(async () => {
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Exclude"
      )!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!.click();
      await Promise.resolve();
    });

    expect(lastPatchedMap().workout_123).toEqual(excluded);
  });

  it("restore removes the shared entry when persistence deletes the document", async () => {
    const excluded = workoutOverride({ isExcluded: true });
    vi.mocked(fetchOverride).mockResolvedValue(excluded);
    vi.mocked(restoreWorkout).mockResolvedValue(null);
    await renderSettled();

    await act(async () => {
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Restore"
      )!.click();
      await Promise.resolve();
    });

    expect(lastPatchedMap({ workout_123: excluded })).toEqual({});
  });

  it("restore retains field overrides while clearing the shared exclusion", async () => {
    const excluded = workoutOverride({
      isExcluded: true,
      distanceMilesOverride: 4,
    });
    const restored = workoutOverride({
      isExcluded: false,
      distanceMilesOverride: 4,
    });
    vi.mocked(fetchOverride).mockResolvedValue(excluded);
    vi.mocked(restoreWorkout).mockResolvedValue(restored);
    await renderSettled();

    await act(async () => {
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Restore"
      )!.click();
      await Promise.resolve();
    });

    expect(lastPatchedMap({ workout_123: excluded }).workout_123).toEqual(restored);
  });

  it("reset/delete removes the shared override effect", async () => {
    const edited = workoutOverride({ distanceMilesOverride: 4 });
    vi.mocked(fetchOverride).mockResolvedValue(edited);
    await renderSettled();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Edit workout"]')!.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Reset to Original")
      )!.click();
      await Promise.resolve();
    });

    expect(deleteOverride).toHaveBeenCalledWith("u1", "workout_123");
    expect(lastPatchedMap({ workout_123: edited })).toEqual({});
  });

  it.each(["success", "failure"])("shoe assignment %s keeps the raw map consistent on re-derivation", async outcome => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(fetchShoes).mockResolvedValue(["A", "B"].map(id => ({ id, name: `Shoe ${id}`, brand: "", model: "", startMileageOffset: 0, isRetired: false, addedAt: "2026-01-01" })));
    vi.mocked(fetchManualShoeAssignmentsMap).mockResolvedValue({ workout_123: "A" });
    if (outcome === "success") vi.mocked(saveManualAssignments).mockResolvedValue(undefined);
    else vi.mocked(saveManualAssignments).mockRejectedValue(new Error("offline"));
    await renderSettled();
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Edit workout"]')!.click());
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>("select")!;
      select.value = "B"; select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Save Changes")!.click());
    expect(saveManualAssignments).toHaveBeenCalledWith("u1", { workout_123: "B" });
    if (outcome === "failure") await act(async () => Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Cancel")!.click());
    // Reopening derives the form from the canonical assignment, not its draft.
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Edit workout"]')!.click());
    expect(container.querySelector<HTMLSelectElement>("select")!.value).toBe(outcome === "success" ? "B" : "A");
    vi.mocked(fetchShoes).mockResolvedValue([]);
    vi.mocked(fetchManualShoeAssignmentsMap).mockResolvedValue({});
    errorSpy.mockRestore();
  });

  it("does not publish a failed persistence attempt", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(saveOverride).mockRejectedValue(new Error("write failed"));
    await renderSettled();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="Edit workout"]')!.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Save Changes"
      )!.click();
      await Promise.resolve();
    });

    expect(appData.patchOverrides).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
