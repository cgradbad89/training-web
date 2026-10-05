import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { MatchedRunSummary } from "@/utils/routePerformance";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({
  workouts: vi.fn(), plans: vi.fn(), races: vi.fn(), overrides: vi.fn(), settings: vi.fn(),
  created: vi.fn(), save: vi.fn(), update: vi.fn(), delete: vi.fn(),
  gps: vi.fn(), docs: vi.fn(), uid: "u1",
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { uid: h.uid } }) }));
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
vi.mock("@/services/routes", () => ({ fetchRoutePoints: h.gps }));
vi.mock("firebase/firestore", () => ({
  collection: (_db: unknown, path: string) => path,
  query: (ref: unknown) => ref, orderBy: vi.fn(), limit: vi.fn(), getDocs: h.docs,
}));
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
import { clearRouteCache, setRouteCacheSession, getRoutePoints } from "@/utils/routeCache";

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
async function visit() {
  await act(async () => root.render(<AppDataProvider uid={h.uid}><RoutesPage /></AppDataProvider>));
  await vi.waitFor(() => expect(container.textContent).toContain("50 runs"));
}
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await visit();
}
beforeEach(() => {
  vi.clearAllMocks(); clearRouteCache(); h.uid = "u1"; setRouteCacheSession(h.uid);
  h.workouts.mockResolvedValue(Array.from({ length: 50 }, (_, i) => fixture(`r${i}`)));
  h.plans.mockResolvedValue([]); h.races.mockResolvedValue([]); h.overrides.mockResolvedValue({});
  h.settings.mockResolvedValue(null); h.created.mockResolvedValue([]);
  h.gps.mockResolvedValue([{ index: 0, lat: 38, lng: -77 }]);
  h.docs.mockResolvedValue({ empty: false, docs: [{ data: () => ({ lat: 38, lng: -77 }) }] });
  h.save.mockResolvedValue(undefined); h.delete.mockResolvedValue(undefined);
});
afterEach(() => { act(() => root?.unmount()); container?.remove(); clearRouteCache(); vi.restoreAllMocks(); });

describe("Routes two-visit start-query operation proof", () => {
  it("eliminates the 99-query pattern with 50 routed runs and one full GPS demand", async () => {
    await mount(); expect(h.docs).toHaveBeenCalledTimes(50);
    // The audited fixture loads one representative's GPS between visits: that
    // one start was already reusable, leaving 50 + 49 = 99 baseline queries.
    await getRoutePoints("u1", "r0");
    await act(async () => root.render(<AppDataProvider uid="u1"><div>Other training page</div></AppDataProvider>));
    await visit();
    expect(h.docs).toHaveBeenCalledTimes(50); expect(h.gps).toHaveBeenCalledOnce();
    expect(h.workouts).toHaveBeenCalledOnce(); expect(h.settings).toHaveBeenCalledOnce();
  });

  it("deduplicates route starts during Strict Mode preparation replay", async () => {
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<React.StrictMode><AppDataProvider uid="u1"><RoutesPage /></AppDataProvider></React.StrictMode>));
    await vi.waitFor(() => expect(container.textContent).toContain("50 runs"));
    expect(h.docs).toHaveBeenCalledTimes(50);
  });

  it("rapid exit/re-entry joins pending same-session starts", async () => {
    const pending = deferred<{ empty: boolean; docs: { data: () => { lat: number; lng: number } }[] }>();
    h.docs.mockReturnValue(pending.promise);
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<AppDataProvider uid="u1"><RoutesPage /></AppDataProvider>));
    await vi.waitFor(() => expect(h.docs).toHaveBeenCalledTimes(10));
    await act(async () => root.render(<AppDataProvider uid="u1"><div>Other page</div></AppDataProvider>));
    await act(async () => root.render(<AppDataProvider uid="u1"><RoutesPage /></AppDataProvider>));
    await act(async () => pending.resolve({ empty: false, docs: [{ data: () => ({ lat: 38, lng: -77 }) }] }));
    await vi.waitFor(() => expect(container.textContent).toContain("50 runs"));
    expect(h.docs).toHaveBeenCalledTimes(50);
  });
});
