import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// React 19 requires this flag for act() to flush effects/microtasks in tests.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Shared, hoisted handles the mocks read/write ──────────────────────────────
const h = vi.hoisted(() => ({
  // URLSearchParams the mocked useSearchParams() returns — swapped per test.
  searchParams: new URLSearchParams(),
  replace: vi.fn(),
  push: vi.fn(),
  aggregationCalls: [] as unknown[][],
  aggregatedStats: {
    loading: false,
    data: {
      vo2History: [],
      hrZoneDistribution: null,
      personalRecordsByYear: { prs: [], specificPrs: [] },
      paceTrends: [],
      fastestMileSegment: null,
    },
  },
  appData: {
    workouts: [] as unknown[],
    overrides: {},
    races: [] as unknown[],
    plans: [] as unknown[],
    maxHr: 190,
    restingHr: 50,
    workoutsLoading: false,
    settingsLoading: false,
    racesLoading: false,
  },
  riegelCalls: 0,
  loadScanCalls: 0,
  titleMapCalls: 0,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, push: h.push }),
  usePathname: () => "/personal-insights",
  useSearchParams: () => h.searchParams,
}));

// Collapse every next/dynamic section to a synchronous null so the page's
// tab-conditional structure renders without async chunk loading. The tabs we
// assert on use plain inline SectionHeaders (not dynamic), so nulling the
// dynamic charts is safe. NOTE: the "Workout Trends" heading lives INSIDE the
// dynamic WorkoutTrendsSection, so on the workouts tab we assert by the absence
// of the other two tabs' (synchronous) content instead.
vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = () => null;
    return Stub;
  },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { uid: "u1" }, loading: false }),
}));

vi.mock("@/contexts/AppDataContext", () => ({
  useAppData: () => h.appData,
}));

vi.mock("@/hooks/useAggregatedStats", () => ({
  useAggregatedStats: (...args: unknown[]) => {
    h.aggregationCalls.push(args);
    return h.aggregatedStats;
  },
}));

vi.mock("@/utils/riegelFit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/riegelFit")>();
  return {
    ...actual,
    fitRiegel: (...args: Parameters<typeof actual.fitRiegel>) => {
      h.riegelCalls += 1;
      return actual.fitRiegel(...args);
    },
  };
});

vi.mock("@/utils/trainingLoadSeries", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/utils/trainingLoadSeries")
  >();
  return {
    ...actual,
    buildDailyLoadMap: (...args: Parameters<typeof actual.buildDailyLoadMap>) => {
      h.loadScanCalls += 1;
      return actual.buildDailyLoadMap(...args);
    },
  };
});

vi.mock("@/utils/runPlanTitle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/runPlanTitle")>();
  return {
    ...actual,
    buildRunTitleMap: (...args: Parameters<typeof actual.buildRunTitleMap>) => {
      h.titleMapCalls += 1;
      return actual.buildRunTitleMap(...args);
    },
  };
});

// Imported after the mocks are registered.
import PersonalInsightsPage from "../page";

let container: HTMLDivElement;
let root: Root;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(<PersonalInsightsPage />);
  });
}

function hasText(text: string): boolean {
  return (container.textContent ?? "").includes(text);
}

