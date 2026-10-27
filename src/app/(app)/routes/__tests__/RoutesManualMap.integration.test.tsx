import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { RoutePoint } from "@/services/routes";
import type { CreatedRoute } from "@/types/createdRoute";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({
  workouts: [] as HealthWorkout[], push: vi.fn(), gps: vi.fn(), starts: vi.fn(),
  created: vi.fn(), save: vi.fn(), update: vi.fn(), delete: vi.fn(),
  preview: vi.fn(), images: vi.fn(), network: vi.fn(),
  intersections: [] as IntersectionObserverCallback[],
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { uid: "synthetic-owner" } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => ({
  workouts: h.workouts, workoutsLoading: false, workoutsResolution: "success",
  settingsResolution: "success", maxHr: 185, restingHr: 60,
}) }));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, path: string) => path,
  query: (ref: unknown) => ref, orderBy: vi.fn(), limit: vi.fn(), getDocs: h.starts,
}));
vi.mock("@/services/routes", () => ({ fetchRoutePoints: h.gps }));
vi.mock("@/utils/routeCache", async importOriginal => {
  const actual = await importOriginal<typeof import("@/utils/routeCache")>();
  return { ...actual, getRoutePoints: vi.fn(actual.getRoutePoints) };
});
vi.mock("@/services/createdRoutes", () => ({
  fetchCreatedRoutes: h.created, saveCreatedRoute: h.save,
  updateCreatedRoute: h.update, deleteCreatedRoute: h.delete,
}));
// Fail if the old visibility-driven preview is ever mounted, even when another
// mock would hide its acquisition. Keep the real shared cache and clustering.
vi.mock("@/components/StaticRouteMap", () => ({ StaticRouteMap: () => {
  h.preview(); return <div data-testid="automatic-preview" />;
} }));
vi.mock("@/components/CreatedRouteCanvas", () => ({ CreatedRouteCanvas: () => <div data-testid="created-preview" /> }));
vi.mock("@/components/CreatedRouteDetailModal", () => ({
  CreatedRouteDetailModal: ({ route, onEditRoute }: { route: CreatedRoute | null; onEditRoute: (route: CreatedRoute) => void }) =>
    route ? <button onClick={() => onEditRoute(route)}>Edit created route</button> : null,
}));
type DrawData = { name: string; waypoints: { lat: number; lng: number }[]; snappedPath: { lat: number; lng: number }[]; distanceMiles: number };
vi.mock("next/dynamic", () => ({ default: (loader: () => unknown) => {
  const name = loader.toString();
  if (name.includes("RouteDrawModal")) return function MockRouteDrawModal({ initial, onSave }: { initial?: Pick<DrawData, "name" | "waypoints">; onSave: (data: DrawData) => void }) { return (
    <button data-testid="draw" data-initial={JSON.stringify(initial)} onClick={() => onSave({
      name: initial?.name ?? "New route", waypoints: initial?.waypoints ?? [], snappedPath: [], distanceMiles: 3,
    })}>Save route</button>
  ); };
  if (name.includes("RouteTrendDrawer")) return function MockRouteTrendDrawer() { return <div data-testid="trend-drawer" />; };
  if (name.includes("RouteTrendSparkline")) return function MockRouteTrendSparkline() { return <div data-testid="sparkline">Pace trend</div>; };
  return function MockRunMap({ points }: { points: RoutePoint[] }) { return <div data-testid="run-map" data-points={JSON.stringify(points)} />; };
} }));

import RoutesPage from "../page";
import { clearRouteCache, getRoutePoints, setRouteCacheSession } from "@/utils/routeCache";

