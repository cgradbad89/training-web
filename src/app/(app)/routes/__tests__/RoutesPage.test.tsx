import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { CreatedRoute } from "@/types/createdRoute";
import type { MatchedRunSummary } from "@/utils/routePerformance";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({
  workouts: vi.fn(), plans: vi.fn(), races: vi.fn(), overrides: vi.fn(), settings: vi.fn(),
  created: vi.fn(), save: vi.fn(), update: vi.fn(), delete: vi.fn(),
  gps: vi.fn(), start: vi.fn(),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { uid: "u1" } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("@/services/healthWorkouts", () => ({ fetchHealthWorkouts: h.workouts, fetchHealthWorkoutsInRange: vi.fn() }));
vi.mock("@/services/plans", () => ({ fetchPlans: h.plans }));
vi.mock("@/services/races", () => ({ fetchRaces: h.races }));
vi.mock("@/services/workoutOverrides", () => ({ fetchAllOverrides: h.overrides }));
vi.mock("@/services/userSettings", () => ({ fetchUserSettings: h.settings }));
vi.mock("@/services/createdRoutes", () => ({
  fetchCreatedRoutes: h.created, saveCreatedRoute: h.save, updateCreatedRoute: h.update, deleteCreatedRoute: h.delete,
}));
vi.mock("@/utils/routeCache", async importOriginal => ({
  ...await importOriginal<typeof import("@/utils/routeCache")>(),
  getRouteStartPoint: h.start, getRoutePoints: h.gps,
}));
vi.mock("@/utils/routeClustering", async importOriginal => {
  const actual = await importOriginal<typeof import("@/utils/routeClustering")>();
  return { ...actual, clusterRoutesGeographic: vi.fn(actual.clusterRoutesGeographic) };
});
vi.mock("@/components/StaticRouteMap", () => ({ StaticRouteMap: () => <div /> }));
vi.mock("@/components/CreatedRouteCanvas", () => ({ CreatedRouteCanvas: () => <div /> }));
vi.mock("@/components/CreatedRouteDetailModal", () => ({ CreatedRouteDetailModal: () => null }));
vi.mock("next/dynamic", () => ({
  default: (loader: () => unknown) => loader.toString().includes("RouteDrawModal")
    ? ({ onSave }: { onSave: (data: object) => void }) => <button onClick={() => onSave({ name: "New loop", waypoints: [], snappedPath: [], distanceMiles: 3 })}>Save fixture route</button>
    : loader.toString().includes("RouteTrendDrawer")
      ? ({ runs }: { runs: MatchedRunSummary[] }) => <div data-testid="trend" data-runs={JSON.stringify(runs)} />
      : () => null,
}));

import RoutesPage from "../page";
import { AppDataProvider } from "@/contexts/AppDataContext";
import { clusterRoutesGeographic } from "@/utils/routeClustering";
import { resolveDisplayLoad } from "@/utils/trainingLoad";

let root: Root;
let container: HTMLDivElement;
const fixture = (id: string, partial: Partial<HealthWorkout> = {}): HealthWorkout => ({
  workoutId: id, isRunLike: true, hasRoute: true, startDate: new Date(),
  distanceMiles: 3, durationSeconds: 1800, avgPaceSecPerMile: 600, avgHeartRate: 140,
  ...partial,
} as HealthWorkout);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<AppDataProvider uid="u1"><RoutesPage /></AppDataProvider>));
  await act(async () => { await new Promise(res => setTimeout(res, 0)); });
}
function click(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes(text));
  expect(button).toBeTruthy();
  return act(async () => { button!.click(); });
}
beforeEach(() => {
  vi.clearAllMocks();
  h.workouts.mockResolvedValue([fixture("r1")]);
  h.plans.mockResolvedValue([]); h.races.mockResolvedValue([]); h.overrides.mockResolvedValue({});
  h.settings.mockResolvedValue(null); h.created.mockResolvedValue([]);
  h.gps.mockResolvedValue([]); h.start.mockResolvedValue({ lat: 38, lng: -77 });
  h.save.mockResolvedValue(undefined); h.delete.mockResolvedValue(undefined);
});
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.restoreAllMocks(); });

