import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import { currentFixture } from "@/utils/__tests__/fixtures/currentPerformanceFixture";
import { researchRace, workoutResearchFixture } from "@/utils/__tests__/fixtures/workoutRaceResearchFixture";
import { estimateCurrentHalfMarathon } from "@/utils/experimentalCurrentPerformance";
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
function renderFixture(input = currentFixture()) {
  vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
  render({ races: [...input.races], workouts: [...input.workouts], overrides: input.overrides ?? {}, asOf: new Date(input.asOf), timeZone: input.timeZone });
  return estimateCurrentHalfMarathon(input);
}
const summary = () => container.querySelector('[data-testid="experimental-current-estimate"]')!;
const adjustment = () => container.querySelector('[data-testid="training-adjustment"]')!;
const explanation = () => container.querySelector('[data-testid="adjustment-reason"]')!.textContent;
beforeEach(() => {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("Race performance summary presentation", () => {

  it("renders the numerical Production estimate, provisional baseline and compact explanation", () => {
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    const input = currentFixture(1.5, 4, 9);
    const text = render({ races: [...input.races], workouts: [...input.workouts], asOf: new Date(input.asOf) });
    const card = container.querySelector('[data-testid="experimental-current-estimate"]')!;
    expect(card.textContent).toContain("~2:09"); expect(card.textContent).toContain("~9:50/mi");
    expect(card.textContent).toContain("Historical raceRecorded, unverified2:11:11");
    expect(text).toContain("Recorded, unverified"); expect(text).toContain("Unvalidated training adjustment");
    expect(text).toContain("Why this estimate?"); expect(text).toContain("Volume and frequency");
    expect(text).toContain("Endurance preparation"); expect(text).toContain("No confidence interval is supported");
    expect(text).toContain("Race-day forecastWithheld");
    const why = [...container.querySelectorAll("details")].find(d => d.querySelector("summary")?.textContent === "Why this estimate?")!;
    expect(why.open).toBe(false); act(() => { why.open = true; }); expect(why.open).toBe(true);
    expect(container.querySelector("form")).toBeNull();
  });
  it("shows the explicit minimum-evidence reason in Production", () => {
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    const text = render(); expect(text).toContain("Insufficient evidence");
    expect(text).toContain("three completed training runs"); expect(text).toContain("2:11:11");
  });
  it("preserves compact responsive card classes and contained weekly-table overflow", () => {
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    const input = currentFixture(); render({ races: [...input.races], workouts: [...input.workouts], asOf: new Date(input.asOf) });
    expect(container.querySelector('[data-testid="experimental-current-estimate"]')?.className).toContain("min-w-0");
    expect(container.querySelector('[data-testid="estimate-values"]')?.className).toContain("flex-wrap");
    expect(summary().querySelectorAll("h3")).toHaveLength(1);
    expect(container.querySelector("details .grid")?.className).toContain("grid-cols-1");
    expect([...container.querySelectorAll("details .grid > div")].every(node => node.classList.contains("min-w-0"))).toBe(true);
    expect(container.querySelector("table")?.parentElement?.className).toContain("overflow-x-auto");
  });

  it("preserves the stable numerical estimate and pace and uses the model's actual zero reason", () => {
    const model = renderFixture();
    expect(model.finishMinutes).toBe(131); expect(model.paceSecondsPerMile).toBe(600);
    expect(summary().textContent).toContain("~2:11"); expect(summary().textContent).toContain("~10:00/mi");
    expect(adjustment().textContent).toBe("0 min");
    expect(explanation()).toBe(model.reason); expect(explanation()).toContain("deadbands");
    expect(explanation()).not.toContain("Not enough sustained evidence");
  });

  it("explains withheld adjustment using the selected anchor month, without claiming missing runs", () => {
    const input = currentFixture();
    const september = researchRace("september", "2026-09-20", 7871);
    input.races = [september.race];
    input.workouts = [september.workout, ...input.workouts.filter(w => w.workoutId.startsWith("current-") && w.startDate > new Date("2026-09-20T23:59:59Z"))];
    const model = renderFixture(input);
    expect(model.adjustmentMethod).toBe("withheld"); expect(model.finishMinutes).toBe(131);
    expect(adjustment().textContent).toBe("0 min");
    expect(explanation()).toBe("Not enough sustained evidence to adjust your September race baseline.");
    expect(summary().textContent).not.toMatch(/missing|inactive|inactivity/);
  });

  it.each([
    { scale: 1.5, frequency: 4, longest: 9, sign: "−", direction: "faster" },
    { scale: .5, frequency: 2, longest: 4, sign: "+", direction: "slower" },
  ])("shows the model's signed adjustment and sustained contributing evidence ($direction)", ({ scale, frequency, longest, sign, direction }) => {
    const model = renderFixture(currentFixture(scale, frequency, longest));
    expect(adjustment().textContent).toBe(`${sign}${Math.abs(Math.round(model.adjustmentSeconds / 60))} minEstimated ${direction}`);
    expect(explanation()).toContain("Sustained volume and frequency and endurance preparation evidence");
    expect(explanation()).not.toContain("Not enough");
    expect(container.textContent).toContain(model.reason);
    expect(model.validated).toBe(false);
  });

  it.each([{ scale: 1.3, direction: "faster" }, { scale: .7, direction: "slower" }])("distinguishes rounded zero from exact zero ($direction)", ({ scale, direction }) => {
    const model = renderFixture(currentFixture(scale));
    expect(model.adjustmentSeconds).not.toBe(0); expect(Math.abs(model.adjustmentSeconds)).toBeLessThan(30);
    expect(adjustment().textContent).toBe(`0 minRounded · Estimated ${direction}`);
    expect(explanation()).toContain("A sub-minute adjustment rounds to 0 min");
    expect(explanation()).not.toMatch(/unchanged|no adjustment|Not enough/);
    expect(container.textContent).toContain("Training adjustment before rounding:");
  });

  it("names supported comparable-effort evidence instead of claiming summary evidence", () => {
    const model = renderFixture(workoutResearchFixture());
    expect(model.adjustmentMethod).toBe("matched_effort");
    expect(explanation()).toContain("Comparable-effort pace evidence");
    expect(container.textContent).toContain("independent context-matched pairs");
  });

  it("uses the model calculation cutoff and latest eligible run even when the browser clock differs", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2030-01-01T12:00:00Z"));
    const input = currentFixture(); input.asOf = "2026-10-27T01:00:00Z";
    const model = renderFixture(input);
    expect(summary().textContent).toContain("Calculated as of:Oct 26, 2026");
    expect(summary().textContent).toContain("Latest included run:Oct 21, 2026");
    expect(model.dataThrough).toBe("2026-10-21");
    expect(container.textContent).toContain("Calculation cutoff 2026-10-27T01:00:00.000Z · America/New_York");
    expect(summary().textContent).not.toContain("2030"); vi.useRealTimers();
  });

  it("does not present an unavailable adjustment as zero or invent a latest run", () => {
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    render({ races: [], workouts: [] });
    expect(adjustment().textContent).toBe("Unavailable");
    expect(summary().textContent).toContain("Latest included run:Unavailable");
    expect(explanation()).toContain("No usable race anchor");
    expect(summary().textContent).not.toContain("0 min");
  });

  it("keeps selected-anchor identity, verification and older race details reachable", () => {
    const input = currentFixture();
    const older = researchRace("older-confirmed", "2026-08-10", 8000, true);
    input.races = [...input.races, older.race]; input.workouts = [...input.workouts, older.workout];
    const model = renderFixture(input);
    expect(model.anchor?.raceId).toBe("older-confirmed");
    expect(summary().textContent).toContain("Historical raceOwner-confirmed2:13:20");
    const why = [...container.querySelectorAll("details")].find(d => d.querySelector("summary")?.textContent === "Why this estimate?")!;
    expect(why.textContent).toContain("older-confirmed"); expect(why.textContent).toContain("Aug 10, 2026");
    expect(why.open).toBe(false); expect(why.querySelector("summary")?.className).toContain("focus-visible:outline");
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelector('a[href="/races"]')).toBeTruthy();
  });

  it("distinguishes a historical result at another distance from its HM equivalent", () => {
    const input = currentFixture(), anchor = researchRace("ten-k", "2026-08-30", 3600, true);
    anchor.race.raceDistance = "10K"; anchor.race.performanceEvidence!.distanceMeters = 10000;
    anchor.workout.distanceMiles = 10000 / 1609.344; anchor.workout.distanceMeters = 10000;
    input.races = [anchor.race]; input.workouts = [...input.workouts.slice(1), anchor.workout];
    const model = renderFixture(input);
    expect(summary().textContent).toContain("Historical raceOwner-confirmed1:00:00");
    expect(summary().textContent).toContain("Half-marathon equivalent");
    expect(model.baselineSeconds).not.toBe(3600);
  });

  it("shows the provisional historical time and withholds both numerical estimates", () => {
    const text = render();
    expect(text).toContain("2:11:11");
    expect(text).toContain("Recorded, unverified");
    expect(text).toContain("Sep 20, 2026");
    expect(text).toContain("Current capability estimateUnavailable");
    expect(text).toContain("Race-day forecastWithheld");
    expect(text).toContain("Mar 20, 2027");
    expect(text).toContain("not enabled in this build");
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
