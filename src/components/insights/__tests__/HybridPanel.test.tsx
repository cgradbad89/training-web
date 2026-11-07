import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningPlan } from "@/types/plan";
import { hybridAthlete, type AthleteOptions } from "@/utils/__tests__/fixtures/hybridFixture";
import { RacePerformancePanel, type RacePerformancePanelProps, type RacePerformanceSources } from "../RacePerformancePanel";
import { HybridEstimateRow } from "../HybridEstimateRow";
import { RaceDayForecastRow } from "../RaceDayForecastRow";
import { estimateHybridHalfMarathon } from "@/utils/performance/hybridPerformance";
import { estimateRaceDayForecast } from "@/utils/performance/raceDayForecast";
import { isExperimentalHybridEstimateEnabled, isExperimentalRaceDayForecastEnabled } from "@/lib/racePerformanceGate";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...rest}>{children}</a> }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ready = { hasLoaded: true, resolution: "success" as const };
const sources: RacePerformanceSources = { workouts: ready, overrides: ready, races: ready, plans: ready };
const PLAN: RunningPlan = { id: "p", name: "Spring HM", startDate: "2026-11-09", status: "active", isActive: true, createdAt: "x", updatedAt: "x",
  weeks: Array.from({ length: 19 }, (_, w) => ({ weekNumber: w + 1, entries: [
    { id: `t${w}`, weekIndex: w, weekday: 2, dayOfWeek: 1, distanceMiles: 4 }, { id: `s${w}`, weekIndex: w, weekday: 6, dayOfWeek: 5, distanceMiles: Math.min(12, 8 + w * 0.3) }] })) };

let root: Root, container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production"); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); });

function mount(o: AthleteOptions = {}, extra: Partial<RacePerformancePanelProps> = {}) {
  const a = hybridAthlete({ longRunMiles: 8, ...o });
  act(() => root.render(<RacePerformancePanel races={a.races} workouts={a.workouts} overrides={a.overrides} plan={PLAN} selectedRace={null} sources={sources}
    asOf={new Date(a.asOf)} timeZone={a.timeZone} {...extra} />));
  return a;
}
const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const official = () => q("estimate-values")?.textContent;
const strong = [{ date: "2026-10-10", miles: 6, pace: 560, hr: 172 }, { date: "2026-10-24", miles: 6.5, pace: 555, hr: 172 }];

