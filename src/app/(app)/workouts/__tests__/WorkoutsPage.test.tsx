import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type WorkoutOverride } from "@/types/workoutOverride";

// React 19 requires this flag for act() to flush effects/microtasks in tests.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Regression coverage for the Workouts-page ↔ Dashboard override desync
 * (PRD.md §6): workouts/page.tsx used to keep its own page-local `overrides`
 * state (a separate fetchAllOverrides(uid) call), so excluding/restoring a
 * workout there — or excluding via the duplicate-suggestion banner — never
 * reached AppDataContext's shared `overrides`, leaving Dashboard showing a
 * workout the user had just excluded. The fix routes the page through
 * useAppData()'s `overrides` + `patchOverrides` (the same mechanism
 * dashboard/page.tsx and runs/page.tsx already use), so every write is
 * visible everywhere. These tests assert patchOverrides is actually called
 * — the previous local-state bug would still pass a "workout disappears from
 * this page" test, which is why that alone isn't a sufficient regression
 * guard.
 */

// ── Shared, hoisted handles the mocks read/write ──────────────────────────────
const h = vi.hoisted(() => ({
  patchOverrides: vi.fn(),
  refreshWorkouts: vi.fn(),
  useAppDataReturn: {
    workouts: [] as HealthWorkout[],
    overrides: {} as Record<string, WorkoutOverride>,
    workoutsLoading: false,
    overridesLoading: false,
  },
  excludeWorkout: vi.fn(),
  restoreWorkout: vi.fn(),
  fetchUserSettings: vi.fn(),
  fetchDismissedDuplicates: vi.fn(),
  dismissDuplicate: vi.fn(),
  fetchHRStream: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { uid: "u1" }, loading: false }),
}));

vi.mock("@/contexts/AppDataContext", () => ({
  useAppData: () => ({
    workouts: h.useAppDataReturn.workouts,
    overrides: h.useAppDataReturn.overrides,
    workoutsLoading: h.useAppDataReturn.workoutsLoading,
    overridesLoading: h.useAppDataReturn.overridesLoading,
    patchOverrides: h.patchOverrides,
    refreshWorkouts: h.refreshWorkouts,
  }),
}));

vi.mock("@/hooks/useEnrichTrainingLoads", () => ({
  useEnrichTrainingLoads: () => {},
}));

vi.mock("@/services/userSettings", () => ({
  fetchUserSettings: h.fetchUserSettings,
}));

vi.mock("@/services/workoutOverrides", () => ({
  excludeWorkout: h.excludeWorkout,
  restoreWorkout: h.restoreWorkout,
}));

vi.mock("@/services/dismissedDuplicates", async () => {
  const actual = await vi.importActual<typeof import("@/services/dismissedDuplicates")>(
    "@/services/dismissedDuplicates"
  );
  return {
    ...actual,
    fetchDismissedDuplicates: h.fetchDismissedDuplicates,
    dismissDuplicate: h.dismissDuplicate,
  };
});

vi.mock("@/services/hrStream", () => ({
  fetchHRStream: h.fetchHRStream,
}));

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

// Imported after the mocks are registered.
import WorkoutsPage from "../page";

function buildWorkout(overrides: Partial<HealthWorkout> = {}): HealthWorkout {
  return {
    workoutId: "w1",
    name: "Strength",
    activityType: "traditional_strength_training",
    displayType: "Strength",
    startDate: new Date("2026-08-15T09:00:00"),
    endDate: new Date("2026-08-15T10:00:00"),
    durationSeconds: 3600,
    sourceName: "Apple Watch",
    isRunLike: false,
    hasRoute: false,
    hasHRStream: false,
    syncedAt: new Date("2026-08-15T10:05:00"),
    calories: 400,
    avgHeartRate: 130,
    distanceMiles: 0,
    distanceMeters: null,
    avgPaceSecPerMile: null,
    avgSpeedMPS: null,
    hrDriftPct: null,
    cadenceSPM: null,
    efficiencyRaw: null,
    efficiencyScore: null,
    elevationGainM: null,
    trainingLoadV2: 119,
    trainingLoadMethod: "avg-hr-fallback",
    ...overrides,
  } as HealthWorkout;
}

function buildOverride(workoutId: string, isExcluded: boolean): WorkoutOverride {
  return {
    workoutId,
    userId: "u1",
    isExcluded,
    excludedAt: isExcluded ? new Date().toISOString() : null,
    excludedReason: null,
    distanceMilesOverride: null,
    durationSecondsOverride: null,
    runTypeOverride: null,
    updatedAt: new Date().toISOString(),
  };
}

let container: HTMLDivElement;
let root: Root;

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<WorkoutsPage />);
  });
  await flush();
  await flush();
}

function clickWorkoutRow() {
  // MiniCalendar's day cells also use "cursor-pointer" (on <button>s in the
  // sidebar, rendered before the list), so scope to the WorkoutRow's root
  // <div> specifically rather than the first "cursor-pointer" match overall.
  const row = Array.from(
    container.querySelectorAll<HTMLDivElement>("div.cursor-pointer")
  )[0];
  expect(row).toBeTruthy();
  act(() => { row!.click(); });
}

