import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { RoutePoint } from "@/services/routes";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({
  path: "/runs/synthetic-run", epoch: 1, currentEpoch: 1,
  sessionGuard: vi.fn(),
  workout: null as HealthWorkout | null,
  splitRead: vi.fn(), routeRead: vi.fn(), cacheWrite: vi.fn(), splitWrite: vi.fn(),
  bestEfforts: vi.fn(), weather: vi.fn(), cluster: vi.fn(), backfill: vi.fn(),
  hydrate: vi.fn(), impact: vi.fn(), fetchRaces: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "synthetic-run" }), usePathname: () => h.path, useRouter: () => ({ back: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { uid: "synthetic-owner" }, sessionEpoch: h.epoch, isSessionCurrent: h.sessionGuard }) }));
// Stable identities, as the real provider publishes them (the page derives from them in memos).
const appData = vi.hoisted(() => ({
  value: {
    workouts: [] as unknown[], races: [] as unknown[], overrides: {} as Record<string, unknown>, patchOverrides: () => {},
    sourceHasLoaded: { workouts: true, overrides: true, races: true, plans: true, settings: true },
    workoutsResolution: "success", racesResolution: "success", overridesResolution: "success",
  },
}));
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => appData.value }));
vi.mock("@/hooks/useUnsavedChanges", () => ({ useUnsavedChanges: vi.fn() }));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({ doc: vi.fn(), getDoc: async () => ({ exists: () => false }) }));
vi.mock("@/services/healthWorkouts", () => ({
  fetchHealthWorkout: async () => h.workout,
  fetchHealthWorkoutsInRange: async () => [], fetchLatestWorkoutId: async () => null,
  fetchWorkoutsByRouteCluster: async () => [],
  saveRunDetailCaches: h.cacheWrite, computeAndStoreBestEfforts: h.bestEfforts, hasAttemptedBestEfforts: () => false, checkBestEffortsRouteGrowth: async () => false,
  saveWeatherForWorkoutIfAbsent: h.weather, saveRouteClusterId: h.cluster, backfillRouteClusterIds: h.backfill,
}));
vi.mock("@/services/shoes", () => ({ fetchShoes: async () => [], fetchManualShoeAssignmentsMap: async () => ({}), saveManualAssignments: vi.fn() }));
vi.mock("@/services/workoutOverrides", () => ({ fetchOverride: async () => null, fetchAllOverrides: async () => ({}), saveOverride: vi.fn(), deleteOverride: vi.fn(), excludeWorkout: vi.fn(), restoreWorkout: vi.fn() }));
vi.mock("@/services/userSettings", () => ({ fetchUserSettings: async () => null }));
vi.mock("@/services/races", () => ({ fetchRaces: h.fetchRaces }));
vi.mock("@/services/plans", () => ({ fetchPlans: async () => [] }));
vi.mock("@/services/fastFinishSplits", () => ({ hydrateFastFinishSplits: h.hydrate }));
vi.mock("@/utils/runImpact", async importOriginal => ({ ...await importOriginal<typeof import("@/utils/runImpact")>(), computeRunImpact: h.impact }));
vi.mock("@/utils/routeCache", () => ({ getRoutePoints: h.routeRead, isRouteCached: () => false, evictRoute: vi.fn() }));
vi.mock("@/utils/mileSplitsCache", () => ({ getMileSplits: h.splitRead, saveMileSplitCache: h.splitWrite }));
vi.mock("@/utils/bestEfforts", async importOriginal => ({ ...await importOriginal<typeof import("@/utils/bestEfforts")>(), shouldRecomputeBestEfforts: () => false, assessBestEffortsCache: () => ({ state: "valid_current", recompute: false, reasons: [] }) }));
vi.mock("@/lib/weather", () => ({ fetchWeatherForRun: async () => null }));

import RunDetailPage from "../page";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const points: RoutePoint[] = Array.from({ length: 20 }, (_, index) => ({
  index, lat: 38 + index * 0.001, lng: -77, altitude: 10,
  timestamp: new Date(Date.UTC(2026, 9, 14, 12, 0, index * 30)).toISOString(), speed: 3, hr: 140,
}));
let root: Root;
let container: HTMLDivElement;
async function render() { await act(async () => { root.render(<RunDetailPage />); }); }
beforeEach(() => {
  h.path = "/runs/synthetic-run"; h.epoch = 1; h.currentEpoch = 1;
  h.sessionGuard.mockImplementation((epoch: number) => epoch === h.currentEpoch);
  h.workout = { workoutId: "synthetic-run", name: "Synthetic Run", displayType: "Run", activityType: "running", startDate: new Date("2026-10-14T12:00:00Z"), endDate: new Date("2026-10-14T12:10:00Z"), syncedAt: new Date(), durationSeconds: 600, distanceMiles: 1.3, distanceMeters: 2092, hasRoute: true, routeComplete: true, isRunLike: true, avgHeartRate: 140, avgPaceSecPerMile: 460, avgSpeedMPS: 3.5, calories: 100, sourceName: "Synthetic", hrDriftPct: null, cadenceSPM: null, efficiencyRaw: null, efficiencyScore: null, elevationGainM: 0, routeClusterId: "already-clustered" };
  for (const fn of [h.splitRead, h.routeRead, h.cacheWrite, h.splitWrite, h.bestEfforts, h.weather, h.cluster, h.backfill]) fn.mockReset();
  h.hydrate.mockReset().mockResolvedValue({ runs: [], routeFetches: 0 });
  h.impact.mockReset().mockReturnValue(null);
  h.fetchRaces.mockReset().mockResolvedValue([]);
  h.splitRead.mockResolvedValue([]); h.routeRead.mockResolvedValue(points);
  h.cacheWrite.mockResolvedValue(undefined); h.splitWrite.mockResolvedValue(undefined); h.backfill.mockResolvedValue(0);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });


