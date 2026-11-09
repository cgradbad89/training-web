import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { athleteV11, type AthleteV11Options } from "@/utils/__tests__/fixtures/hybridV11Fixture";
import { estimateCurrentHalfMarathon } from "@/utils/experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "@/utils/hrEnhancedPerformance";
import { estimateHybridHalfMarathon } from "@/utils/performance/hybridPerformance";
import { estimateHybridHalfMarathonV11 } from "@/utils/performance/hybridPerformanceV11";
import { estimateRaceDayForecast } from "@/utils/performance/raceDayForecast";
import { RacePerformancePanel, type RacePerformancePanelProps, type RacePerformanceSources } from "../RacePerformancePanel";
import { InsightsDialog } from "../EstimateDetailsDialog";

vi.mock("next/link", () => ({ default: ({ href, children }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href}>{children}</a> }));
vi.mock("@/utils/experimentalCurrentPerformance", async original => {
  const actual = await original<typeof import("@/utils/experimentalCurrentPerformance")>();
  return { ...actual, estimateCurrentHalfMarathon: vi.fn(actual.estimateCurrentHalfMarathon) };
});
vi.mock("@/utils/hrEnhancedPerformance", async original => {
  const actual = await original<typeof import("@/utils/hrEnhancedPerformance")>();
  return { ...actual, estimateHrEnhancedHalfMarathon: vi.fn(actual.estimateHrEnhancedHalfMarathon) };
});
vi.mock("@/utils/performance/hybridPerformance", async original => {
  const actual = await original<typeof import("@/utils/performance/hybridPerformance")>();
  return { ...actual, estimateHybridHalfMarathon: vi.fn(actual.estimateHybridHalfMarathon) };
});
vi.mock("@/utils/performance/hybridPerformanceV11", async original => {
  const actual = await original<typeof import("@/utils/performance/hybridPerformanceV11")>();
  return { ...actual, estimateHybridHalfMarathonV11: vi.fn(actual.estimateHybridHalfMarathonV11) };
});
vi.mock("@/utils/performance/raceDayForecast", async original => {
  const actual = await original<typeof import("@/utils/performance/raceDayForecast")>();
  return { ...actual, estimateRaceDayForecast: vi.fn(actual.estimateRaceDayForecast) };
});
const io = vi.hoisted(() => ({ getDoc: vi.fn(), getDocs: vi.fn(), onSnapshot: vi.fn(), setDoc: vi.fn(), updateDoc: vi.fn() }));
vi.mock("firebase/firestore", async original => ({ ...(await original<typeof import("firebase/firestore")>()), ...io }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ready = { hasLoaded: true, resolution: "success" as const };
const sources: RacePerformanceSources = { workouts: ready, overrides: ready, races: ready, plans: ready };
const models = [estimateCurrentHalfMarathon, estimateHrEnhancedHalfMarathon, estimateHybridHalfMarathon, estimateHybridHalfMarathonV11, estimateRaceDayForecast];
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); });
const q = <T extends Element = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
function mount(options: AthleteV11Options = {}, extra: Partial<RacePerformancePanelProps> = {}) {
  const a = athleteV11(options);
  act(() => root.render(<RacePerformancePanel {...a} selectedRace={null} plan={null} sources={sources} asOf={new Date(a.asOf)} {...extra} />));
  return a;
}
function openDetails() { act(() => q<HTMLButtonElement>("view-estimate-details")!.click()); }

