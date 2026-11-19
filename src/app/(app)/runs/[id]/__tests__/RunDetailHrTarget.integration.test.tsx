import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fetchHealthWorkout, fetchHealthWorkoutsInRange } from "@/services/healthWorkouts";
import { getRoutePoints } from "@/utils/routeCache";
import { getMileSplits } from "@/utils/mileSplitsCache";
import { fetchAllOverrides, fetchOverride } from "@/services/workoutOverrides";
import { fetchPlans } from "@/services/plans";
import { fetchHRStream } from "@/services/hrStream";

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

vi.mock("@/services/hrStream", () => ({
  fetchHRStream: vi.fn(),
}));

import RunDetailPage from "../page";

/** Integration: the "Heart rate vs target" card and its conditional hrStream read. */

function viewed(overrides: Record<string, unknown> = {}) {
  return {
    workoutId: "workout_123",
    name: "Run",
    activityType: "running",
    displayType: "Run",
    startDate: new Date("2024-01-01T12:00:00Z"),
    endDate: new Date("2024-01-01T12:30:00Z"),
    distanceMiles: 5,
    durationSeconds: 3000,
    isRunLike: true,
    hasRoute: false,
    avgHeartRate: 140,
    hasHRStream: true,
    weather: null,
    ...overrides,
  };
}

function planWith(entry: Record<string, unknown>) {
  return {
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
          { id: "entry", weekIndex: 0, weekday: 1, dayOfWeek: 0, distanceMiles: 5, runType: "outdoor", ...entry },
        ],
      },
    ],
  };
}

// 1 Hz stream: 5 s at 120 then 5 s at 145 (cap 135) → 50% above.
const STREAM = Array.from({ length: 11 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2024, 0, 1, 12, 0, i)).toISOString(),
  hr: i < 5 ? 120 : i < 10 ? 145 : 120,
}));

describe("RunDetailPage — Heart rate vs target card", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(workout: Record<string, unknown>, plan: unknown | null) {
    vi.mocked(fetchHealthWorkout).mockResolvedValue(workout as never);
    vi.mocked(fetchOverride).mockResolvedValue(null);
    vi.mocked(fetchAllOverrides).mockResolvedValue({});
    vi.mocked(fetchHealthWorkoutsInRange).mockImplementation(
      (_uid: string, _start: Date, end?: Date) => Promise.resolve((end ? [workout] : []) as never)
    );
    vi.mocked(fetchPlans).mockResolvedValue((plan ? [plan] : []) as never);
    vi.mocked(getRoutePoints).mockResolvedValue([]);
    vi.mocked(getMileSplits).mockResolvedValue([]);
    vi.mocked(fetchHRStream).mockResolvedValue(STREAM);
    act(() => {
      root = createRoot(container);
      root.render(<RunDetailPage />);
    });
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
  });

  it("easy cap entry on a run with an hrStream: card + one hrStream read + time above cap", async () => {
    await mount(viewed(), planWith({ workoutType: "easy", targetHr: { minBpm: null, maxBpm: 135 } }));
    expect(container.querySelector('[data-testid="hr-target-card"]')).toBeTruthy();
    expect(container.textContent).toContain("Heart rate vs target");
    expect(container.textContent).toContain("≤ 135");
    expect(container.textContent).toContain("Avg 140 · over by 5");
    expect(fetchHRStream).toHaveBeenCalledTimes(1);
    expect(fetchHRStream).toHaveBeenCalledWith("u1", "workout_123");
    expect(container.querySelector('[data-testid="hr-time-above"]')?.textContent).toBe(
      "50% of time under 135 · 50% above"
    );
  });

  it("works from the legacy cap alone (no targetHr)", async () => {
    await mount(viewed(), planWith({ workoutType: "long", runType: "longRun", targetHeartRate: 135 }));
    expect(container.textContent).toContain("≤ 135");
    expect(fetchHRStream).toHaveBeenCalledTimes(1);
  });

  it("does not read hrStream when the workout has none (card still shows, no time-above row)", async () => {
    await mount(viewed({ hasHRStream: false }), planWith({ workoutType: "easy", targetHr: { minBpm: null, maxBpm: 135 } }));
    expect(container.querySelector('[data-testid="hr-target-card"]')).toBeTruthy();
    expect(fetchHRStream).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="hr-time-above"]')).toBeNull();
  });

  it("tempo range entry: whole-run label, no time-above, no hrStream read", async () => {
    await mount(viewed({ avgHeartRate: 150 }), planWith({ workoutType: "tempo", targetHr: { minBpm: 146, maxBpm: 155 } }));
    expect(container.textContent).toContain("146–155");
    expect(container.textContent).toContain("Whole-run average (incl. warm-up/cool-down)");
    expect(container.textContent).toContain("Avg 150 · on target");
    expect(fetchHRStream).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="hr-time-above"]')).toBeNull();
  });

  it("race entry with a cap: card shows, but no hrStream read", async () => {
    await mount(viewed(), planWith({ workoutType: "race", targetHeartRate: 160 }));
    expect(container.querySelector('[data-testid="hr-target-card"]')).toBeTruthy();
    expect(fetchHRStream).not.toHaveBeenCalled();
  });

  it("no plan match: no card and no hrStream read", async () => {
    await mount(viewed(), null);
    expect(container.querySelector('[data-testid="hr-target-card"]')).toBeNull();
    expect(fetchHRStream).not.toHaveBeenCalled();
  });

  it("matched entry without any HR target: no card and no hrStream read", async () => {
    await mount(viewed(), planWith({ workoutType: "long", runType: "longRun", notes: "HR <135 / 145-155 bpm" }));
    expect(container.querySelector('[data-testid="hr-target-card"]')).toBeNull();
    expect(fetchHRStream).not.toHaveBeenCalled();
  });
});