function clickButtonByText(text: string) {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === text
  );
  expect(btn).toBeTruthy();
  act(() => { btn!.click(); });
}

beforeEach(() => {
  h.patchOverrides.mockClear();
  h.refreshWorkouts.mockClear();
  h.excludeWorkout.mockReset().mockResolvedValue(undefined);
  h.restoreWorkout.mockReset().mockResolvedValue(undefined);
  h.fetchUserSettings.mockReset().mockResolvedValue(null);
  h.fetchDismissedDuplicates.mockReset().mockResolvedValue(new Set<string>());
  h.dismissDuplicate.mockReset().mockResolvedValue(undefined);
  h.fetchHRStream.mockReset().mockResolvedValue([]);
  h.useAppDataReturn.workouts = [];
  h.useAppDataReturn.overrides = {};
  h.useAppDataReturn.workoutsLoading = false;
  h.useAppDataReturn.overridesLoading = false;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe("WorkoutsPage — shared overrides wiring", () => {
  it("reads overrides from the shared AppDataContext, not a page-local fetch", async () => {
    // A workout excluded in the SHARED context's overrides must be hidden
    // here without this page ever calling fetchAllOverrides itself — there
    // is no page-local override fetch left to race or diverge from Dashboard.
    h.useAppDataReturn.workouts = [buildWorkout({ workoutId: "w1" })];
    h.useAppDataReturn.overrides = { w1: buildOverride("w1", true) };
    await mount();

    // "Strength" itself is ambiguous — it's also a category-tab label — so
    // assert on the empty state that only appears when allWorkouts is empty,
    // i.e. the excluded workout was actually filtered out of the "All" list.
    expect(container.textContent).toContain("No All workouts in 2026");
    expect(container.querySelector("div.cursor-pointer")).toBeNull();
  });

  it("excluding a workout via WorkoutDetailModal calls the shared patchOverrides with isExcluded: true", async () => {
    h.useAppDataReturn.workouts = [buildWorkout({ workoutId: "w1" })];
    await mount();

    clickWorkoutRow();
    await flush();
    clickButtonByText("Exclude Workout");
    await flush();
    clickButtonByText("Exclude");
    await flush();

    expect(h.excludeWorkout).toHaveBeenCalledWith("u1", "w1");
    expect(h.patchOverrides).toHaveBeenCalledTimes(1);

    const updater = h.patchOverrides.mock.calls[0][0] as (
      prev: Record<string, WorkoutOverride>
    ) => Record<string, WorkoutOverride>;
    const result = updater({});
    expect(result.w1).toMatchObject({ workoutId: "w1", isExcluded: true });
  });

  it("restoring an excluded workout via WorkoutDetailModal calls the shared patchOverrides with isExcluded: false", async () => {
    h.useAppDataReturn.workouts = [buildWorkout({ workoutId: "w1" })];
    h.useAppDataReturn.overrides = { w1: buildOverride("w1", true) };
    await mount();

    // The excluded workout only shows under the "Excluded" tab.
    clickButtonByText("Excluded");
    await flush();
    clickWorkoutRow();
    await flush();
    clickButtonByText("Restore Workout");
    await flush();

    expect(h.restoreWorkout).toHaveBeenCalledWith("u1", "w1");
    expect(h.patchOverrides).toHaveBeenCalledTimes(1);

    const updater = h.patchOverrides.mock.calls[0][0] as (
      prev: Record<string, WorkoutOverride>
    ) => Record<string, WorkoutOverride>;
    const result = updater({ w1: buildOverride("w1", true) });
    expect(result.w1).toMatchObject({ workoutId: "w1", isExcluded: false });
  });

  it("excluding via the duplicate-suggestion banner calls the shared patchOverrides with isExcluded: true", async () => {
    const otf = buildWorkout({
      workoutId: "otf1",
      displayType: "HIIT",
      activityType: "high_intensity_interval_training",
      startDate: new Date("2026-08-15T09:00:00"),
      durationSeconds: 3600,
    });
    const manual = buildWorkout({
      workoutId: "manual1",
      displayType: "Strength",
      activityType: "traditional_strength_training",
      startDate: new Date("2026-08-15T09:10:00"),
      durationSeconds: 3300,
    });
    h.useAppDataReturn.workouts = [otf, manual];
    await mount();

    clickButtonByText("Exclude HIIT");
    await flush();

    expect(h.excludeWorkout).toHaveBeenCalledWith("u1", "otf1");
    expect(h.patchOverrides).toHaveBeenCalledTimes(1);

    const updater = h.patchOverrides.mock.calls[0][0] as (
      prev: Record<string, WorkoutOverride>
    ) => Record<string, WorkoutOverride>;
    const result = updater({});
    expect(result.otf1).toMatchObject({
      workoutId: "otf1",
      isExcluded: true,
      excludedReason: "auto-suggested duplicate",
    });
  });
});
