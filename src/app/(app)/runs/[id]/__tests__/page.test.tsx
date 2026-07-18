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
  fetchHealthWorkoutsInRange: vi.fn().mockResolvedValue([]),
  fetchLatestWorkoutId: vi.fn().mockResolvedValue(""),
  fetchWorkoutsByRouteCluster: vi.fn().mockResolvedValue([]),
  backfillRouteClusterIds: vi.fn().mockResolvedValue(undefined),
  computeAndStoreBestEfforts: vi.fn().mockResolvedValue(undefined),
  saveRouteClusterId: vi.fn().mockResolvedValue(undefined),
  saveRunDetailCaches: vi.fn().mockResolvedValue(undefined),
  saveWeatherForWorkout: vi.fn().mockResolvedValue(undefined),
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
    expect(getRoutePoints).toHaveBeenCalledWith("u1", "workout_123");
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
    expect(getRoutePoints).toHaveBeenCalledWith("u1", "workout_123");
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
    expect(getRoutePoints).toHaveBeenCalledWith("u1", "workout_123");
    // Live-computed flat aggregate grade → GAP KPI labelled "flat".
    expect(container.textContent).toContain("flat");
  });
});