const NOV7_STALE_SPLITS = [
  { id: "000", mile: 1, distanceMiles: 1, paceSecPerMile: 43.5, gapSecPerMile: 576, isPartial: false, basisTotalMiles: 1.3, avgBpm: 150, sampleCount: 100 },
  { id: "001", mile: 2, distanceMiles: 0.3, paceSecPerMile: 42.8, gapSecPerMile: 570, isPartial: true, basisTotalMiles: 1.3, avgBpm: 152, sampleCount: 30 },
];
/** The Nov 7 shape: parent reports 20 route docs; every cache was built from a sliver. */
function staleParent(): HealthWorkout {
  return {
    ...h.workout!,
    routePointCount: 20,
    simplifiedPath: [{ lat: 38, lng: -77 }, { lat: 38.0005, lng: -77 }],
    gapSecPerMile: 440, gapNetRiseM: 0, gapAggregateGradeFlat: true,
    zoneBreakdown: {
      hrZones: [{ zone: 3, label: "Tempo", seconds: 40, pct: 100 }] as never,
      paceZones: [{ zone: 3, label: "Threshold", secondsInZone: 42, percent: 100 }] as never,
      maxHr: 190, thresholdPaceSecPerMile: null, computedAt: 1,
    },
  };
}

describe("Run Detail recovers caches built from a partial route", () => {
  it("recomputes splits, zones, GAP and map path from the complete route, stamps the basis, then stays quiet", async () => {
    h.workout = staleParent();
    h.splitRead.mockResolvedValue(NOV7_STALE_SPLITS);
    h.cacheWrite.mockImplementation(async (_uid, _id, updates) => { h.workout = { ...h.workout!, ...updates }; });
    h.splitWrite.mockImplementation(async (_uid, _id, writes) => {
      h.splitRead.mockResolvedValue(writes.map((write: { docId: string; data: object }) => ({ id: write.docId, ...write.data })));
    });
    await render();

    expect(h.routeRead).toHaveBeenCalledOnce();
    expect(h.routeRead.mock.calls[0][2]).toEqual({ expectedPointCount: 20 });
    // Splits: realistic paces (~7:15/mi for this synthetic route), stamped with the full count.
    expect(h.splitWrite).toHaveBeenCalledOnce();
    const writes = h.splitWrite.mock.calls[0][2] as { docId: string; data: { paceSecPerMile: number; basisRoutePointCount: number } }[];
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w.data.paceSecPerMile).toBeGreaterThan(300);
      expect(w.data.basisRoutePointCount).toBe(20);
    }
    // iOS doc ids were reused as merge targets, never replaced.
    expect(writes.map(w => w.docId)).toEqual(["000", "001"]);
    // Parent caches recomputed together and stamped.
    expect(h.cacheWrite).toHaveBeenCalledOnce();
    const updates = h.cacheWrite.mock.calls[0][2];
    expect(updates.routeCacheBasisPointCount).toBe(20);
    expect(updates).toHaveProperty("zoneBreakdown"); expect(updates).toHaveProperty("gapSecPerMile");
    expect(updates.simplifiedPath.length).toBeGreaterThanOrEqual(2);
    expect(updates.zoneBreakdown.hrZones.reduce((a: number, z: { seconds: number }) => a + z.seconds, 0)).toBeGreaterThan(400);

    // Idempotent: a later view reads no route and writes nothing.
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(h.routeRead).toHaveBeenCalledOnce(); expect(h.cacheWrite).toHaveBeenCalledOnce(); expect(h.splitWrite).toHaveBeenCalledOnce();
  });

  it("never persists caches from a read shorter than the parent's point count (still uploading)", async () => {
    h.workout = { ...staleParent(), routePointCount: 40 }; // iOS says 40 docs exist; the read returns 20
    h.splitRead.mockResolvedValue([]);
    await render();
    expect(h.routeRead).toHaveBeenCalledOnce();
    expect(h.cacheWrite).not.toHaveBeenCalled();
    expect(h.splitWrite).not.toHaveBeenCalled();
  });

  it("never persists caches from a route that covers a fraction of the run's distance", async () => {
    h.workout = { ...h.workout!, distanceMiles: 13, distanceMeters: 20921, routePointCount: undefined } as HealthWorkout;
    h.splitRead.mockResolvedValue([]);
    await render();
    expect(h.routeRead).toHaveBeenCalledOnce();
    expect(h.cacheWrite).not.toHaveBeenCalled();
    expect(h.splitWrite).not.toHaveBeenCalled();
  });

  it("does not re-read the route or rewrite anything for a healthy, stamped run", async () => {
    h.workout = { ...h.workout!, routePointCount: 20 };
    h.cacheWrite.mockImplementation(async (_uid, _id, updates) => { h.workout = { ...h.workout!, ...updates }; });
    h.splitWrite.mockImplementation(async (_uid, _id, writes) => {
      h.splitRead.mockResolvedValue(writes.map((write: { docId: string; data: object }) => ({ id: write.docId, ...write.data })));
    });
    await render(); // first view back-fills (no caches yet)
    await act(async () => root.unmount()); root = createRoot(container); await render();
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(h.routeRead).toHaveBeenCalledOnce(); expect(h.cacheWrite).toHaveBeenCalledOnce(); expect(h.splitWrite).toHaveBeenCalledOnce();
    expect(h.cacheWrite.mock.calls[0][2].routeCacheBasisPointCount).toBe(20);
  });
});
