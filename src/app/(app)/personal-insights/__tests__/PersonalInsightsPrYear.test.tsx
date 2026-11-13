import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  searchParams: new URLSearchParams("tab=performance"),
  aggregatedStats: { loading: false, error: null as Error | null, data: null as unknown },
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
    overridesLoading: false,
    sourceHasLoaded: { workouts: true, overrides: true, races: true, plans: true, settings: true },
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/personal-insights",
  useSearchParams: () => h.searchParams,
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { uid: "u1" }, loading: false }) }));
vi.mock("@/hooks/usePhysiologyEvidence", () => ({
  usePhysiologyEvidence: () => ({
    vo2: { state: "not_requested", entries: undefined, docsRead: 0 },
    streams: { state: "not_requested", summaries: undefined, report: null, eligible: 0, withStream: 0 },
  }),
}));
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => h.appData }));
vi.mock("@/hooks/useAggregatedStats", () => ({ useAggregatedStats: () => h.aggregatedStats }));

import PersonalInsightsPage from "../page";

let container: HTMLDivElement;
let root: Root;

function run(id: string, start: Date, miles: number, secs: number) {
  return {
    workoutId: id, name: "Run", displayType: "Run", activityType: "HKWorkoutActivityTypeRunning",
    startDate: start, endDate: new Date(start.getTime() + secs * 1000), durationSeconds: secs,
    distanceMiles: miles, isRunLike: true, sourceName: "Watch", calories: 400, hasRoute: false,
  };
}
function statsDoc(statsYear: number, paceSeconds: number) {
  return {
    statsYear,
    vo2History: [], hrZoneDistribution: null, paceTrends: [],
    personalRecordsByYear: {
      prs: [{ pace: paceSeconds, miles: 2, date: new Date(statsYear, 5, 1) }, null, null, null, null],
      specificPrs: [null, null, null, null, null, null],
    },
    fastestMileSegment: { seconds: paceSeconds, date: new Date(statsYear, 5, 1) },
  };
}
const text = () => container.textContent ?? "";
function click(label: string) {
  const btn = container.querySelector(`button[aria-label='${label}']`) as HTMLButtonElement | null;
  expect(btn).toBeTruthy();
  act(() => btn!.click());
}

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(<PersonalInsightsPage />);
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", "true");
  vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "preview");
  vi.useFakeTimers({ toFake: ["Date"] });
  h.searchParams = new URLSearchParams("tab=performance");
  h.aggregatedStats = { loading: false, error: null, data: null };
  h.appData.workouts = [];
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Personal Records by Year — 2027 rollover", () => {
  it("2027-01-01: header is 2027 and shows the empty state when there are no 2027 runs", () => {
    vi.setSystemTime(new Date(2027, 0, 1, 12));
    h.appData.workouts = [run("a", new Date(2026, 11, 31, 20), 4, 2400)];
    h.aggregatedStats.data = statsDoc(2027, 400);
    mount();
    expect(text()).toContain("Personal Records by Year");
    expect(text()).toContain("2027");
    expect(text()).toContain("No runs logged in 2027 yet.");
    expect(text()).not.toContain("runs in 2027");
  });

  it("a cached doc with statsYear 2026 is never painted under 2027 (skeleton instead)", () => {
    vi.setSystemTime(new Date(2027, 0, 5, 12));
    h.appData.workouts = [run("j", new Date(2027, 0, 2, 9), 3, 1500)];
    h.aggregatedStats.data = statsDoc(2026, 400); // stale: 6:40 fastest mile
    mount();
    expect(text()).not.toContain("6:40");
    expect(container.querySelector("[aria-label='Loading personal records']")).toBeTruthy();
  });

  it("a doc validated for 2027 is painted for the current year", () => {
    vi.setSystemTime(new Date(2027, 0, 5, 12));
    h.appData.workouts = [run("j", new Date(2027, 0, 2, 9), 3, 1500)];
    h.aggregatedStats.data = statsDoc(2027, 450); // 7:30
    mount();
    expect(container.querySelector("[aria-label='Loading personal records']")).toBeNull();
    expect(text()).toContain("7:30");
    expect(text()).toContain("1 runs in 2027");
  });

  it("falls back to live runs for the current year if the aggregate errored", () => {
    vi.setSystemTime(new Date(2027, 0, 5, 12));
    h.appData.workouts = [run("j", new Date(2027, 0, 2, 9), 3, 1800)]; // 10:00/mi
    h.aggregatedStats.data = statsDoc(2026, 400);
    h.aggregatedStats.error = new Error("boom");
    mount();
    expect(container.querySelector("[aria-label='Loading personal records']")).toBeNull();
    expect(text()).toContain("10:00");
    expect(text()).not.toContain("6:40");
  });

  it("the selector lists runs' years plus the current year and switching to 2026 shows 2026 PRs from live runs", () => {
    vi.setSystemTime(new Date(2027, 0, 1, 12));
    h.appData.workouts = [
      run("a", new Date(2026, 5, 1, 8), 4, 2400), // 10:00/mi
      run("b", new Date(2025, 5, 1, 8), 4, 2000), // 8:20/mi
    ];
    h.aggregatedStats.data = statsDoc(2027, 400);
    mount();
    // 2027 → previous → 2026
    click("Previous year");
    expect(text()).toContain("2026");
    expect(text()).toContain("10:00");
    expect(text()).toContain("1 runs in 2026");
    expect(text()).not.toContain("6:40");
    // → 2025
    click("Previous year");
    expect(text()).toContain("8:20");
    // oldest year: previous disabled
    const prev = container.querySelector("button[aria-label='Previous year']") as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    // back to current year
    click("Next year");
    click("Next year");
    expect(text()).toContain("No runs logged in 2027 yet.");
  });
});