describe("Routes canonical metadata and geographic parity", () => {
  it("removes page-owned W500/H reads and keeps created routes and demand GPS", async () => {
    await mount();
    expect(h.workouts).toHaveBeenCalledOnce();
    expect(h.workouts).toHaveBeenCalledWith("u1", { limitCount: 1000 });
    expect(h.settings).toHaveBeenCalledOnce();
    expect(h.created).toHaveBeenCalledOnce();
    expect(h.created).toHaveBeenCalledWith("u1");
    expect(h.gps).not.toHaveBeenCalled();
    await click("View on map");
    expect(h.gps).toHaveBeenCalledOnce();
    expect(h.gps).toHaveBeenCalledWith("u1", "r1");
  });

  it("slices the newest 500 raw records BEFORE run/route eligibility filtering", async () => {
    const raw = [
      ...Array.from({ length: 495 }, (_, i) => fixture(`non-run-${i}`, { isRunLike: false })),
      fixture("no-route", { hasRoute: false }),
      ...Array.from({ length: 4 }, (_, i) => fixture(`eligible-${i}`)),
      fixture("older-routed-run"),
    ];
    h.workouts.mockResolvedValue(raw);
    h.overrides.mockResolvedValue({ "eligible-0": { isExcluded: true, distanceMilesOverride: 9 } });
    await mount();
    expect(vi.mocked(clusterRoutesGeographic).mock.calls[0][0]).toEqual(raw.slice(496, 500));
    expect(h.start.mock.calls.map(call => call[1])).toEqual(["eligible-0", "eligible-1", "eligible-2", "eligible-3"]);
    expect(container.textContent).toContain("4 runs");
  });

  it("preserves pace representatives, distance tolerance, geographic separation and missing-coordinate fallback", async () => {
    h.workouts.mockResolvedValue([
      fixture("near-slow", { distanceMiles: 3.4, avgPaceSecPerMile: 620 }),
      fixture("far", { distanceMiles: 3.2, avgPaceSecPerMile: 610 }),
      fixture("fast", { avgPaceSecPerMile: 500 }),
      fixture("unknown", { distanceMiles: 3.5, avgPaceSecPerMile: 630 }),
      fixture("long", { distanceMiles: 8, avgPaceSecPerMile: 650 }),
      fixture("filtered", { hasRoute: false }),
    ]);
    h.start.mockImplementation(async (_uid, id) => id === "unknown" ? null : {
      lat: id === "far" ? 39 : id === "near-slow" ? 38.001 : 38, lng: -77,
    });
    await mount();
    const groups = await vi.mocked(clusterRoutesGeographic).mock.results[0].value;
    expect(groups.map(group => ({ id: group.id, runs: group.allRuns.map(run => run.workoutId) }))).toEqual([
      { id: "fast", runs: ["fast", "near-slow", "unknown"] },
      { id: "far", runs: ["far"] }, { id: "long", runs: ["long"] },
    ]);
    expect(container.textContent).toContain("3 routes");
  });

  it("waits for successfully settled settings before geographic preparation", async () => {
    const settings = deferred<null>();
    h.settings.mockReturnValue(settings.promise);
    await mount();
    expect(clusterRoutesGeographic).not.toHaveBeenCalled();
    settings.resolve(null);
    await act(async () => { await settings.promise; });
    expect(clusterRoutesGeographic).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Routes");
  });

  it("does not silently use default anchors after a settings failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.settings.mockRejectedValue(new Error("unavailable"));
    await mount();
    expect(clusterRoutesGeographic).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Routes unavailable");
  });

  it.each([
    { settings: null, maxHr: 185, restingHr: 60 },
    { settings: { maxHeartRate: 175, restingHeartRate: 65 }, maxHr: 175, restingHr: 65 },
  ])("uses successfully settled canonical anchors in route performance ($maxHr/$restingHr)", async ({ settings, maxHr, restingHr }) => {
    const source = fixture("r1");
    h.settings.mockResolvedValue(settings);
    h.workouts.mockResolvedValue([source]);
    await mount();
    await act(async () => container.querySelector<HTMLDivElement>("div.p-4.cursor-pointer")!.click());
    const rows = JSON.parse(container.querySelector('[data-testid="trend"]')!.getAttribute("data-runs")!) as MatchedRunSummary[];
    expect(rows[0].load).toBe(resolveDisplayLoad(source, maxHr, restingHr));
    expect(h.settings).toHaveBeenCalledOnce();
    expect(h.gps).not.toHaveBeenCalled();
  });

  it("keeps explicit created-route persistence and list refresh behavior", async () => {
    await mount();
    const created = { id: "new", name: "New loop", waypoints: [], distanceMiles: 3, createdAt: new Date(), updatedAt: new Date() } as CreatedRoute;
    h.created.mockResolvedValue([created]);
    await click("New Route");
    await click("Save fixture route");
    expect(h.save).toHaveBeenCalledWith("u1", { name: "New loop", waypoints: [], snappedPath: [], distanceMiles: 3 });
    expect(h.created).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("New loop");
    expect(h.gps).not.toHaveBeenCalled();
  });
});
