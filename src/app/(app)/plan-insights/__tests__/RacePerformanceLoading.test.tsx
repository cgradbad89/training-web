import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDataContextValue } from "@/contexts/AppDataContext";
import { currentFixture } from "@/utils/__tests__/fixtures/currentPerformanceFixture";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({
  workouts: vi.fn(), delta: vi.fn(), plans: vi.fn(), races: vi.fn(), overrides: vi.fn(), settings: vi.fn(),
  hydrate: vi.fn(), predict: vi.fn(), trend: vi.fn(), projection: vi.fn(), segments: vi.fn(),
  uid: "synthetic-owner", epoch: 1, valid: true, pathname: "/plan-insights",
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({
  user: { uid: h.uid }, sessionEpoch: h.epoch,
  isSessionCurrent: (epoch: number) => h.valid && epoch === h.epoch,
}) }));
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/insights/PerformanceEvidenceStatus", () => ({ PerformanceEvidenceStatus: () => null }));
vi.mock("@/services/healthWorkouts", () => ({ fetchHealthWorkouts: h.workouts, fetchHealthWorkoutsInRange: h.delta }));
vi.mock("@/services/plans", () => ({ fetchPlans: h.plans }));
vi.mock("@/services/races", () => ({ fetchRaces: h.races }));
vi.mock("@/services/workoutOverrides", () => ({ fetchAllOverrides: h.overrides }));
vi.mock("@/services/userSettings", () => ({ fetchUserSettings: h.settings }));
vi.mock("@/services/fastFinishSplits", () => ({ hydrateFastFinishSplits: h.hydrate }));
vi.mock("@/utils/racePrediction", () => ({ predictRaceTime: h.predict, buildPredictionTrend: h.trend }));
vi.mock("@/utils/predictionTrend", () => ({ buildAnchoredPredictionProjection: h.projection }));
vi.mock("@/utils/bestEffortExtraction", () => ({ buildBestEffortSegments: h.segments }));

import PlanInsightsPage from "../page";
import { AppDataProvider, useAppData } from "@/contexts/AppDataContext";