describe("hybrid estimate in Plan Insights", () => {
  it("shows the hybrid estimate beside the official and HR-enhanced rows, labelled experimental", () => {
    mount();
    const row = q("hybrid-estimate")!;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("Experimental — Hybrid Performance Model");
    expect(row.textContent).toContain("Experimental and not independently validated");
    expect(row.textContent).toMatch(/~\d:\d{2}/); expect(row.textContent).toMatch(/\/mi/);
    expect(q("hybrid-range")?.textContent).toContain("not a statistical interval");
    expect(q("experimental-current-estimate")!.contains(row)).toBe(true);
    expect(official()).toMatch(/~2:1\d/); // official v2 value is still shown, unchanged
    expect(q("hybrid-reason")?.textContent).toMatch(/Mainly/);
  });
  it("is removed by its own kill switch while the official estimate stays identical", () => {
    mount(); const withHybrid = official();
    vi.stubEnv("NEXT_PUBLIC_DISABLE_HYBRID_ESTIMATE", "true"); mount();
    expect(q("hybrid-estimate")).toBeNull(); expect(q("race-day-forecast")).toBeNull();
    expect(official()).toBe(withHybrid);
    expect(container.textContent).toContain("Withheld · not validated");
    expect(isExperimentalHybridEstimateEnabled()).toBe(false); expect(isExperimentalRaceDayForecastEnabled()).toBe(false);
  });
  it("the forecast has an independent kill switch", () => {
    mount(); expect(q("race-day-forecast")).toBeTruthy();
    vi.stubEnv("NEXT_PUBLIC_DISABLE_RACE_DAY_FORECAST", "true"); mount();
    expect(q("race-day-forecast")).toBeNull(); expect(q("hybrid-estimate")).toBeTruthy();
    expect(container.textContent).toContain("Withheld · not validated");
  });
  it("is absent where the official experiment is not enabled (non-production without opt-in)", () => {
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "preview"); vi.stubEnv("NEXT_PUBLIC_ENABLE_RACE_PERFORMANCE", undefined);
    mount(); expect(q("hybrid-estimate")).toBeNull(); expect(q("race-day-forecast")).toBeNull();
  });
  it("loading: unread sources show a loading state, never an estimate", () => {
    mount({}, { sources: { ...sources, workouts: { hasLoaded: false, resolution: "loading" } } });
    expect(container.textContent).toContain("Loading workouts"); expect(q("hybrid-estimate")).toBeNull();
  });
  it("unavailable: an expired race with no recent strong effort gives an explicit reason, and no number", () => {
    mount({ raceDate: "2026-04-01" });
    const row = q("hybrid-estimate")!;
    expect(row.getAttribute("data-status")).toBe("unavailable");
    expect(row.textContent).toContain("Not available"); expect(q("hybrid-reason")!.textContent).toMatch(/older than 180 days/);
    expect(q("race-day-forecast")?.getAttribute("data-status")).toBe("withheld");
    expect(q("race-day-forecast")!.textContent).toContain("Current capability is unavailable");
  });
  it("answers where the official estimate cannot: expired race but strong contemporary efforts", () => {
    mount({ raceDate: "2026-04-01", strong });
    expect(container.querySelector('[data-testid="experimental-current-estimate"]')!.textContent).toContain("Insufficient evidence");
    const row = q("hybrid-estimate")!;
    expect(row.getAttribute("data-status")).toBe("provisional"); expect(row.textContent).toMatch(/~\d:\d{2}/);
    expect(row.textContent).toContain("official estimate unavailable for comparison");
  });
  it("shows contradictions instead of hiding them", () => {
    mount({ strong: [{ date: "2026-10-24", miles: 6, pace: 520, hr: 178 }, { date: "2026-10-10", miles: 6, pace: 520, hr: 178 }] });
    expect(q("hybrid-contradiction")?.textContent).toMatch(/disagree/);
  });
  it("the estimate-details dialog carries the hybrid methodology, families, missing information and assumptions", () => {
    mount();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="view-estimate-details"]')!.click());
    const dialog = document.querySelector('[data-testid="estimate-details-dialog"]')!;
    const method = dialog.querySelector('[data-testid="hybrid-methodology"]')!;
    expect(method.textContent).toContain("Demonstrated performance"); expect(method.textContent).toContain("Physiological trend");
    expect(method.textContent).toContain("Race history"); expect(method.textContent).toContain("Endurance preparation");
    expect(method.querySelector('[data-testid="hybrid-missing"]')?.textContent).toMatch(/Weather|VO₂|heart-rate streams/);
    expect(method.textContent).toContain("No calibrated confidence interval");
    expect(method.textContent).toContain("experimental-hybrid-hm-v1");
  });
  it("race-day forecast is separate from current capability and states what it cannot know", () => {
    mount();
    const f = q("race-day-forecast")!;
    expect(f.textContent).toContain("Experimental race-day forecast"); expect(f.textContent).toMatch(/Provisional/);
    expect(q("forecast-separation")!.textContent).toMatch(/Today’s capability is ~\d:\d{2} \(a separate estimate\)/);
    expect(q("forecast-separation")!.textContent).toContain("no fitness gain from planned training");
    expect(f.textContent).toContain("Weather and course conditions are unknown");
    expect(f.querySelectorAll('[data-testid="forecast-scenarios"] li').length).toBeGreaterThanOrEqual(4);
    expect(container.textContent).toContain("Rock and Roll Half Marathon");
    expect(q("race-day-forecast-summary")!.textContent).toMatch(/provisional · experimental/);
  });
});

describe("row components in isolation", () => {
  it("renders every hybrid status without throwing and never claims validation", () => {
    for (const o of [{}, { raceDate: null }, { raceDate: "2026-04-01" }, { raceDate: null, strong, longRunMiles: 3, easyMiles: 2.5, runsPerWeek: 2 as const }]) {
      const e = estimateHybridHalfMarathon(hybridAthlete({ longRunMiles: 8, ...o }));
      act(() => root.render(<HybridEstimateRow estimate={e} detailed />));
      const text = container.textContent!;
      expect(text).toContain("Experimental"); expect(text).not.toMatch(/validated (estimate|model)/i);
      expect(q("hybrid-estimate")!.getAttribute("data-status")).toBe(e.status);
    }
  });
  it("withheld forecast states the precise reason and never shows a number", () => {
    const f = estimateRaceDayForecast(hybridAthlete({ raceDate: null }), { raceDate: "2027-03-20", plan: PLAN });
    act(() => root.render(<RaceDayForecastRow forecast={f} />));
    expect(q("forecast-value")!.textContent).toBe("Withheld · not validated");
    expect(q("forecast-withheld-reason")!.textContent).toContain("Current capability is unavailable");
    expect(q("forecast-range")).toBeNull();
  });
});
