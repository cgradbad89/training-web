import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDataResolution } from "@/contexts/AppDataContext";
import { RacePerformancePanel, type RacePerformanceSources } from "@/components/insights/RacePerformancePanel";
import { RunImpactSection } from "@/components/runs/RunImpactSection";
import { estimateCurrentHalfMarathon } from "@/utils/experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "@/utils/hrEnhancedPerformance";
import { hrScenario } from "@/utils/__tests__/fixtures/hrEnhancedFixture";
import { useHrEnhancedRunImpact, type HrImpactCard } from "../useHrEnhancedRunImpact";
import { useCurrentHalfRunImpact, type CurrentImpactCard } from "../useCurrentHalfRunImpact";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...rest}>{children}</a> }));
const app = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => app.value }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Scenario = ReturnType<typeof hrScenario>;
const ready = { hasLoaded: true, resolution: "success" as AppDataResolution };
const sources: RacePerformanceSources = { workouts: ready, overrides: ready, races: ready, plans: ready };
let root: Root, container: HTMLDivElement;
const hrBox: { current: HrImpactCard | null } = { current: null };
const offBox: { current: CurrentImpactCard | null } = { current: null };
const label = (m: number) => `~${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

function publish(s: Scenario) {
  app.value = { workouts: s.input.workouts, races: s.input.races, overrides: s.input.overrides,
    sourceHasLoaded: { workouts: true, races: true, overrides: true, plans: true, settings: true },
    workoutsResolution: "success", racesResolution: "success", overridesResolution: "success" };
}
function Probe({ s, runId, enabled = true }: { s: Scenario; runId: string; enabled?: boolean }) {
  const opts = { asOf: new Date(s.input.asOf), timeZone: s.input.timeZone };
  const hr = useHrEnhancedRunImpact(runId, enabled, opts), off = useCurrentHalfRunImpact(runId, true, opts);
  useEffect(() => { hrBox.current = hr; offBox.current = off; });
  return null;
}
function panel(s: Scenario) {
  act(() => root.render(<RacePerformancePanel races={[...s.input.races]} workouts={[...s.input.workouts]} overrides={{}} plan={null}
    selectedRace={null} sources={sources} asOf={new Date(s.input.asOf)} timeZone={s.input.timeZone} />));
}
const row = () => container.querySelector('[data-testid="hr-enhanced-estimate"]');
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); hrBox.current = null; offBox.current = null;
  vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production"); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); });

describe("Plan Insights HR-enhanced row", () => {
  it("shows the official estimate as primary and the experimental estimate beside it, with the same numbers as the estimator", () => {
    const s = hrScenario({ recentLevel: 0.92 });
    panel(s);
    const official = estimateCurrentHalfMarathon(s.input), hr = estimateHrEnhancedHalfMarathon(s.input, { official });
    const card = container.querySelector('[data-testid="experimental-current-estimate"]')!;
    expect(card.querySelector('[data-testid="estimate-values"]')!.textContent).toContain(label(official.finishMinutes!));
    expect(hr.status).toBe("available");
    expect(row()!.getAttribute("data-status")).toBe("available");
    expect(row()!.textContent).toContain("Experimental");
    expect(row()!.querySelector('[data-testid="hr-enhanced-value"]')!.textContent).toContain(label(hr.candidateMinutes!));
    expect(row()!.querySelector('[data-testid="hr-enhanced-difference"]')!.textContent).toMatch(/faster than the official estimate/);
    expect(row()!.textContent).toMatch(/improved by roughly/);
    expect(row()!.textContent).toMatch(/not independently validated/i);
    // The row sits inside the same card, after the official values.
    expect(card.contains(row())).toBe(true);
  });

  it("explains the evidence behind the signal: runs, weeks, windows", () => {
    const s = hrScenario({ recentLevel: 0.92 });
    panel(s);
    const hr = estimateHrEnhancedHalfMarathon(s.input);
    expect(row()!.querySelector('[data-testid="hr-enhanced-support"]')!.textContent)
      .toContain(`${hr.supportingRuns.baseline} before the anchor (${hr.observationWeeks.baseline} weeks) and ${hr.supportingRuns.recent} recent`);
    expect(row()!.querySelector('[data-testid="hr-enhanced-window"]')!.textContent).toContain("before the anchor");
  });

  it("an unfavourable signal is shown as slower, never hidden", () => {
    const s = hrScenario({ recentLevel: 1.1 });
    panel(s);
    expect(row()!.querySelector('[data-testid="hr-enhanced-difference"]')!.textContent).toMatch(/slower than the official estimate/);
    expect(row()!.textContent).toMatch(/slowed by roughly/);
  });

  it("no detectable change keeps the official number and says so", () => {
    const s = hrScenario({});
    panel(s);
    expect(row()!.getAttribute("data-status")).toBe("no_change");
    expect(row()!.querySelector('[data-testid="hr-enhanced-difference"]')!.textContent).toBe("same as the official estimate");
  });

  it("insufficient HR evidence: official stays visible and the row explains why the experiment is unavailable", () => {
    const s = hrScenario({ mutate: x => ({ ...x, hr: null }) });
    panel(s);
    expect(row()!.getAttribute("data-status")).toBe("unavailable");
    expect(row()!.querySelector('[data-testid="hr-enhanced-value"]')!.textContent).toBe("Not available");
    expect(row()!.querySelector('[data-testid="hr-enhanced-reason"]')!.textContent).toMatch(/valid average heart rate/);
    expect(container.querySelector('[data-testid="estimate-values"]')).not.toBeNull();
  });

  it("is absent when the official estimate is unavailable (no invented comparison)", () => {
    const s = hrScenario({});
    act(() => root.render(<RacePerformancePanel races={[]} workouts={[...s.input.workouts]} overrides={{}} plan={null} selectedRace={null}
      sources={sources} asOf={new Date(s.input.asOf)} timeZone={s.input.timeZone} />));
    expect(row()).toBeNull();
    expect(container.textContent).toContain("Insufficient evidence");
  });

  it("the kill switch removes the experimental row but leaves the official estimate byte-identical", () => {
    const s = hrScenario({ recentLevel: 0.92 });
    panel(s);
    const withRow = container.querySelector('[data-testid="estimate-values"]')!.textContent;
    expect(row()).not.toBeNull();
    vi.stubEnv("NEXT_PUBLIC_DISABLE_HR_ENHANCED_ESTIMATE", "true");
    panel(s);
    expect(row()).toBeNull();
    expect(container.querySelector('[data-testid="estimate-values"]')!.textContent).toBe(withRow);
    expect(container.textContent).not.toContain("HR-enhanced");
  });

  it("the details dialog carries the experimental methodology and assumptions", () => {
    const s = hrScenario({ recentLevel: 0.92 });
    panel(s);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="view-estimate-details"]')!.click());
    const dialog = document.querySelector<HTMLElement>('[data-testid="estimate-details-dialog"]')!;
    const m = dialog.querySelector('[data-testid="hr-enhanced-methodology"]')!;
    expect(m.textContent).toContain("experimental-hr-enhanced-hm-v1");
    expect(m.textContent).toMatch(/at most 1\.5%/);
    expect(m.textContent).toMatch(/Same average HR is not proof of equal effort/);
  });
});

describe("Run Detail parity and separation", () => {
  it("the with-run value equals the Plan Insights HR-enhanced headline; the official tile is untouched", () => {
    const s = hrScenario({ recentLevel: 0.92 }); publish(s);
    act(() => root.render(<Probe s={s} runId="r3" />));
    const hr = estimateHrEnhancedHalfMarathon(s.input);
    expect(hrBox.current).toMatchObject({ state: "ready" });
    const impact = (hrBox.current as Extract<HrImpactCard, { state: "ready" }>).impact;
    expect(impact.kind).toBe("estimate");
    act(() => root.render(<RunImpactSection prediction={null} ctl={null} currentEstimate={offBox.current} hrEnhancedEstimate={hrBox.current} />));
    expect(container.querySelector('[data-testid="hr-impact-with"]')!.textContent).toBe(label(hr.candidateMinutes!));
    expect(container.querySelector('[data-testid="current-estimate-impact"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="hr-enhanced-impact"]')!.textContent).toContain("Experimental");
    expect(container.querySelector('[data-testid="hr-enhanced-impact"]')!.textContent).toContain("official estimate above is unaffected");
    // Two distinct tiles: the official one never shows the HR number.
    expect(container.querySelector('[data-testid="current-estimate-impact"]')!.textContent).not.toContain("HR-enhanced");
  });

  it("is off (null) when disabled and renders nothing extra", () => {
    const s = hrScenario({ recentLevel: 0.92 }); publish(s);
    act(() => root.render(<Probe s={s} runId="r3" enabled={false} />));
    expect(hrBox.current).toBeNull();
    act(() => root.render(<RunImpactSection prediction={null} ctl={null} currentEstimate={offBox.current} hrEnhancedEstimate={null} />));
    expect(container.querySelector('[data-testid="hr-enhanced-impact"]')).toBeNull();
  });

  it("reports loading until sources are loaded and renders honest unavailable / not-evidence states", () => {
    const s = hrScenario({ recentLevel: 0.92 });
    app.value = { workouts: s.input.workouts, races: s.input.races, overrides: {}, sourceHasLoaded: { workouts: true, races: false, overrides: true },
      workoutsResolution: "success", racesResolution: "success", overridesResolution: "success" };
    act(() => root.render(<Probe s={s} runId="r3" />));
    expect(hrBox.current).toEqual({ state: "loading" });
    publish(s);
    act(() => root.render(<Probe s={s} runId="anchor-run" />));
    act(() => root.render(<RunImpactSection prediction={null} ctl={null} currentEstimate={offBox.current} hrEnhancedEstimate={hrBox.current} />));
    expect(container.querySelector('[data-testid="hr-impact-state"]')!.textContent).toBe("Not a training input");
    const noHr = hrScenario({ mutate: x => ({ ...x, hr: null }) }); publish(noHr);
    act(() => root.render(<Probe s={noHr} runId="r3" />));
    act(() => root.render(<RunImpactSection prediction={null} ctl={null} currentEstimate={offBox.current} hrEnhancedEstimate={hrBox.current} />));
    expect(container.querySelector('[data-testid="hr-impact-state"]')!.textContent).toBe("Not available");
  });
});