const sources = ["workouts", "overrides", "races", "plans"] as const;
type Source = typeof sources[number];
let root: Root;
let container: HTMLDivElement;
let appData: AppDataContextValue;
let mounted: boolean;
let trainingActive: boolean;
let input: ReturnType<typeof currentFixture>;
const isSessionCurrent = (epoch: number) => h.valid && epoch === h.epoch;
function Probe() {
  const value = useAppData();
  React.useEffect(() => { appData = value; }, [value]);
  return null;
}
function Harness() {
  return <AppDataProvider uid={h.uid} sessionEpoch={h.epoch} isSessionCurrent={isSessionCurrent} trainingActive={trainingActive}>
    <Probe />{mounted && <PlanInsightsPage />}
  </AppDataProvider>;
}
async function render() { await act(async () => root.render(<Harness />)); }
async function flush() { await act(async () => { await Promise.resolve(); }); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function refresh(source: Source) {
  return ({ workouts: appData.refreshWorkouts, overrides: appData.refreshOverrides,
    races: appData.refreshRaces, plans: appData.refreshPlans })[source]();
}
const text = () => container.textContent ?? "";
const experience = () => container.querySelector('[data-testid="race-performance-experience"]');
const estimate = () => container.querySelector('[data-testid="experimental-current-estimate"]');
const section = (title: string) => [...container.querySelectorAll("section")].find(s => s.querySelector("h2")?.textContent === title);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", undefined);
  vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
  vi.useFakeTimers({ toFake: ["Date"] });
  input = currentFixture(1.5, 4, 9);
  vi.setSystemTime(new Date(input.asOf));
  h.uid = "synthetic-owner"; h.epoch = 1; h.valid = true; h.pathname = "/plan-insights";
  mounted = true; trainingActive = true;
  h.workouts.mockResolvedValue(input.workouts); h.delta.mockResolvedValue([]);
  h.overrides.mockResolvedValue(input.overrides ?? {}); h.settings.mockResolvedValue(null);
  h.plans.mockResolvedValue([]);
  h.races.mockResolvedValue([...input.races, { id: "goal", name: "Synthetic Rock & Roll Half Marathon",
    raceDate: "2027-03-20", raceDistance: "halfMarathon", isActive: true, createdAt: "2026-09-21T00:00:00Z" }]);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => {
  // Every lifecycle case must retain the read-only release boundary.
  for (const fn of [h.hydrate, h.predict, h.trend, h.projection, h.segments]) expect(fn).not.toHaveBeenCalled();
  expect(text()).not.toContain("Race-Day Projection");
  expect(text()).not.toContain("R²");
  act(() => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

describe("Production Race Performance data lifecycle", () => {
  it("keeps initial loading explicit, then displays successful sources (including empty plans/overrides)", async () => {
    const pending = deferred<unknown[]>(); h.workouts.mockReturnValue(pending.promise);
    await render();
    expect(container.querySelector('[aria-label="Loading plan insights"]')).toBeTruthy();
    expect(experience()).toBeNull();
    expect(appData.sourceHasLoaded.workouts).toBe(false);
    pending.resolve(input.workouts); await flush();
    expect(appData.workoutsResolution).toBe("success");
    expect(appData.sourceHasLoaded).toMatchObject({ workouts: true, overrides: true, races: true, plans: true });
    expect(estimate()?.textContent).toContain("~2:09");
    expect(text()).toContain("Experimental"); expect(text()).toContain("Withheld · not validated");
  });

  it.each(sources)("shows a source-specific initial %s error without treating failure as empty history", async source => {
    const pending = deferred<never>(); h[source].mockReturnValue(pending.promise); await render();
    expect(appData[`${source}Resolution`]).toBe("loading");
    expect(appData.sourceHasLoaded[source]).toBe(false);
    pending.reject(new Error("permission-denied")); await flush();
    expect(appData[`${source}Resolution`]).toBe("error");
    expect(appData.sourceHasLoaded[source]).toBe(false);
    if (source === "plans") {
      expect(estimate()?.textContent).toContain("~2:09");
      expect(section("Training Progress")?.textContent).toContain("Plan context is unavailable");
      expect(section("Training Progress")?.textContent).not.toContain("Recorded faster sessions: 0");
    } else {
      expect(estimate()).toBeNull();
      expect(text()).not.toContain("Performance by Run Type");
      expect(text()).not.toContain("Recent Trends");
      expect(section("Current Performance")?.textContent).toContain("could not be loaded");
      expect(section("Historical Performance Timeline")?.textContent).not.toContain("No past race results");
      if (source === "races") expect(section("Training Progress")?.textContent).toContain("Recent 4 weeks");
      else expect(section("Training Progress")?.textContent).not.toContain("Recent 4 weeks0.0");
    }
    if (source === "plans") expect(text()).not.toContain("No training plan linked");
    expect(text()).toContain(source === "overrides" ? "workout overrides" : source === "races" ? "race records" : source);
  });

  it.each(sources)("preserves valid information through a delayed background %s refresh and its success", async source => {
    await render(); const before = estimate()?.textContent;
    const pending = deferred<unknown>(); h[source].mockReturnValue(pending.promise);
    let request!: Promise<void>;
    await act(async () => { request = refresh(source); });
    expect(appData[`${source}Resolution`]).toBe("loading");
    expect(appData.sourceHasLoaded[source]).toBe(true);
    expect(estimate()?.textContent).toBe(before);
    expect(container.querySelector('[aria-label="Loading plan insights"]')).toBeNull();
    expect(text()).toContain("Refreshing");
    pending.resolve(source === "workouts" ? input.workouts : source === "overrides" ? {} : source === "races" ? input.races : []);
    await act(async () => request);
    expect(appData[`${source}Resolution`]).toBe("success");
    expect(estimate()).toBeTruthy(); expect(text()).not.toContain("Refreshing");
  });

  it("updates rendered training when a full background refresh returns corrected summaries", async () => {
    await render(); const before = section("Training Progress")?.textContent;
    h.workouts.mockResolvedValue(input.workouts.map(w => ({ ...w, distanceMiles: w.distanceMiles * 1.1 })));
    await act(async () => appData.refreshWorkouts());
    expect(section("Training Progress")?.textContent).not.toBe(before);
    expect(estimate()).toBeTruthy(); expect(text()).toContain("Withheld · not validated");
  });

  it("selects an available race when a successful refresh removes the selected race", async () => {
    await render();
    h.races.mockResolvedValue([{ ...input.races[0], id: "replacement-race", name: "Replacement race", isActive: true }]);
    await act(async () => appData.refreshRaces());
    expect(container.querySelector<HTMLSelectElement>("#race-picker")?.value).toBe("replacement-race");
    expect(section("Race-Day Outlook")?.textContent).toContain("Replacement race");
    expect(estimate()).toBeTruthy();
  });

  it.each(sources)("retains same-session successful data after a background %s failure and clears the warning on recovery", async source => {
    await render(); const before = estimate()?.textContent;
    h[source].mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => refresh(source));
    expect(appData[`${source}Resolution`]).toBe("error");
    expect(appData.sourceHasLoaded[source]).toBe(true);
    expect(estimate()?.textContent).toBe(before);
    expect(text()).toContain("Showing previously loaded");
    expect(text()).toContain("may be out of date");
    await act(async () => refresh(source));
    expect(text()).not.toContain("may be out of date");
  });

  it("does not let settings failure suppress sections that use parent summaries only", async () => {
    h.settings.mockRejectedValue(new Error("unavailable")); await render();
    expect(estimate()?.textContent).toContain("~2:09");
    expect(section("Training Progress")?.textContent).toContain("Recent 4 weeks");
    expect(text()).not.toContain("may be out of date");
  });

  it("does not use a targeted patch as proof that the complete overrides collection loaded", async () => {
    h.overrides.mockRejectedValue(new Error("permission-denied")); await render();
    await act(async () => appData.patchOverrides(prev => ({ ...prev, one: { workoutId: "one", isExcluded: true, updatedAt: input.asOf } })));
    expect(appData.sourceHasLoaded.overrides).toBe(false);
    expect(estimate()).toBeNull();
  });

  it.each(["new UID", "same UID new session"])("rejects late reads and residency from a retired session: %s", async replacement => {
    await render();
    const pending = deferred<unknown[]>(); h.workouts.mockReturnValueOnce(pending.promise);
    let oldRequest!: Promise<void>;
    await act(async () => { oldRequest = appData.refreshWorkouts(); });
    h.valid = false;
    pending.resolve(input.workouts); await act(async () => oldRequest);
    h.epoch = 2; h.valid = true;
    if (replacement === "new UID") h.uid = "replacement-owner";
    h.workouts.mockRejectedValue(new Error("unavailable"));
    h.overrides.mockResolvedValue({}); h.races.mockResolvedValue([]);
    await render();
    expect(appData.sourceHasLoaded.workouts).toBe(false);
    expect(appData.workouts).toEqual([]);
    expect(estimate()).toBeNull(); expect(text()).not.toContain("2:11:11");
  });

  it("ignores an old initial result arriving while a replacement session is still loading", async () => {
    const old = deferred<unknown[]>(), next = deferred<unknown[]>();
    h.workouts.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    await render(); h.epoch = 2; await render();
    old.resolve(input.workouts); await flush();
    expect(appData.sourceHasLoaded.workouts).toBe(false); expect(appData.workouts).toEqual([]);
    next.resolve([]); await flush();
    expect(appData.sourceHasLoaded.workouts).toBe(true); expect(appData.workouts).toEqual([]);
    expect(estimate()?.textContent).toContain("Insufficient evidence");
  });

  it("keeps successful empty history distinct from a failed request on refresh and remount", async () => {
    h.workouts.mockResolvedValue([]); h.races.mockResolvedValue([]); await render();
    expect(text()).toContain("No past race results");
    mounted = false; await render();
    h.workouts.mockRejectedValue(new Error("unavailable")); await act(async () => appData.refreshWorkouts());
    mounted = true; await render();
    expect(text()).toContain("No past race results"); expect(text()).toContain("may be out of date");
    expect(estimate()?.textContent).toContain("Insufficient evidence");
  });

  it.each([390, 1280])("remounts at width %s during a failed Health-return revalidation without losing resident sections", async width => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    await render();
    mounted = false; trainingActive = false; h.pathname = "/health"; await render();
    h.plans.mockRejectedValue(new Error("unavailable"));
    h.overrides.mockRejectedValue(new Error("unavailable"));
    mounted = true; trainingActive = true; h.pathname = "/plan-insights"; await render();
    expect(estimate()?.textContent).toContain("~2:09");
    expect(section("Training Progress")).toBeTruthy(); expect(text()).toContain("may be out of date");
    mounted = false; await render(); mounted = true; await render();
    expect(estimate()?.textContent).toContain("~2:09");
  });

  it("retains the panel across an eligible foreground workout delta and failed response", async () => {
    await render(); const pending = deferred<unknown[]>(); h.delta.mockReturnValueOnce(pending.promise);
    vi.setSystemTime(new Date(Date.now() + 31_000));
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(h.delta).toHaveBeenCalledOnce(); expect(estimate()).toBeTruthy();
    pending.reject(new Error("unavailable")); await flush();
    expect(estimate()).toBeTruthy(); expect(text()).toContain("may be out of date");
  });
});
