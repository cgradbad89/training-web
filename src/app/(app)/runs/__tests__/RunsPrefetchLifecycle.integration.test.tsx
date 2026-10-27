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
  prefetch: vi.fn(), push: vi.fn(), enrich: vi.fn(),
  overrides: {}, plans: [], patch: vi.fn(), refresh: vi.fn(),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({
  user: { uid: "synthetic-owner" }, sessionEpoch: h.epoch, isSessionCurrent: h.isSessionCurrent,
}) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }), usePathname: () => h.pathname }));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => ({
  workouts: h.workouts, overrides: h.overrides, plans: h.plans, maxHr: 185, restingHr: 60,
  workoutsLoading: false, settingsResolution: "success", userSettings: null,
  patchTrainingLoad: h.patch, patchOverrides: h.patch, refreshWorkouts: h.refresh,
}) }));
// Isolate the removed initiator: enrichment is independently allowed to read GPS.
vi.mock("@/hooks/useEnrichTrainingLoads", () => ({ useEnrichTrainingLoads: h.enrich }));
vi.mock("@/hooks/useUnsavedChanges", () => ({ useUnsavedChanges: vi.fn() }));
vi.mock("@/services/routes", () => ({ fetchRoutePoints: h.routes }));
vi.mock("@/utils/routeCache", async importOriginal => ({
  ...await importOriginal<typeof import("@/utils/routeCache")>(),
  prefetchRoutes: h.prefetch,
}));
vi.mock("@/services/shoes", () => ({
  fetchShoes: async () => [], fetchManualShoeAssignmentsMap: async () => ({}),
  saveManualAssignments: vi.fn(),
}));

import RunsPage from "../page";
import { clearRouteCache, getRoutePoints, setRouteCacheSession } from "@/utils/routeCache";

let root: Root;
let container: HTMLDivElement;
async function mount() { await act(async () => root.render(<RunsPage />)); }
async function waitPastPrefetch() { await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); }
async function click(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes(text));
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
function expectNoPrefetch() {
  expect(h.prefetch).not.toHaveBeenCalled();
  expect(h.routes).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 27, 12));
  vi.clearAllMocks();
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

describe("Runs page without automatic full-route prefetch", () => {
  it("renders runs without invoking prefetch on load or beyond the former 500ms delay", async () => {
    await mount();
    expect(container.querySelector("main")?.textContent).toContain("9 runs · 36.0 miles");
    expectNoPrefetch();
    await waitPastPrefetch();
    expectNoPrefetch();
    expect(h.enrich).toHaveBeenLastCalledWith("synthetic-owner", h.workouts, null, h.patch, "/runs");
  });

  it("does not prefetch after list updates, date sorting, filters, scrolling or refresh", async () => {
    await mount();
    // The list's existing sort is newest first; it has no user-selectable sort.
    h.workouts = [h.workouts[8], ...h.workouts.slice(0, 8)];
    await mount();
    const rows = container.querySelectorAll("main div.group.cursor-pointer");
    expect(rows).toHaveLength(9);
    expect(rows[0].querySelector("div.select-none span:last-child")?.textContent).toBe("14");
    await click("1–2.9 mi");
    expect(container.textContent).toContain("No runs match your filters");
    await click("3–4.9 mi");
    expect(container.querySelectorAll("main div.group.cursor-pointer")).toHaveLength(9);
    await click("PRs only");
    expect(container.querySelectorAll("main div.group.cursor-pointer")).toHaveLength(0);
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      container.dispatchEvent(new Event("scroll", { bubbles: true }));
      container.querySelector<HTMLButtonElement>('[title="Refresh runs"]')!.click();
    });
    expect(h.refresh).toHaveBeenCalledOnce();
    await waitPastPrefetch();
    expectNoPrefetch();
  });

  it.each([0, 1000])("does not prefetch after leaving and returning at %sms", async delay => {
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
    await act(async () => root.render(<div>Personal Insights</div>));
    await waitPastPrefetch();
    await mount();
    await waitPastPrefetch();
    expectNoPrefetch();
  });

  it("does not prefetch across retained pathname and auth-session changes", async () => {
    await mount();
    h.pathname = "/personal-insights";
    await mount(); await waitPastPrefetch();
    h.pathname = "/runs";
    h.epoch = ++h.currentEpoch;
    setRouteCacheSession(null); setRouteCacheSession("synthetic-owner");
    await mount(); await waitPastPrefetch();
    expectNoPrefetch();
  });

  it("preserves run navigation and explicit shared route acquisition/reuse", async () => {
    await mount();
    await act(async () => container.querySelector<HTMLDivElement>("main div.group.cursor-pointer")!.click());
    expect(h.push).toHaveBeenCalledWith("/runs/synthetic-0");
    expectNoPrefetch();
    const points = [{ index: 0, lat: 38, lng: -77 }] as RoutePoint[];
    h.routes.mockResolvedValue(points);
    expect(await getRoutePoints("synthetic-owner", "synthetic-0")).toEqual(points);
    expect(await getRoutePoints("synthetic-owner", "synthetic-0")).toEqual(points);
    expect(h.routes).toHaveBeenCalledOnce();
    expect(h.routes).toHaveBeenCalledWith("synthetic-owner", "synthetic-0", expect.any(Object));
    expect(h.prefetch).not.toHaveBeenCalled();
  });
});
