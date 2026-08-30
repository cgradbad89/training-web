import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AppDataProvider,
  workoutDeltaStartDate,
  useAppData,
  type AppDataContextValue,
} from "@/contexts/AppDataContext";
import {
  selectActiveWorkouts,
  selectEffectiveWorkouts,
} from "@/utils/selectActiveWorkouts";

// React 19 requires this flag for act() to flush effects/microtasks in tests.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Shared handles the mocked service modules write to, so tests can drive
// fetch results and inspect what each mock was called with.
const h = vi.hoisted(() => ({
  fetchHealthWorkouts: vi.fn(),
  fetchHealthWorkoutsInRange: vi.fn(),
  fetchPlans: vi.fn(),
  fetchRaces: vi.fn(),
  fetchAllOverrides: vi.fn(),
  fetchUserSettings: vi.fn(),
}));

vi.mock("@/services/healthWorkouts", () => ({
  fetchHealthWorkouts: h.fetchHealthWorkouts,
  fetchHealthWorkoutsInRange: h.fetchHealthWorkoutsInRange,
}));
vi.mock("@/services/plans", () => ({ fetchPlans: h.fetchPlans }));
vi.mock("@/services/races", () => ({ fetchRaces: h.fetchRaces }));
vi.mock("@/services/workoutOverrides", () => ({
  fetchAllOverrides: h.fetchAllOverrides,
}));
vi.mock("@/services/userSettings", () => ({
  fetchUserSettings: h.fetchUserSettings,
}));

// A probe that publishes the latest context value for assertions.
let latest: AppDataContextValue | null = null;
function Probe() {
  latest = useAppData();
  return null;
}

let container: HTMLDivElement;
let root: Root;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<AppDataProvider uid="u1"><Probe /></AppDataProvider>);
  });
  // Extra flush so post-await setState in the fetch effects settles.
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderUid(uid: string) {
  await act(async () => {
    root.render(<AppDataProvider uid={uid}><Probe /></AppDataProvider>);
    await Promise.resolve();
  });
}

