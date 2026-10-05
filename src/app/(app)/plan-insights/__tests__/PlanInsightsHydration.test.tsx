import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { UserSettings } from "@/types/userSettings";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = vi.hoisted(() => ({
  workouts: vi.fn(), plans: vi.fn(), races: vi.fn(), overrides: vi.fn(), settings: vi.fn(), hydrate: vi.fn(),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { uid: "u1" } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/services/healthWorkouts", () => ({ fetchHealthWorkouts: h.workouts, fetchHealthWorkoutsInRange: vi.fn() }));
vi.mock("@/services/plans", () => ({ fetchPlans: h.plans }));
vi.mock("@/services/races", () => ({ fetchRaces: h.races }));
vi.mock("@/services/workoutOverrides", () => ({ fetchAllOverrides: h.overrides }));
vi.mock("@/services/userSettings", () => ({ fetchUserSettings: h.settings }));
vi.mock("@/services/fastFinishSplits", () => ({ hydrateFastFinishSplits: h.hydrate }));
vi.mock("@/utils/bestEffortExtraction", async importOriginal => {
  const actual = await importOriginal<typeof import("@/utils/bestEffortExtraction")>();
  return { ...actual, buildBestEffortSegments: vi.fn(actual.buildBestEffortSegments) };
});

import PlanInsightsPage from "../page";
import { AppDataProvider, useAppData, type AppDataContextValue } from "@/contexts/AppDataContext";
import { buildBestEffortSegments } from "@/utils/bestEffortExtraction";
import { DEFAULT_MAX_HR, DEFAULT_RESTING_HR } from "@/utils/trainingLoad";

let root: Root;
let container: HTMLDivElement;
let appData: AppDataContextValue;
function Page() {
  const value = useAppData();
  React.useEffect(() => { appData = value; }, [value]);
  return <PlanInsightsPage />;
}
const run = (): HealthWorkout => ({
  workoutId: "run", isRunLike: true, hasRoute: true, startDate: new Date(),
  distanceMiles: 6, durationSeconds: 3600, avgPaceSecPerMile: 600,
  avgHeartRate: 150, displayType: "Run", activityType: "running",
} as HealthWorkout);
const race = (partial: Partial<Race> = {}): Race => ({
  id: "half", name: "Half", raceDate: "2099-01-01", raceDistance: "halfMarathon",
  isActive: true, createdAt: "", ...partial,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
async function flush() { await act(async () => { await new Promise(res => setTimeout(res, 0)); }); }
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<AppDataProvider uid="u1"><Page /></AppDataProvider>));
  await flush();
}
beforeEach(() => {
  vi.clearAllMocks();
  h.workouts.mockResolvedValue([run()]); h.plans.mockResolvedValue([]);
  h.races.mockResolvedValue([race()]); h.overrides.mockResolvedValue({}); h.settings.mockResolvedValue(null);
  h.hydrate.mockImplementation(async (_uid, runs) => ({ runs, routeFetches: 0 }));
});
afterEach(() => { act(() => root?.unmount()); container?.remove(); vi.restoreAllMocks(); });

describe("Plan Insights demand-gated fast-finish hydration", () => {
  it.each([
    { races: [] },
    { races: [race({ raceDistance: "5k" })] },
    { races: [race({ raceDistance: "custom", customDistanceMiles: 10 })] },
  ])(
    "does no child hydration without a half-or-longer consumer ($races)", async ({ races }) => {
      h.races.mockResolvedValue(races);
      await mount();
      expect(h.hydrate).not.toHaveBeenCalled();
    }
  );

  it.each(["halfMarathon", "marathon"] as const)("hydrates a settled %s prediction with deliberate default anchors", async raceDistance => {
    h.races.mockResolvedValue([race({ raceDistance })]);
    await mount();
    expect(h.hydrate).toHaveBeenCalledOnce();
    expect(h.hydrate).toHaveBeenCalledWith("u1", [expect.objectContaining({ workoutId: "run" })], {
      maxHr: DEFAULT_MAX_HR, restingHr: DEFAULT_RESTING_HR,
    });
  });

  it("waits for settings and then hydrates with authoritative anchors", async () => {
    const settings = deferred<UserSettings>();
    h.settings.mockReturnValue(settings.promise);
    await mount();
    expect(h.hydrate).not.toHaveBeenCalled();
    settings.resolve({ maxHeartRate: 175, restingHeartRate: 65 } as UserSettings);
    await flush();
    expect(h.hydrate).toHaveBeenCalledWith("u1", expect.any(Array), { maxHr: 175, restingHr: 65 });
  });

  it("blocks hydration after failed settings", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.settings.mockRejectedValue(new Error("unavailable"));
    await mount();
    expect(h.hydrate).not.toHaveBeenCalled();
  });

  it.each(["plans", "races", "overrides", "workouts"] as const)("waits while required %s remain unresolved", async source => {
    const pending = deferred<never[]>();
    h[source].mockReturnValue(pending.promise);
    await mount();
    expect(h.hydrate).not.toHaveBeenCalled();
    pending.resolve([]);
  });

  it("rejects in-flight and already-settled hydration from a previous race selection", async () => {
    h.races.mockResolvedValue([race(), race({ id: "other", name: "Other half", raceDate: "2099-02-01", isActive: false })]);
    const old = deferred<{ runs: HealthWorkout[] }>();
    h.hydrate.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ runs: [{ ...run(), workoutId: "new-result" }] });
    await mount();
    await act(async () => {
      const picker = container.querySelector<HTMLSelectElement>("#race-picker")!;
      picker.value = "other";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(h.hydrate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(buildBestEffortSegments).mock.lastCall?.[0][0].workoutId).toBe("new-result");
    old.resolve({ runs: [{ ...run(), workoutId: "retired-result" }] });
    await flush();
    expect(vi.mocked(buildBestEffortSegments).mock.lastCall?.[0][0].workoutId).toBe("new-result");
    // Moving to a short race stops hydration and does not reuse half evidence.
    await act(async () => appData.patchRaces(prev => prev.map(r => r.id === "other" ? { ...r, raceDistance: "5k" } : r)));
    await flush();
    expect(h.hydrate).toHaveBeenCalledTimes(2);
  });

  it("rejects prior anchor/input hydration while the latest request is still pending", async () => {
    const old = deferred<{ runs: HealthWorkout[] }>();
    const current = deferred<{ runs: HealthWorkout[] }>();
    h.hydrate.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await mount();
    h.settings.mockResolvedValue({ maxHeartRate: 175, restingHeartRate: 65 });
    await act(async () => appData.refreshSettings());
    expect(h.hydrate).toHaveBeenCalledTimes(2);
    old.resolve({ runs: [{ ...run(), workoutId: "retired" }] });
    await flush();
    expect(vi.mocked(buildBestEffortSegments).mock.lastCall?.[0][0].workoutId).toBe("run");
    current.resolve({ runs: [{ ...run(), workoutId: "current" }] });
    await flush();
    expect(vi.mocked(buildBestEffortSegments).mock.lastCall?.[0][0].workoutId).toBe("current");
  });
});
