import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AppDataProvider,
  useAppData,
  type AppDataContextValue,
} from "@/contexts/AppDataContext";

// React 19 requires this flag for act() to flush effects/microtasks in tests.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Shared handles the mocked service modules write to, so tests can drive the
// live listener callback and swap fetch results.
const h = vi.hoisted(() => ({
  snapshotCb: { current: null as null | ((w: unknown[]) => void) },
  fetchPlans: vi.fn(),
  fetchRaces: vi.fn(),
  fetchAllOverrides: vi.fn(),
  fetchUserSettings: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { uid: "u1" }, loading: false }),
}));
vi.mock("@/services/healthWorkouts", () => ({
  onHealthWorkoutsSnapshot: (
    _uid: string,
    _opts: unknown,
    onData: (w: unknown[]) => void
  ) => {
    h.snapshotCb.current = onData;
    return () => {
      h.snapshotCb.current = null;
    };
  },
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

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <AppDataProvider>
        <Probe />
      </AppDataProvider>
    );
  });
  // Extra flush so post-await setState in the fetch effects settles.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  latest = null;
  h.snapshotCb.current = null;
  h.fetchPlans.mockResolvedValue([]);
  h.fetchRaces.mockResolvedValue([]);
  h.fetchAllOverrides.mockResolvedValue({});
  h.fetchUserSettings.mockResolvedValue(null);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
});

describe("AppDataProvider", () => {
  it("keeps workoutsLoading true until the live listener fires", async () => {
    await mount();
    // Fetches have resolved, but the snapshot callback hasn't been invoked.
    expect(latest?.workoutsLoading).toBe(true);
    expect(latest?.workouts).toEqual([]);

    await act(async () => {
      h.snapshotCb.current?.([{ workoutId: "w1", isRunLike: true }]);
    });
    expect(latest?.workoutsLoading).toBe(false);
    expect(latest?.workouts).toHaveLength(1);
  });

  it("populates workouts from the live listener and reflects later updates", async () => {
    await mount();
    await act(async () => {
      h.snapshotCb.current?.([{ workoutId: "w1" }]);
    });
    expect(latest?.workouts.map((w) => (w as { workoutId: string }).workoutId)).toEqual(["w1"]);

    // A second snapshot (iOS sync) replaces the array.
    await act(async () => {
      h.snapshotCb.current?.([{ workoutId: "w1" }, { workoutId: "w2" }]);
    });
    expect(
      latest?.workouts.map((w) => (w as { workoutId: string }).workoutId)
    ).toEqual(["w1", "w2"]);
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
    expect(latest?.racesLoading).toBe(false);
    expect(latest?.overridesLoading).toBe(false);
    expect(latest?.settingsLoading).toBe(false);
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