let root: Root;
let container: HTMLDivElement;
const fixture = (id: string, miles = 3, pace = 600): HealthWorkout => ({
  workoutId: id, isRunLike: true, hasRoute: true, startDate: new Date(2026, 9, 20),
  distanceMiles: miles, durationSeconds: miles * pace, avgPaceSecPerMile: pace, avgHeartRate: 140,
} as HealthWorkout);
const points = (lat = 38): RoutePoint[] => [0, 1].map(index => ({
  index, lat: lat + index * 0.001, lng: -77, altitude: 10,
  timestamp: new Date(2026, 9, 20, 8, index).toISOString(), speed: 3, hr: 140,
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
async function mount() { await act(async () => root.render(<RoutesPage />)); }
function button(text: string, index = 0): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).filter(b => b.textContent?.includes(text))[index];
  expect(match).toBeTruthy();
  return match;
}
async function click(text: string, index = 0) { await act(async () => button(text, index).click()); }
function mappedPoints() {
  return JSON.parse(container.querySelector('[data-testid="run-map"]')!.getAttribute("data-points")!);
}
function expectNoMapAcquisition() {
  expect(getRoutePoints).not.toHaveBeenCalled();
  expect(h.gps).not.toHaveBeenCalled();
  expect(h.preview).not.toHaveBeenCalled();
  expect(h.images).not.toHaveBeenCalled();
  expect(h.network).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks(); clearRouteCache(); setRouteCacheSession("synthetic-owner");
  // Input order deliberately differs from pace/representative order.
  h.workouts = [fixture("slow", 3.2, 620), fixture("long", 8, 650), fixture("fast", 3, 500)];
  h.intersections = [];
  h.starts.mockResolvedValue({ empty: false, docs: [{ data: () => ({ lat: 38, lng: -77 }) }] });
  h.gps.mockReset().mockResolvedValue(points());
  h.created.mockReset().mockResolvedValue([]);
  h.save.mockResolvedValue(undefined); h.update.mockResolvedValue(undefined); h.delete.mockResolvedValue(undefined);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { h.intersections.push(callback); }
    observe() {} unobserve() {} disconnect() {}
  });
  vi.stubGlobal("Image", class { constructor() { h.images(); } });
  vi.stubGlobal("fetch", h.network);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount()); container.remove(); clearRouteCache(); vi.unstubAllGlobals();
});