describe("simplified performance estimates", () => {
  it("shows only Official v2 and Hybrid v1.1 as current estimates, with a separate future-date Forecast v2", () => {
    mount();
    const current = q("experimental-current-estimate")!;
    expect(current.closest("section")!.querySelector("h2")!.textContent).toBe("Current Half-Marathon Performance");
    expect(current.textContent).toContain("Official v2");
    expect(current.textContent).toContain("Hybrid Performance Model v1.1");
    expect(q("official-v2-estimate")).toBeTruthy(); expect(q("hybrid-v11-estimate")).toBeTruthy();
    expect(current.textContent).not.toMatch(/HR-enhanced|Previous hybrid v1|Legacy Hybrid v1/);
    expect(q("hr-enhanced-estimate")).toBeNull(); expect(q("hybrid-estimate")).toBeNull();
    const forecast = q("race-day-forecast")!;
    expect(current.contains(forecast)).toBe(false);
    expect(forecast.closest("section")!.querySelector("h2")!.textContent).toBe("Race-Day Forecast");
    expect(forecast.textContent).toContain("Forecast v2"); expect(forecast.textContent).toContain("2027-03-20");
    expect(forecast.closest("section")!.textContent).toContain("A future race-date prediction");
  });

  it("keeps both additional comparisons closed by default and resets them when the dialog is reopened", () => {
    mount(); expect(q("additional-model-comparisons")).toBeNull(); openDetails();
    let comparisons = q<HTMLDetailsElement>("additional-model-comparisons")!;
    expect(comparisons.open).toBe(false);
    expect(comparisons.querySelector("summary")!.textContent).toBe("Additional Model Comparisons");
    expect(comparisons.contains(q("hr-enhanced-estimate"))).toBe(true);
    expect(comparisons.contains(q("hybrid-estimate"))).toBe(true);
    act(() => comparisons.querySelector("summary")!.click()); expect(comparisons.open).toBe(true);
    expect(comparisons.textContent).toContain("Legacy Hybrid v1");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(q("estimate-details-dialog")).toBeNull(); expect(document.activeElement).toBe(q("view-estimate-details"));
    openDetails(); comparisons = q<HTMLDetailsElement>("additional-model-comparisons")!;
    expect(comparisons.open).toBe(false);
  });

  it("preserves all five complete model outputs and does no acquisition or model work when opening or expanding details", () => {
    const a = athleteV11();
    const official = estimateCurrentHalfMarathon(a);
    const hrEnhanced = estimateHrEnhancedHalfMarathon(a, { official });
    const hybrid = estimateHybridHalfMarathon(a, { official, hrEnhanced, targetDistanceMeters: 21097.5 });
    const options = { official, hrEnhanced, hybridV1: hybrid, targetDistanceMeters: 21097.5, strictMaximalOnly: false, vo2Load: "not_requested" as const, streamLoad: "not_requested" as const };
    const hybridV11 = estimateHybridHalfMarathonV11(a, options);
    const forecast = estimateRaceDayForecast(a, { ...options, raceDate: "2027-03-20", plan: null, hybrid: hybridV11 });
    vi.clearAllMocks(); mount();
    // Forecast readiness scenarios also invoke v1.1; its first result is today's capability.
    const results = models.map(model => vi.mocked(model).mock.results[0]!.value);
    expect(results).toEqual([official, hrEnhanced, hybrid, hybridV11, forecast]);
    const counts = models.map(model => vi.mocked(model).mock.calls.length);
    openDetails();
    act(() => q("additional-model-comparisons")!.querySelector("summary")!.click());
    act(() => q("hr-enhanced-details")!.querySelector("summary")!.click());
    expect(models.map(model => vi.mocked(model).mock.calls.length)).toEqual(counts);
    expect(models.map(model => vi.mocked(model).mock.results[0]!.value)).toEqual(results);
    for (const fn of Object.values(io)) expect(fn).not.toHaveBeenCalled();
  });

  it("retains unavailable reasons without creating an HR number or a forecast", () => {
    mount({ raceDate: "2026-04-01" });
    expect(q("official-v2-estimate")!.textContent).toContain("Insufficient evidence");
    expect(q("hybrid-v11-status")!.textContent).toBe("Unavailable");
    expect(q("hybrid-v11-value")!.textContent).toBe("Not available");
    expect(q("forecast-value")!.textContent).toBe("Withheld · not validated");
    openDetails(); expect(q("hr-enhanced-estimate")).toBeNull();
    expect(q("hybrid-estimate")!.getAttribute("data-status")).toBe("unavailable");
  });

  it("preserves provisional status, confidence, caveats and assumption range", () => {
    mount();
    expect(q("hybrid-v11-status")!.textContent).toBe("Provisional");
    expect(q("hybrid-v11-range")!.textContent).toMatch(/evidence quality low/);
    expect(q("hybrid-v11-range")!.textContent).toContain("not a statistical interval");
    expect(q("hybrid-v11-estimate")!.textContent).toContain("not independently validated");
  });

  it("does not calculate models while required sources are unread", () => {
    mount({}, { sources: { ...sources, workouts: { hasLoaded: false, resolution: "loading" } } });
    expect(container.textContent).toContain("Loading workouts");
    for (const model of models) expect(model).not.toHaveBeenCalled();
    expect(q("view-estimate-details")).toBeNull();
  });

  it("does not expose legacy v1 as a headline when the v1.1 rollback switch is active", () => {
    vi.stubEnv("NEXT_PUBLIC_DISABLE_HYBRID_V11", "true"); mount();
    expect(q("official-v2-estimate")).toBeTruthy(); expect(q("hybrid-v11-estimate")).toBeNull();
    expect(q("hybrid-estimate")).toBeNull();
    expect(q("race-day-forecast")!.textContent).toContain("Forecast v1");
    openDetails(); expect(q("additional-model-comparisons")!.contains(q("hybrid-estimate"))).toBe(true);
  });

  it("keeps nested comparison controls out of the modal tab order while their outer section is collapsed", () => {
    act(() => root.render(<InsightsDialog title="Estimate Details" testId="focus-check" onClose={() => {}}>
      <details><summary>Additional Model Comparisons</summary>
        <details><summary>How heart-rate evidence is used</summary><a href="/races">Hidden evidence link</a></details>
      </details>
    </InsightsDialog>));
    const dialog = q("focus-check-dialog")!;
    const outer = dialog.querySelector("summary")!;
    // Focus starts on the heading. Shift+Tab must wrap to the last visible control.
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
    expect(document.activeElement).toBe(outer);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(dialog.querySelector("button"));
  });
});
