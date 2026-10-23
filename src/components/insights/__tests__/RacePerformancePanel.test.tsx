import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import { RacePerformancePanel, type RacePerformancePanelProps } from "../RacePerformancePanel";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...rest}>{children}</a> }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const asOf = new Date("2026-10-23T16:00:00Z");
const race = (partial: Partial<Race> = {}): Race => ({
  id: "result", name: "Recorded half", raceDate: "2026-09-20", raceDistance: "halfMarathon",
  isActive: false, createdAt: "2026-09-21T00:00:00Z", actualRunId: "run", actualRunDate: "2026-09-20",
  actualRunDistanceMiles: 13.2, actualRunDurationSeconds: 7871, ...partial,
});
const workout = (partial: Partial<HealthWorkout> = {}): HealthWorkout => ({
  workoutId: "run", name: "Run", activityType: "running", displayType: "Run", isRunLike: true,
  startDate: new Date("2026-09-20T12:00:00Z"), endDate: new Date("2026-09-20T14:11:11Z"),
  durationSeconds: 7871, distanceMiles: 13.2, distanceMeters: 13.2 * 1609.344,
  sourceName: "Watch", syncedAt: new Date("2026-09-21T00:00:00Z"),
  hasRoute: true, calories: 1000, avgHeartRate: 150, avgPaceSecPerMile: 596,
  avgSpeedMPS: null, hrDriftPct: null, cadenceSPM: null, efficiencyRaw: null, efficiencyScore: null, elevationGainM: null,
  ...partial,
});
let root: Root;
let container: HTMLDivElement;
function render(partial: Partial<RacePerformancePanelProps> = {}) {
  act(() => root.render(<RacePerformancePanel races={[race()]} workouts={[workout()]} overrides={{}} plan={null} selectedRace={null} sourcesReady asOf={asOf} timeZone="America/New_York" {...partial} />));
  return container.textContent ?? "";
}
beforeEach(() => {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("Phase 3A summary presentation", () => {
  it("shows the provisional historical time and withholds both numerical estimates", () => {
    const text = render();
    expect(text).toContain("2:11:11");
    expect(text).toContain("Recorded, unverified");
    expect(text).toContain("Sep 20, 2026");
    expect(text).toContain("Current capability estimateUnavailable");
    expect(text).toContain("Race-day forecastWithheld");
    expect(text).toContain("Mar 20, 2027");
    expect(text).toContain("No confidence interval is supported");
    expect(container.querySelectorAll("ol > li")).toHaveLength(1);
  });

  it("keeps a timing discrepancy visible without promoting it to a benchmark", () => {
    const text = render({ workouts: [workout({ endDate: new Date("2026-09-20T14:25:59Z") })] });
    expect(text).toContain("Inconsistent");
    expect(text).toContain("elapsed 2:25:59");
    expect(text).toContain("No usable race benchmark");
  });

  it("provides useful empty states and no fabricated timeline points", () => {
    const text = render({ races: [], workouts: [] });
    expect(text).toContain("No past race results");
    expect(text).toContain("No completed runs");
    expect(text).toContain("Loaded workout history may be incomplete");
    expect(container.querySelectorAll("ol > li")).toHaveLength(0);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(8);
  });

  it("shows completed mileage and durations without synthetic planned credit", () => {
    const text = render({ workouts: [workout({ startDate: new Date("2026-10-22T12:00:00Z"), endDate: new Date("2026-10-22T13:00:00Z"), durationSeconds: 3600, distanceMiles: 6 })] });
    expect(text).toContain("6.0");
    expect(text).toContain("60 min");
    expect(text).toContain("Scheduled workouts contribute no performance credit");
    expect(text).not.toContain("R²");
  });

  it("does not convert unresolved source loading into evidence absence", () => {
    const text = render({ sourcesReady: false });
    expect(text).toContain("loaded successfully");
    expect(text).not.toContain("No past race results");
    expect(text).not.toContain("2:11:11");
  });

  it("separates the owner's selected target from a historical time", () => {
    const text = render({ selectedRace: race({ id: "goal", name: "Goal half", raceDate: "2027-03-20", targetPaceSecondsPerMile: 600, actualRunId: undefined }) });
    expect(text).toContain("Owner’s target finish time2:11:06");
    expect(text).toContain("Historical benchmark2:11:11");
  });
});