describe("Routes manual map acquisition", () => {
  it("renders lightweight cards through scrolling, intersection and filtering without full GPS or tiles", async () => {
    await mount();
    expect(h.starts).toHaveBeenCalledTimes(3); // Existing geographic start queries remain allowed.
    expect(container.textContent).toContain("2 routes · 3 runs");
    expect(container.textContent).toContain("8:20 /mi");
    expect(container.textContent).toContain("140 bpm");
    expect(container.querySelectorAll("canvas, img, iframe")).toHaveLength(0);
    expectNoMapAcquisition();
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      for (const card of container.querySelectorAll("div.shadow-sm")) {
        card.dispatchEvent(new Event("scroll", { bubbles: true }));
        for (const callback of h.intersections) callback([{ target: card, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      }
    });
    await click("5–8mi"); await click("All");
    expectNoMapAcquisition();
  });

  it("keeps pace trends, similar-run expansion and individual run navigation independent of map loading", async () => {
    await mount();
    await act(async () => container.querySelector<HTMLElement>('[data-testid="sparkline"]')!.click());
    expect(container.querySelector('[data-testid="trend-drawer"]')).not.toBeNull();
    expectNoMapAcquisition();
    await click("1 similar run");
    await click("10:20 /mi");
    expect(h.push).toHaveBeenCalledWith("/runs/slow");
    expectNoMapAcquisition();
  });

  it("opens the selected representative's existing map without opening trends, similar runs or navigation", async () => {
    await mount();
    await click("View Map", 1);
    expect(getRoutePoints).toHaveBeenCalledExactlyOnceWith("synthetic-owner", "long");
    expect(h.gps).toHaveBeenCalledWith("synthetic-owner", "long", expect.any(Object));
    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Route Detail");
    expect(mappedPoints()).toEqual(points());
    expect(container.querySelector('[data-testid="trend-drawer"]')).toBeNull();
    expect(container.textContent).not.toContain("10:20 /mi"); // Similar-run list is still collapsed.
    expect(h.push).not.toHaveBeenCalled();
    await click("Close");
    await click("View Map");
    expect(getRoutePoints).toHaveBeenLastCalledWith("synthetic-owner", "fast");
  });

  it("reuses a complete shared route across close/reopen and page navigation", async () => {
    await mount(); await click("View Map"); await click("Close");
    await click("View Map");
    expect(mappedPoints()).toEqual(points());
    await act(async () => root.render(<div>Other page</div>));
    await mount(); await click("View Map");
    expect(h.gps).toHaveBeenCalledOnce();
    expect(getRoutePoints).toHaveBeenCalledTimes(3);
  });

  it("reuses a route acquired by another explicit consumer", async () => {
    await getRoutePoints("synthetic-owner", "fast");
    await mount(); await click("View Map");
    expect(mappedPoints()).toEqual(points());
    expect(h.gps).toHaveBeenCalledOnce();
  });

  it("shows loading, disables templates and joins the pending acquisition after close/reopen", async () => {
    const pending = deferred<RoutePoint[]>(); h.gps.mockReturnValue(pending.promise);
    await mount(); await click("View Map");
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Loading route map");
    expect(button("Use as template").disabled).toBe(true);
    await click("Close"); await click("View Map");
    expect(h.gps).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(points()));
    expect(mappedPoints()).toEqual(points());
    expect(button("Use as template").disabled).toBe(false);
  });

  it("shows missing GPS without enabling the map or template", async () => {
    h.gps.mockResolvedValue([]);
    await mount(); await click("View Map");
    expect(container.textContent).toContain("Route data not available");
    expect(button("Use as template").disabled).toBe(true);
    expect(container.querySelector('[data-testid="run-map"]')).toBeNull();
  });

  it("shows acquisition errors and retries through the shared cache on explicit reopen", async () => {
    h.gps.mockRejectedValueOnce(new Error("synthetic acquisition failure"));
    await mount(); await click("View Map");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unable to load route data");
    expect(button("Use as template").disabled).toBe(true);
    await click("Close"); await click("View Map");
    expect(mappedPoints()).toEqual(points());
    expect(h.gps).toHaveBeenCalledTimes(2);
  });

  it("ignores a closed modal's late result when another route is selected", async () => {
    const pending = deferred<RoutePoint[]>(); h.gps.mockReturnValueOnce(pending.promise).mockResolvedValue(points(39));
    await mount(); await click("View Map"); await click("Close"); await click("View Map", 1);
    await act(async () => pending.resolve(points()));
    expect(mappedPoints()).toEqual(points(39));
  });

  it("opens individual runs from Route Detail and reuses the loaded route as a template", async () => {
    await mount(); await click("View Map");
    const other = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find(b => b.textContent?.includes("3.20 mi"));
    expect(other).toBeTruthy();
    await act(async () => other!.click());
    expect(h.push).toHaveBeenCalledWith("/runs/slow");
    await click("View Map"); await click("Use as template");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    const initial = JSON.parse(container.querySelector('[data-testid="draw"]')!.getAttribute("data-initial")!);
    expect(initial.waypoints).toEqual(points().map(({ lat, lng }) => ({ lat, lng })));
    await click("Save route");
    expect(h.save).toHaveBeenCalledWith("synthetic-owner", expect.objectContaining({ waypoints: initial.waypoints }));
    expect(h.gps).toHaveBeenCalledOnce();
  });

  it("preserves created-route preview, edit and delete actions without acquiring run GPS", async () => {
    const created: CreatedRoute = { id: "created", name: "Custom loop", waypoints: [{ lat: 38, lng: -77 }], distanceMiles: 3, createdAt: new Date(), updatedAt: new Date() };
    h.created.mockResolvedValue([created]);
    await mount();
    expect(container.querySelector('[data-testid="created-preview"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLElement>('[data-testid="created-preview"]')!.click());
    await click("Edit created route"); await click("Save route");
    expect(h.update).toHaveBeenCalledWith("synthetic-owner", "created", expect.objectContaining({ name: "Custom loop" }));
    const deleteButton = container.querySelector<SVGElement>("svg.lucide-trash-2")!.closest("button")!;
    await act(async () => deleteButton.click()); await click("Delete Route");
    expect(h.delete).toHaveBeenCalledWith("synthetic-owner", "created");
    expect(container.textContent).not.toContain("Custom loop");
    expectNoMapAcquisition();
  });
});
