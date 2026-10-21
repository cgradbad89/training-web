import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { RoutePoint } from "@/services/routes";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({
  epoch: 1, currentEpoch: 1,
  pathname: "/runs",
  isSessionCurrent: (epoch: number): boolean => epoch === h.currentEpoch,
  workouts: [] as HealthWorkout[], routes: vi.fn(),
  overrides: {}, plans: [], patch: vi.fn(), refresh: vi.fn(),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({
  user: { uid: "synthetic-owner" }, sessionEpoch: h.epoch, isSessionCurrent: h.isSessionCurrent,
}) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => h.pathname }));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => ({
  workouts: h.workouts, overrides: h.overrides, plans: h.plans, maxHr: 185, restingHr: 60,
  workoutsLoading: false, settingsResolution: "success", userSettings: null,
  patchTrainingLoad: h.patch, patchOverrides: h.patch, refreshWorkouts: h.refresh,
}) }));
vi.mock("@/hooks/useEnrichTrainingLoads", () => ({ useEnrichTrainingLoads: vi.fn() }));
vi.mock("@/hooks/useUnsavedChanges", () => ({ useUnsavedChanges: vi.fn() }));
vi.mock("@/services/routes", () => ({ fetchRoutePoints: h.routes }));
vi.mock("@/services/shoes", () => ({
  fetchShoes: async () => [], fetchManualShoeAssignmentsMap: async () => ({}),
  saveManualAssignments: vi.fn(),
}));

import RunsPage from "../page";
import { clearRouteCache, setRouteCacheSession } from "@/utils/routeCache";

let root: Root;
let container: HTMLDivElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
async function mount() { await act(async () => root.render(<RunsPage />)); }
async function settle() { await act(async () => { await vi.runAllTimersAsync(); }); }

beforeEach(() => {
  vi.useFakeTimers();
  h.epoch = h.currentEpoch = 1;
  h.pathname = "/runs";
  setRouteCacheSession("synthetic-owner"); clearRouteCache();
  h.routes.mockReset().mockResolvedValue([]);
  h.workouts = Array.from({ length: 9 }, (_, i) => ({
    workoutId: `synthetic-${i}`, isRunLike: true, hasRoute: true,
    activityType: "running", displayType: "Outdoor Run", startDate: new Date(2026, 9, 14 - i, 8),
    distanceMiles: 4, durationSeconds: 2400, avgPaceSecPerMile: 600, avgHeartRate: 140,
  } as HealthWorkout));
  container = document.createElement("div"); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); clearRouteCache(); vi.useRealTimers();
});

describe("Runs page with real shared prefetch lifecycle", () => {
  it("does not start GPS if navigation happens before the prefetch timer", async () => {
    await mount();
    await act(async () => root.render(<div>Personal Insights</div>));
    await settle();
    expect(h.routes).not.toHaveBeenCalled();
  });

  it.each(["navigation", "auth session", "retained route"])("stops queued raw-route acquisition after %s while a batch is pending", async retirement => {
    const pending = deferred<RoutePoint[]>();
    h.routes.mockReturnValue(pending.promise);
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(h.routes).toHaveBeenCalledTimes(3);
    if (retirement === "navigation") await act(async () => root.render(<div>Personal Insights</div>));
    else if (retirement === "retained route") { h.pathname = "/personal-insights"; await mount(); }
    else { h.currentEpoch++; setRouteCacheSession(null); }
    pending.resolve([]);
    await settle();
    expect(h.routes).toHaveBeenCalledTimes(3);
  });

  it("does not start prefetch while the Runs page is retained under another pathname", async () => {
    h.pathname = "/personal-insights";
    await mount(); await settle();
    expect(h.routes).not.toHaveBeenCalled();
  });

  it("preserves active prefetch and reuses completed routes on repeat navigation", async () => {
    await mount(); await settle();
    expect(h.routes).toHaveBeenCalledTimes(9);
    await act(async () => root.render(<div>Personal Insights</div>));
    await mount(); await settle();
    expect(h.routes).toHaveBeenCalledTimes(9);
  });
});
