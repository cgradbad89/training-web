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
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => ({ workouts: [], overrides: {}, patchOverrides: vi.fn() }) }));
vi.mock("@/hooks/useUnsavedChanges", () => ({ useUnsavedChanges: vi.fn() }));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({ doc: vi.fn(), getDoc: async () => ({ exists: () => false }) }));
vi.mock("@/services/healthWorkouts", () => ({
  fetchHealthWorkout: async () => h.workout,
  fetchHealthWorkoutsInRange: async () => [], fetchLatestWorkoutId: async () => null,
  fetchWorkoutsByRouteCluster: async () => [],
  saveRunDetailCaches: h.cacheWrite, computeAndStoreBestEfforts: h.bestEfforts,
  saveWeatherForWorkout: h.weather, saveRouteClusterId: h.cluster, backfillRouteClusterIds: h.backfill,
}));
vi.mock("@/services/shoes", () => ({ fetchShoes: async () => [], fetchManualShoeAssignmentsMap: async () => ({}), saveManualAssignments: vi.fn() }));
vi.mock("@/services/workoutOverrides", () => ({ fetchOverride: async () => null, fetchAllOverrides: async () => ({}), saveOverride: vi.fn(), deleteOverride: vi.fn(), excludeWorkout: vi.fn(), restoreWorkout: vi.fn() }));
vi.mock("@/services/userSettings", () => ({ fetchUserSettings: async () => null }));
vi.mock("@/services/races", () => ({ fetchRaces: h.fetchRaces }));
vi.mock("@/services/plans", () => ({ fetchPlans: async () => [] }));
vi.mock("@/services/fastFinishSplits", () => ({ hydrateFastFinishSplits: h.hydrate }));
vi.mock("@/utils/runImpact", async importOriginal => ({ ...await importOriginal<typeof import("@/utils/runImpact")>(), computeRunImpact: h.impact }));
vi.mock("@/utils/routeCache", () => ({ getRoutePoints: h.routeRead }));
vi.mock("@/utils/mileSplitsCache", () => ({ getMileSplits: h.splitRead, saveMileSplitCache: h.splitWrite }));
vi.mock("@/utils/bestEfforts", async importOriginal => ({ ...await importOriginal<typeof import("@/utils/bestEfforts")>(), shouldRecomputeBestEfforts: () => false }));
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

describe("Run Detail operation ownership at page boundaries", () => {
  it.each(["preview", "production"])("withholds prediction impact without best-effort hydration under the preview gate in %s", async deployment => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", deployment === "production" ? undefined : "true");
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", deployment);
    h.fetchRaces.mockResolvedValue([{ id: "target", name: "Half", raceDate: "2027-03-20", raceDistance: "halfMarathon", isActive: true }]);
    await render();
    expect(h.hydrate).not.toHaveBeenCalled();
    expect(h.impact).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Numerical estimate unavailable");
    // The unrelated visible map/splits flow still works.
    expect(h.routeRead).toHaveBeenCalledOnce();
  });
  it("retains legacy hydration and impact calculation when the gate is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "false");
    h.fetchRaces.mockResolvedValue([{ id: "target", name: "Half", raceDate: "2027-03-20", raceDistance: "halfMarathon", isActive: true }]);
    await render();
    expect(h.hydrate).toHaveBeenCalled();
    expect(h.impact).toHaveBeenCalled();
    expect(container.textContent).not.toContain("Numerical estimate unavailable");
  });
  it("does not start a route query when a pending split read fails after unmount", async () => {
    const pending = deferred<never>(); h.splitRead.mockReturnValue(pending.promise);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await render(); expect(h.routeRead).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); pending.reject(new Error("synthetic read failure")); });
    expect(h.routeRead).not.toHaveBeenCalled(); expect(h.cacheWrite).not.toHaveBeenCalled();
  });
  it("does not publish caches when the owner session retires before a route resolves", async () => {
    const pending = deferred<RoutePoint[]>(); h.routeRead.mockReturnValue(pending.promise);
    await render(); expect(h.routeRead).toHaveBeenCalledOnce();
    h.currentEpoch = 2; // Synchronous AuthContext retirement, before React rerenders.
    await act(async () => pending.resolve(points));
    expect(h.cacheWrite).not.toHaveBeenCalled(); expect(h.splitWrite).not.toHaveBeenCalled();
  });
  it("does not let a retained detail page write after navigation to Personal Insights", async () => {
    const pending = deferred<RoutePoint[]>(); h.routeRead.mockReturnValue(pending.promise);
    await render(); h.path = "/personal-insights"; await render();
    await act(async () => pending.resolve(points));
    expect(h.cacheWrite).not.toHaveBeenCalled(); expect(h.splitWrite).not.toHaveBeenCalled();
  });
  it("still creates complete route and mile caches for an active legitimate detail view", async () => {
    await render();
    expect(h.routeRead).toHaveBeenCalledOnce(); expect(h.cacheWrite).toHaveBeenCalledOnce();
    expect(h.cacheWrite.mock.calls[0][2]).toHaveProperty("overlayChartCache");
    expect(h.splitWrite).toHaveBeenCalledOnce();
  });
  it("skips raw acquisition and repeat writes when persisted detail caches are valid", async () => {
    h.cacheWrite.mockImplementation(async (_uid, _id, updates) => { h.workout = { ...h.workout!, ...updates }; });
    h.splitWrite.mockImplementation(async (_uid, _id, writes) => {
      h.splitRead.mockResolvedValue(writes.map((write: { docId: string; data: object }) => ({ id: write.docId, ...write.data })));
    });
    await render();
    expect(h.cacheWrite).toHaveBeenCalledOnce(); expect(h.splitWrite).toHaveBeenCalledOnce();
    await act(async () => root.unmount()); root = createRoot(container); await render();
    expect(h.routeRead).toHaveBeenCalledOnce(); expect(h.cacheWrite).toHaveBeenCalledOnce(); expect(h.splitWrite).toHaveBeenCalledOnce();
  });
  it("shows acquisition failure without publishing an incomplete route cache", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.routeRead.mockRejectedValue(new Error("The route exceeds the 25,000-document detail limit."));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("No partial route cache was saved");
    expect(h.cacheWrite).not.toHaveBeenCalled(); expect(h.splitWrite).not.toHaveBeenCalled();
  });
});