beforeEach(() => {
  latest = null;
  h.fetchHealthWorkouts.mockReset().mockResolvedValue([]);
  h.fetchHealthWorkoutsInRange.mockReset().mockResolvedValue([]);
  h.fetchPlans.mockReset().mockResolvedValue([]);
  h.fetchRaces.mockReset().mockResolvedValue([]);
  h.fetchAllOverrides.mockReset().mockResolvedValue({});
  h.fetchUserSettings.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AppDataProvider", () => {
  it("fetches workouts once on mount via getDocs, not a live listener", async () => {
    h.fetchHealthWorkouts.mockResolvedValue([{ workoutId: "w1" }]);
    await mount();

    expect(latest?.workoutsLoading).toBe(false);
    expect(latest?.workoutsResolution).toBe("success");
    expect(
      latest?.workouts.map((w) => (w as { workoutId: string }).workoutId)
    ).toEqual(["w1"]);
    // Exactly one fetch on mount — no onSnapshot subscription exists to fire
    // additional callbacks.
    expect(h.fetchHealthWorkouts).toHaveBeenCalledTimes(1);
  });

  it("reports workoutsLoading only while the first successful load is pending", async () => {
    const initial = deferred<Array<{ workoutId: string }>>();
    h.fetchHealthWorkouts.mockReturnValue(initial.promise);
    await mount();

    expect(latest?.workoutsLoading).toBe(true);
    expect(latest?.workoutsResolution).toBe("loading");
    expect(latest?.workoutsRefreshing).toBe(false);

    initial.resolve([{ workoutId: "w1" }]);
    await act(async () => initial.promise);
    expect(latest?.workoutsLoading).toBe(false);
    expect(latest?.workoutsRefreshing).toBe(false);
    expect(latest?.workoutsResolution).toBe("success");
  });

  it("keeps every data domain loading until the resolved user's initial reads finish", async () => {
    const workouts = deferred<Array<{ workoutId: string }>>();
    const plans = deferred<never[]>();
    const races = deferred<never[]>();
    const overrides = deferred<Record<string, never>>();
    const settings = deferred<null>();
    h.fetchHealthWorkouts.mockReturnValue(workouts.promise);
    h.fetchPlans.mockReturnValue(plans.promise);
    h.fetchRaces.mockReturnValue(races.promise);
    h.fetchAllOverrides.mockReturnValue(overrides.promise);
    h.fetchUserSettings.mockReturnValue(settings.promise);

    await mount();

    expect(latest).toEqual(
      expect.objectContaining({
        workoutsLoading: true,
        plansLoading: true,
        plansResolution: "loading",
        racesLoading: true,
        overridesLoading: true,
        settingsLoading: true,
      })
    );

    workouts.resolve([]);
    plans.resolve([]);
    races.resolve([]);
    overrides.resolve({});
    settings.resolve(null);
    await act(async () => {
      await Promise.all([
        workouts.promise,
        plans.promise,
        races.promise,
        overrides.promise,
        settings.promise,
      ]);
    });
  });

  it("marks a legitimate zero-workout result loaded for a resolved user", async () => {
    h.fetchHealthWorkouts.mockResolvedValue([]);
    await mount();

    expect(h.fetchHealthWorkouts).toHaveBeenCalledWith("u1", {
      limitCount: 1000,
    });
    expect(latest?.workouts).toEqual([]);
    expect(latest?.workoutsLoading).toBe(false);
    expect(latest?.workoutsResolution).toBe("success");
  });

  it("marks a failed workouts read as failed after loading finishes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.fetchHealthWorkouts.mockRejectedValueOnce(new Error("workouts unavailable"));

    await mount();

    expect(latest?.workouts).toEqual([]);
    expect(latest?.workoutsLoading).toBe(false);
    expect(latest?.workoutsResolution).toBe("error");
  });

  it("recovers a failed workouts source after a successful refresh", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.fetchHealthWorkouts
      .mockRejectedValueOnce(new Error("workouts unavailable"))
      .mockResolvedValueOnce([{ workoutId: "recovered" }]);
    await mount();
    expect(latest?.workoutsResolution).toBe("error");

    await act(async () => {
      await latest?.refreshWorkouts();
    });

    expect(latest?.workoutsResolution).toBe("success");
    expect(latest?.workouts.map((workout) => workout.workoutId)).toEqual([
      "recovered",
    ]);
  });

  it("fetches workouts with the shared 1000 limit", async () => {
    await mount();
    expect(h.fetchHealthWorkouts).toHaveBeenCalledWith("u1", {
      limitCount: 1000,
    });
    expect(latest?.workoutsHistoryComplete).toBe(true);
  });

  it("marks capped workout history as incomplete for all-time consumers", async () => {
    h.fetchHealthWorkouts.mockResolvedValue(
      Array.from({ length: 1000 }, (_, index) => ({
        workoutId: `w${index}`,
      }))
    );

    await mount();

    expect(latest?.workoutsHistoryComplete).toBe(false);
  });

  it("refreshWorkouts re-fetches and replaces the workouts array", async () => {
    h.fetchHealthWorkouts.mockResolvedValue([{ workoutId: "w1" }]);
    await mount();
    expect(
      latest?.workouts.map((w) => (w as { workoutId: string }).workoutId)
    ).toEqual(["w1"]);

    h.fetchHealthWorkouts.mockResolvedValue([
      { workoutId: "w1" },
      { workoutId: "w2" },
    ]);
    await act(async () => {
      await latest?.refreshWorkouts();
    });
    expect(
      latest?.workouts.map((w) => (w as { workoutId: string }).workoutId)
    ).toEqual(["w1", "w2"]);
    expect(h.fetchHealthWorkouts).toHaveBeenCalledTimes(2);
    expect(h.fetchHealthWorkoutsInRange).not.toHaveBeenCalled();
  });

  it("preserves workouts and uses workoutsRefreshing during a background refresh", async () => {
    h.fetchHealthWorkouts.mockResolvedValue([{ workoutId: "w1" }]);
    await mount();
    const background = deferred<Array<{ workoutId: string }>>();
    h.fetchHealthWorkouts.mockReturnValueOnce(background.promise);

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = latest!.refreshWorkouts();
    });

    expect(latest?.workoutsLoading).toBe(false);
    expect(latest?.workoutsRefreshing).toBe(true);
    expect(latest?.workouts.map((workout) => workout.workoutId)).toEqual(["w1"]);

    background.resolve([{ workoutId: "w2" }]);
    await act(async () => refreshPromise);
    expect(latest?.workoutsRefreshing).toBe(false);
    expect(latest?.workouts.map((workout) => workout.workoutId)).toEqual(["w2"]);
  });

  it("reuses one in-flight promise for overlapping workout refreshes", async () => {
    await mount();
    const background = deferred<Array<{ workoutId: string }>>();
    h.fetchHealthWorkouts.mockReturnValueOnce(background.promise);

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = latest!.refreshWorkouts();
      second = latest!.refreshWorkouts();
    });

    expect(first).toBe(second);
    expect(h.fetchHealthWorkouts).toHaveBeenCalledTimes(2);
    background.resolve([]);
    await act(async () => first);
  });

  it("merges recent changes and delayed backfills when a tab regains focus", async () => {
    const newest = new Date("2026-08-20T12:00:00.000Z");
    const older = new Date("2026-08-19T12:00:00.000Z");
    h.fetchHealthWorkouts.mockResolvedValue([
      { workoutId: "w1", startDate: newest, name: "original" },
      { workoutId: "w0", startDate: older },
    ]);
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await mount();

    h.fetchHealthWorkoutsInRange.mockResolvedValue([
      { workoutId: "w2", startDate: new Date("2026-08-21T12:00:00.000Z") },
      { workoutId: "w1", startDate: newest, name: "updated" },
      {
        workoutId: "backfill",
        startDate: new Date("2026-08-15T12:00:00.000Z"),
      },
    ]);
    vi.mocked(Date.now).mockReturnValue(32_000);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.fetchHealthWorkouts).toHaveBeenCalledTimes(1);
    expect(h.fetchHealthWorkoutsInRange).toHaveBeenCalledWith(
      "u1",
      workoutDeltaStartDate(newest)
    );
    expect(latest?.workouts.map((workout) => workout.workoutId)).toEqual([
      "w2",
      "w1",
      "w0",
      "backfill",
    ]);
    expect(latest?.workouts[1]?.name).toBe("updated");
  });

  it("performs one full reconciliation on a later local day, then returns to delta", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 12));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const initial = {
      workoutId: "initial",
      startDate: new Date(2026, 7, 20, 10),
    };
    const daily = {
      workoutId: "daily-full",
      startDate: new Date(2026, 7, 19, 10),
    };
    h.fetchHealthWorkouts.mockResolvedValueOnce([initial]);
    await mount();

    h.fetchHealthWorkouts.mockResolvedValueOnce([initial, daily]);
    vi.setSystemTime(new Date(2026, 7, 21, 12));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.fetchHealthWorkouts).toHaveBeenCalledTimes(2);
    expect(h.fetchHealthWorkoutsInRange).not.toHaveBeenCalled();
    expect(latest?.workouts.map((workout) => workout.workoutId)).toEqual([
      "initial",
      "daily-full",
    ]);
    expect(latest?.workoutsFullReconciliationVersion).toBe(2);

    h.fetchHealthWorkoutsInRange.mockResolvedValueOnce([]);
    vi.setSystemTime(new Date(2026, 7, 21, 12, 1));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.fetchHealthWorkouts).toHaveBeenCalledTimes(2);
    expect(h.fetchHealthWorkoutsInRange).toHaveBeenCalledTimes(1);
    expect(latest?.workoutsFullReconciliationVersion).toBe(2);
  });

  it("does not advance the daily-full marker after failure and retries full successfully", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 12));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const initial = {
      workoutId: "initial",
      startDate: new Date(2026, 7, 20, 10),
    };
    const recovered = {
      workoutId: "recovered",
      startDate: new Date(2026, 7, 10, 10),
    };
    h.fetchHealthWorkouts.mockResolvedValueOnce([initial]);
    await mount();

    h.fetchHealthWorkouts.mockRejectedValueOnce(new Error("daily full failed"));
    vi.setSystemTime(new Date(2026, 7, 21, 12));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest?.workouts.map((workout) => workout.workoutId)).toEqual([
      "initial",
    ]);
    expect(latest?.workoutsResolution).toBe("error");
    expect(latest?.workoutsFullReconciliationVersion).toBe(1);

    h.fetchHealthWorkouts.mockResolvedValueOnce([initial, recovered]);
    vi.setSystemTime(new Date(2026, 7, 21, 12, 1));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.fetchHealthWorkouts).toHaveBeenCalledTimes(3);
    expect(h.fetchHealthWorkoutsInRange).not.toHaveBeenCalled();
    expect(latest?.workoutsResolution).toBe("success");
    expect(latest?.workouts.map((workout) => workout.workoutId)).toEqual([
      "initial",
      "recovered",
    ]);
    expect(latest?.workoutsFullReconciliationVersion).toBe(2);
  });

  it("preserves workouts on a failed delta and recovers resolution on a later empty delta", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 12));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const initial = {
      workoutId: "initial",
      startDate: new Date(2026, 7, 20, 10),
    };
    h.fetchHealthWorkouts.mockResolvedValueOnce([initial]);
    await mount();

    h.fetchHealthWorkoutsInRange.mockRejectedValueOnce(
      new Error("delta failed")
    );
    vi.setSystemTime(new Date(2026, 7, 20, 12, 1));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest?.workouts.map((workout) => workout.workoutId)).toEqual([
      "initial",
    ]);
    expect(latest?.workoutsResolution).toBe("error");

    h.fetchHealthWorkoutsInRange.mockResolvedValueOnce([]);
    vi.setSystemTime(new Date(2026, 7, 20, 12, 2));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.fetchHealthWorkoutsInRange).toHaveBeenCalledTimes(2);
    expect(latest?.workoutsResolution).toBe("success");
    expect(latest?.workouts.map((workout) => workout.workoutId)).toEqual([
      "initial",
    ]);
  });

  it("recovers a workout older than the overlap on the next daily full reconciliation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 12));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const newest = {
      workoutId: "newest",
      startDate: new Date(2026, 7, 20, 10),
    };
    const delayedHistorical = {
      workoutId: "delayed-historical",
      startDate: new Date(2026, 7, 10, 8),
    };
    h.fetchHealthWorkouts.mockResolvedValueOnce([newest]);
    await mount();

    h.fetchHealthWorkoutsInRange.mockResolvedValueOnce([]);
    vi.setSystemTime(new Date(2026, 7, 20, 12, 1));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest?.workouts.map((workout) => workout.workoutId)).not.toContain(
      "delayed-historical"
    );

    h.fetchHealthWorkouts.mockResolvedValueOnce([newest, delayedHistorical]);
    vi.setSystemTime(new Date(2026, 7, 21, 12));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latest?.workouts.map((workout) => workout.workoutId)).toContain(
      "delayed-historical"
    );
  });

  it("recovers a workout older than the overlap immediately through manual full refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 12));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const newest = {
      workoutId: "newest",
      startDate: new Date(2026, 7, 20, 10),
    };
    const delayedHistorical = {
      workoutId: "delayed-historical",
      startDate: new Date(2026, 7, 10, 8),
    };
    h.fetchHealthWorkouts.mockResolvedValueOnce([newest]);
    await mount();

    h.fetchHealthWorkoutsInRange.mockResolvedValueOnce([]);
    vi.setSystemTime(new Date(2026, 7, 20, 12, 1));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });

    h.fetchHealthWorkouts.mockResolvedValueOnce([newest, delayedHistorical]);
    await act(async () => {
      await latest?.refreshWorkouts();
    });

    expect(h.fetchHealthWorkouts).toHaveBeenCalledTimes(2);
    expect(latest?.workouts.map((workout) => workout.workoutId)).toContain(
      "delayed-historical"
    );
  });

  it("queues a required manual full reconciliation behind an in-flight delta", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 12));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const newest = {
      workoutId: "newest",
      startDate: new Date(2026, 7, 20, 10),
    };
    const fullResult = {
      workoutId: "full-result",
      startDate: new Date(2026, 7, 10, 8),
    };
    h.fetchHealthWorkouts.mockResolvedValueOnce([newest]);
    await mount();

    const delta = deferred<Array<typeof newest>>();
    h.fetchHealthWorkoutsInRange.mockReturnValueOnce(delta.promise);
    h.fetchHealthWorkouts.mockResolvedValueOnce([newest, fullResult]);
    vi.setSystemTime(new Date(2026, 7, 20, 12, 1));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    let manualFull!: Promise<void>;
    act(() => {
      manualFull = latest!.refreshWorkouts();
    });
    expect(h.fetchHealthWorkouts).toHaveBeenCalledTimes(1);

    delta.resolve([]);
    await act(async () => manualFull);

    expect(h.fetchHealthWorkoutsInRange).toHaveBeenCalledTimes(1);
    expect(h.fetchHealthWorkouts).toHaveBeenCalledTimes(2);
    expect(latest?.workouts.map((workout) => workout.workoutId)).toEqual([
      "newest",
      "full-result",
    ]);
    expect(latest?.workoutsFullReconciliationVersion).toBe(2);
  });

  it("loads plans, races, overrides, and settings on mount", async () => {
    h.fetchPlans.mockResolvedValue([{ id: "p1" }]);
    h.fetchRaces.mockResolvedValue([{ id: "r1" }]);
    h.fetchAllOverrides.mockResolvedValue({ w1: { workoutId: "w1", isExcluded: true } });
    h.fetchUserSettings.mockResolvedValue({ maxHeartRate: 190, restingHeartRate: 50 });

    await mount();

    expect(latest?.plans).toEqual([{ id: "p1" }]);
    expect(latest?.races).toEqual([{ id: "r1" }]);
    expect(latest?.overrides).toEqual({ w1: { workoutId: "w1", isExcluded: true } });
    expect(latest?.maxHr).toBe(190);
    expect(latest?.restingHr).toBe(50);
    expect(latest?.plansLoading).toBe(false);
    expect(latest?.plansResolution).toBe("success");
    expect(latest?.racesLoading).toBe(false);
    expect(latest?.overridesLoading).toBe(false);
    expect(latest?.settingsLoading).toBe(false);
    expect(latest).toEqual(
      expect.objectContaining({
        plansResolution: "success",
        racesResolution: "success",
        overridesResolution: "success",
        settingsResolution: "success",
      })
    );
  });

  it("tracks failed settings, races, and overrides independently and recovers on refresh", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.fetchRaces.mockRejectedValueOnce(new Error("races unavailable"));
    h.fetchAllOverrides.mockRejectedValueOnce(new Error("overrides unavailable"));
    h.fetchUserSettings.mockRejectedValueOnce(new Error("settings unavailable"));
    await mount();

    expect(latest).toEqual(
      expect.objectContaining({
        racesLoading: false,
        racesResolution: "error",
        overridesLoading: false,
        overridesResolution: "error",
        settingsLoading: false,
        settingsResolution: "error",
      })
    );

    h.fetchRaces.mockResolvedValueOnce([]);
    h.fetchAllOverrides.mockResolvedValueOnce({});
    h.fetchUserSettings.mockResolvedValueOnce(null);
    await act(async () => {
      await Promise.all([
        latest?.refreshRaces(),
        latest?.refreshOverrides(),
        latest?.refreshSettings(),
      ]);
    });

    expect(latest).toEqual(
      expect.objectContaining({
        racesResolution: "success",
        overridesResolution: "success",
        settingsResolution: "success",
      })
    );
  });

  it("falls back to default HR anchors when settings are absent", async () => {
    h.fetchUserSettings.mockResolvedValue(null);
    await mount();
    // DEFAULT_MAX_HR / DEFAULT_RESTING_HR from utils/trainingLoad.
    expect(latest?.maxHr).toBe(185);
    expect(latest?.restingHr).toBe(60);
  });

  it("refreshPlans re-fetches and replaces plans", async () => {
    h.fetchPlans.mockResolvedValue([{ id: "p1" }]);
    await mount();
    expect(latest?.plans).toEqual([{ id: "p1" }]);

    h.fetchPlans.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    await act(async () => {
      await latest?.refreshPlans();
    });
    expect(latest?.plans).toEqual([{ id: "p1" }, { id: "p2" }]);
    expect(latest?.plansResolution).toBe("success");
  });

  it("treats a successful empty plans read as authoritative success", async () => {
    h.fetchPlans.mockResolvedValue([]);
    await mount();

    expect(latest).toEqual(
      expect.objectContaining({
        plans: [],
        plansLoading: false,
        plansResolution: "success",
      })
    );
  });

  it("marks a failed initial plans read as error instead of authoritative empty", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.fetchPlans.mockRejectedValueOnce(new Error("plans unavailable"));
    await mount();

    expect(latest).toEqual(
      expect.objectContaining({
        plans: [],
        plansLoading: false,
        plansResolution: "error",
      })
    );
  });

  it("preserves valid plans on refresh failure and recovers error to success", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.fetchPlans.mockResolvedValueOnce([{ id: "p1" }]);
    await mount();

    h.fetchPlans.mockRejectedValueOnce(new Error("temporary plans failure"));
    await act(async () => {
      await latest?.refreshPlans();
    });
    expect(latest).toEqual(
      expect.objectContaining({
        plans: [{ id: "p1" }],
        plansLoading: false,
        plansResolution: "error",
      })
    );

    h.fetchPlans.mockResolvedValueOnce([{ id: "p2" }]);
    await act(async () => {
      await latest?.refreshPlans();
    });
    expect(latest).toEqual(
      expect.objectContaining({
        plans: [{ id: "p2" }],
        plansResolution: "success",
      })
    );
  });

  it("isolates every async source and workout request state across a direct A-to-B UID transition", async () => {
    const aWorkouts = deferred<Array<{ workoutId: string }>>();
    const aPlans = deferred<Array<{ id: string }>>();
    const aRaces = deferred<Array<{ id: string }>>();
    const aOverrides = deferred<Record<string, { workoutId: string }>>();
    const aSettings = deferred<{ maxHeartRate: number } | null>();

    h.fetchHealthWorkouts
      .mockReturnValueOnce(aWorkouts.promise)
      .mockResolvedValueOnce([{ workoutId: "b-workout" }]);
    h.fetchPlans
      .mockReturnValueOnce(aPlans.promise)
      .mockResolvedValueOnce([{ id: "b-plan" }]);
    h.fetchRaces
      .mockReturnValueOnce(aRaces.promise)
      .mockResolvedValueOnce([{ id: "b-race" }]);
    h.fetchAllOverrides
      .mockReturnValueOnce(aOverrides.promise)
      .mockResolvedValueOnce({
        "b-workout": { workoutId: "b-workout" },
      });
    h.fetchUserSettings
      .mockReturnValueOnce(aSettings.promise)
      .mockResolvedValueOnce({ maxHeartRate: 177 });

    await mount();
    expect(h.fetchHealthWorkouts).toHaveBeenCalledWith("u1", {
      limitCount: 1000,
    });

    await renderUid("u2");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.fetchHealthWorkouts).toHaveBeenCalledWith("u2", {
      limitCount: 1000,
    });
    expect(h.fetchPlans).toHaveBeenCalledWith("u2");
    expect(h.fetchRaces).toHaveBeenCalledWith("u2");
    expect(h.fetchAllOverrides).toHaveBeenCalledWith("u2");
    expect(h.fetchUserSettings).toHaveBeenCalledWith("u2");
    expect(latest).toEqual(
      expect.objectContaining({
        workouts: [{ workoutId: "b-workout" }],
        plans: [{ id: "b-plan" }],
        races: [{ id: "b-race" }],
        overrides: { "b-workout": { workoutId: "b-workout" } },
        maxHr: 177,
        workoutsFullReconciliationVersion: 1,
      })
    );

    aWorkouts.resolve([{ workoutId: "a-workout" }]);
    aPlans.resolve([{ id: "a-plan" }]);
    aRaces.resolve([{ id: "a-race" }]);
    aOverrides.resolve({ "a-workout": { workoutId: "a-workout" } });
    aSettings.resolve({ maxHeartRate: 199 });
    await act(async () => {
      await Promise.all([
        aWorkouts.promise,
        aPlans.promise,
        aRaces.promise,
        aOverrides.promise,
        aSettings.promise,
      ]);
      await Promise.resolve();
    });

    expect(latest).toEqual(
      expect.objectContaining({
        workouts: [{ workoutId: "b-workout" }],
        plans: [{ id: "b-plan" }],
        races: [{ id: "b-race" }],
        overrides: { "b-workout": { workoutId: "b-workout" } },
        maxHr: 177,
        workoutsFullReconciliationVersion: 1,
      })
    );
  });

  it("does not promote user A's queued full refresh after user B becomes current", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 20, 12));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const userAWorkout = {
      workoutId: "a-workout",
      startDate: new Date(2026, 7, 20, 10),
    };
    const userBWorkout = {
      workoutId: "b-workout",
      startDate: new Date(2026, 7, 20, 11),
    };
    h.fetchHealthWorkouts.mockResolvedValueOnce([userAWorkout]);
    await mount();

    const userADelta = deferred<Array<typeof userAWorkout>>();
    h.fetchHealthWorkoutsInRange.mockReturnValueOnce(userADelta.promise);
    vi.setSystemTime(new Date(2026, 7, 20, 12, 1));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    let userAQueuedFull!: Promise<void>;
    act(() => {
      userAQueuedFull = latest!.refreshWorkouts();
    });
    expect(h.fetchHealthWorkouts).toHaveBeenCalledTimes(1);

    h.fetchHealthWorkouts.mockResolvedValueOnce([userBWorkout]);
    await renderUid("u2");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.fetchHealthWorkouts).toHaveBeenCalledTimes(2);
    expect(h.fetchHealthWorkouts).toHaveBeenLastCalledWith("u2", {
      limitCount: 1000,
    });

    userADelta.resolve([]);
    await act(async () => {
      await userADelta.promise;
      await userAQueuedFull;
      await Promise.resolve();
    });

    expect(h.fetchHealthWorkouts).toHaveBeenCalledTimes(2);
    expect(latest?.workouts.map((workout) => workout.workoutId)).toEqual([
      "b-workout",
    ]);
    expect(latest?.workoutsFullReconciliationVersion).toBe(1);
  });

  it("refreshOverrides and refreshSettings re-fetch", async () => {
    await mount();
    expect(latest?.overrides).toEqual({});

    h.fetchAllOverrides.mockResolvedValue({ w9: { workoutId: "w9", isExcluded: false } });
    h.fetchUserSettings.mockResolvedValue({ maxHeartRate: 200 });
    await act(async () => {
      await latest?.refreshOverrides();
      await latest?.refreshSettings();
    });
    expect(latest?.overrides).toEqual({ w9: { workoutId: "w9", isExcluded: false } });
    expect(latest?.maxHr).toBe(200);
  });

  it("patchOverrides applies an optimistic local update", async () => {
    await mount();
    await act(async () => {
      latest?.patchOverrides((prev) => ({
        ...prev,
        wX: { workoutId: "wX", isExcluded: true } as never,
      }));
    });
    expect(latest?.overrides.wX).toEqual({ workoutId: "wX", isExcluded: true });
  });

  it("patchTrainingLoad updates exactly one workout without refresh, duplication, or reordering", async () => {
    h.fetchHealthWorkouts.mockResolvedValue([
      { workoutId: "newest", trainingLoadV2: 95, marker: "keep" },
      { workoutId: "older", trainingLoadV2: 40, marker: "untouched" },
    ]);
    await mount();

    await act(async () => {
      latest?.patchTrainingLoad("newest", {
        trainingLoadV2: 97,
        trainingLoadMethod: "streamed",
        trainingLoadBasisComplete: true,
      });
    });

    expect(h.fetchHealthWorkouts).toHaveBeenCalledTimes(1);
    expect(latest?.workouts.map((workout) => workout.workoutId)).toEqual([
      "newest",
      "older",
    ]);
    expect(latest?.workouts).toHaveLength(2);
    expect(latest?.workouts[0]).toMatchObject({
      workoutId: "newest",
      trainingLoadV2: 97,
      trainingLoadMethod: "streamed",
      trainingLoadBasisComplete: true,
      marker: "keep",
    });
    expect(latest?.workouts[1]).toMatchObject({
      workoutId: "older",
      trainingLoadV2: 40,
      marker: "untouched",
    });
  });

  it("ignores a training-load patch callback from a disposed UID generation", async () => {
    h.fetchHealthWorkouts.mockResolvedValueOnce([
      { workoutId: "shared-id", trainingLoadV2: 95 },
    ]);
    await mount();
    const stalePatch = latest!.patchTrainingLoad;

    h.fetchHealthWorkouts.mockResolvedValueOnce([
      { workoutId: "shared-id", trainingLoadV2: 200 },
    ]);
    await renderUid("u2");
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      stalePatch("shared-id", {
        trainingLoadV2: 97,
        trainingLoadMethod: "streamed",
        trainingLoadBasisComplete: true,
      });
    });

    expect(latest?.workouts[0].trainingLoadV2).toBe(200);
  });

  // Regression guard for the Workouts-page ↔ Dashboard override desync
  // (PRD.md §6): Dashboard's `activeWorkouts` is `selectActiveWorkouts(workouts,
  // overrides)` fed straight from this ONE shared provider instance. Before the
  // fix, workouts/page.tsx wrote exclusions to its own page-local state instead
  // of calling patchOverrides, so this context's `overrides` never learned about
  // them and any other consumer sharing the SAME provider (no remount) kept
  // showing the "excluded" workout. This asserts the fixed contract end-to-end:
  // a patchOverrides call — exactly what workouts/page.tsx now performs after a
  // successful excludeWorkout() write — is immediately visible to a downstream
  // selectActiveWorkouts consumer with no fresh AppDataProvider mount involved.
  it("a downstream selectActiveWorkouts consumer reflects patchOverrides immediately, with no fresh provider mount", async () => {
    h.fetchHealthWorkouts.mockResolvedValue([
      { workoutId: "w1" },
      { workoutId: "w2" },
    ]);
    await mount();

    const before = selectActiveWorkouts(latest!.workouts, latest!.overrides);
    expect(before.map((w) => w.workoutId)).toEqual(["w1", "w2"]);

    // Simulate the Workouts page's exclude handler: the Firestore write has
    // already succeeded by this point, and this is the local sync step.
    await act(async () => {
      latest?.patchOverrides((prev) => ({
        ...prev,
        w1: {
          workoutId: "w1",
          userId: "u1",
          isExcluded: true,
          excludedAt: new Date().toISOString(),
          excludedReason: null,
          distanceMilesOverride: null,
          durationSecondsOverride: null,
          runTypeOverride: null,
          updatedAt: new Date().toISOString(),
        },
      }));
    });

    // Same provider instance — no unmount/remount between the two reads.
    const after = selectActiveWorkouts(latest!.workouts, latest!.overrides);
    expect(after.map((w) => w.workoutId)).toEqual(["w2"]);
  });

  it("a downstream effective-workout consumer sees an override and its reset without remounting", async () => {
    h.fetchHealthWorkouts.mockResolvedValue([
      {
        workoutId: "w1",
        distanceMiles: 3,
        distanceMeters: 4828,
        durationSeconds: 1800,
        displayType: "Run",
        activityType: "running",
      },
    ]);
    await mount();

    expect(
      selectEffectiveWorkouts(latest!.workouts, latest!.overrides)[0]
        .distanceMiles
    ).toBe(3);

    await act(async () => {
      latest?.patchOverrides((prev) => ({
        ...prev,
        w1: {
          workoutId: "w1",
          userId: "u1",
          isExcluded: false,
          excludedAt: null,
          excludedReason: null,
          distanceMilesOverride: 5,
          durationSecondsOverride: null,
          runTypeOverride: null,
          updatedAt: "2026-08-29T12:00:00.000Z",
        },
      }));
    });

    expect(
      selectEffectiveWorkouts(latest!.workouts, latest!.overrides)[0]
        .distanceMiles
    ).toBe(5);

    await act(async () => {
      latest?.patchOverrides((prev) => {
        const next = { ...prev };
        delete next.w1;
        return next;
      });
    });

    expect(
      selectEffectiveWorkouts(latest!.workouts, latest!.overrides)[0]
        .distanceMiles
    ).toBe(3);
  });
});

describe("useAppData", () => {
  it("throws when used outside AppDataProvider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = document.createElement("div");
    const r = createRoot(c);
    expect(() =>
      act(() => {
        r.render(<Probe />);
      })
    ).toThrow(/useAppData must be used within an AppDataProvider/);
    act(() => r.unmount());
    spy.mockRestore();
  });
});