beforeEach(() => {
  h.searchParams = new URLSearchParams();
  h.replace.mockClear();
  h.push.mockClear();
  h.aggregationCalls.length = 0;
  h.aggregatedStats.loading = false;
  h.appData.workoutsLoading = false;
  h.appData.overrides = {};
  h.appData.races = [];
  h.riegelCalls = 0;
  h.loadScanCalls = 0;
  h.titleMapCalls = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PersonalInsightsPage tabs", () => {
  it("defaults to the Fitness & Load tab when no ?tab= param is present", () => {
    mount();
    // Fitness content is shown…
    expect(hasText("Cardio Fitness (VO₂ max)")).toBe(true);
    expect(hasText("Training Load")).toBe(true);
    // …and the other tabs' content is fully unmounted.
    expect(hasText("Predicted Race Times")).toBe(false);
    expect(hasText("Personal Records by Year")).toBe(false);
    // Defaulting must NOT rewrite the URL.
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("renders the Race Readiness tab on first render with ?tab=performance", () => {
    h.searchParams = new URLSearchParams("tab=performance");
    mount();
    expect(hasText("Predicted Race Times")).toBe(true);
    expect(hasText("Personal Records by Year")).toBe(true);
    // Fitness content is not mounted.
    expect(hasText("Cardio Fitness (VO₂ max)")).toBe(false);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("renders the Workout Trends tab on first render with ?tab=workouts", () => {
    h.searchParams = new URLSearchParams("tab=workouts");
    mount();
    // Neither Fitness nor Race Readiness content is mounted → workouts tab active.
    expect(hasText("Cardio Fitness (VO₂ max)")).toBe(false);
    expect(hasText("Predicted Race Times")).toBe(false);
    expect(h.aggregationCalls.at(-1)?.at(-1)).toEqual({
      enabled: false,
      activeRaceId: null,
      activeRaceDate: null,
      overrides: {},
    });
    expect(h.riegelCalls).toBe(0);
    expect(h.loadScanCalls).toBe(0);
    expect(h.titleMapCalls).toBe(0);
  });

  it("runs Fitness preprocessing only when the Fitness tab is mounted", () => {
    mount();
    expect(h.aggregationCalls.at(-1)?.at(-1)).toEqual({
      enabled: true,
      activeRaceId: null,
      activeRaceDate: null,
      overrides: {},
    });
    expect(h.loadScanCalls).toBeGreaterThan(0);
    expect(h.titleMapCalls).toBeGreaterThan(0);
    expect(h.riegelCalls).toBe(0);
  });

  it("runs Riegel fits only when Race Readiness is mounted", () => {
    h.searchParams = new URLSearchParams("tab=performance");
    mount();
    expect(h.riegelCalls).toBe(4);
    expect(h.loadScanCalls).toBe(0);
    expect(h.titleMapCalls).toBe(0);
  });

  it("passes already-loaded active-race and override inputs to cache freshness", () => {
    h.appData.races = [
      { id: "race-1", raceDate: "2026-10-04", isActive: true },
    ];
    h.appData.overrides = {
      workout1: { workoutId: "workout1", updatedAt: "2026-08-20T10:00:00Z" },
    };

    mount();

    expect(h.aggregationCalls.at(-1)?.at(-1)).toEqual({
      enabled: true,
      activeRaceId: "race-1",
      activeRaceDate: "2026-10-04",
      overrides: h.appData.overrides,
    });
  });

  it("keeps existing tab content rendered during a background refresh", () => {
    mount();
    expect(hasText("Cardio Fitness (VO₂ max)")).toBe(true);

    h.appData.workoutsLoading = true;
    h.aggregatedStats.loading = true;
    act(() => {
      root.render(<PersonalInsightsPage />);
    });

    expect(hasText("Cardio Fitness (VO₂ max)")).toBe(true);
    expect(hasText("Training Load")).toBe(true);
  });

  it("falls back to Fitness & Load when ?tab= is an invalid value", () => {
    h.searchParams = new URLSearchParams("tab=bogus");
    mount();
    expect(hasText("Cardio Fitness (VO₂ max)")).toBe(true);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("writes the URL via router.replace when a tab is clicked", () => {
    mount();
    // The three tab buttons are the segmented pill group rendered by
    // InsightsTabsBar — find them by their labels.
    const tabButton = Array.from(
      container.querySelectorAll("button")
    ).find((b) => b.textContent === "Race Readiness");
    expect(tabButton).toBeTruthy();
    act(() => {
      tabButton!.click();
    });
    expect(h.replace).toHaveBeenCalledWith("/personal-insights?tab=performance", {
      scroll: false,
    });
    // The clicked tab's content is now shown.
    expect(hasText("Predicted Race Times")).toBe(true);
  });

  it("disables aggregation without running another tab's preprocessing when switching to Workout Trends", () => {
    mount();
    const loadCalls = h.loadScanCalls;
    const titleCalls = h.titleMapCalls;

    const tabButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Workout Trends"
    );
    expect(tabButton).toBeTruthy();
    act(() => {
      tabButton!.click();
    });

    expect(h.aggregationCalls.at(-1)?.at(-1)).toEqual({
      enabled: false,
      activeRaceId: null,
      activeRaceDate: null,
      overrides: {},
    });
    expect(h.loadScanCalls).toBe(loadCalls);
    expect(h.titleMapCalls).toBe(titleCalls);
    expect(h.riegelCalls).toBe(0);
  });
});
