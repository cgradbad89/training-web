import React, { act, useEffect } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDataResolution } from "@/contexts/AppDataContext";
import { RacePerformancePanel } from "@/components/insights/RacePerformancePanel";
import { RunImpactSection } from "@/components/runs/RunImpactSection";
import { computeCurrentHalfRunImpact } from "@/utils/currentHalfRunImpact";
import { currentFixture } from "@/utils/__tests__/fixtures/currentPerformanceFixture";
import { exclusionOverride, improvingNine } from "@/utils/__tests__/fixtures/currentImpactFixture";
import { estimateCurrentHalfMarathon } from "@/utils/experimentalCurrentPerformance";
import { useCurrentHalfRunImpact, type CurrentImpactCard } from "../useCurrentHalfRunImpact";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...rest}>{children}</a> }));
const app = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/contexts/AppDataContext", () => ({ useAppData: () => app.value }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fixture = ReturnType<typeof improvingNine>;
const loaded = { hasLoaded: true, resolution: "success" as AppDataResolution };
function publish(input: Fixture, patch: Record<string, unknown> = {}) {
  app.value = {
    workouts: input.workouts, races: input.races, overrides: input.overrides ?? {},
    sourceHasLoaded: { workouts: true, races: true, overrides: true, plans: true, settings: true },
    workoutsResolution: "success", racesResolution: "success", overridesResolution: "success", ...patch,
  };
}
let root: Root, container: HTMLDivElement;
const box: { current: CurrentImpactCard | null } = { current: null };
function Probe({ runId, enabled = true, input }: { runId: string; enabled?: boolean; input: Fixture }) {
  const card = useCurrentHalfRunImpact(runId, enabled, { asOf: new Date(input.asOf), timeZone: input.timeZone });
  useEffect(() => { box.current = card; });
  return null;
}
const mount = (input: Fixture, runId: string, enabled = true) =>
  act(() => root.render(<Probe runId={runId} enabled={enabled} input={input} />));
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); box.current = null; });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); });

describe("useCurrentHalfRunImpact", () => {
  it("is off (null) when the estimate is not enabled", () => {
    const input = improvingNine(); publish(input); mount(input, "cur-3-1", false);
    expect(box.current).toBeNull();
  });

  it("reports loading until every required source has loaded, never inferring absence", () => {
    const input = improvingNine();
    publish(input, { sourceHasLoaded: { workouts: true, races: false, overrides: true } }); mount(input, "cur-3-1");
    expect(box.current).toEqual({ state: "loading" });
  });

  it("reports a recoverable error naming the source that failed to load", () => {
    const input = improvingNine();
    publish(input, { sourceHasLoaded: { workouts: false, races: true, overrides: true }, workoutsResolution: "error" }); mount(input, "cur-3-1");
    expect(box.current).toMatchObject({ state: "error" });
    expect((box.current as { message: string }).message).toContain("workouts could not be loaded");
  });

  it("keeps showing previously loaded evidence, with a notice, when a background refresh fails", () => {
    const input = improvingNine(); publish(input, { overridesResolution: "error" }); mount(input, "cur-3-1");
    if (box.current?.state !== "ready") throw new Error(String(box.current?.state));
    expect(box.current.impact.kind).toBe("estimate"); expect(box.current.notice).toContain("workout overrides");
  });

  it("computes from the shared sources with the same result as the pure adapter", () => {
    const input = improvingNine(); publish(input); mount(input, "cur-3-1");
    if (box.current?.state !== "ready") throw new Error(String(box.current?.state));
    expect(box.current.impact).toEqual(computeCurrentHalfRunImpact({ ...input, runId: "cur-3-1" }));
    expect(box.current.notice).toBeNull();
  });

  it("never lets a result outlive the viewed run: navigating recomputes for the new run", () => {
    const input = improvingNine(); publish(input);
    mount(input, "cur-3-1");
    const first = (box.current as { impact: { deltaSeconds: number } }).impact.deltaSeconds;
    mount(input, "cur-2-0");
    const second = (box.current as { impact: { deltaSeconds: number } }).impact.deltaSeconds;
    expect(first).toBeCloseTo(-17.947, 2); expect(second).toBeCloseTo(-3.362, 2);
    mount(input, "provisional-half-run");
    expect((box.current as { impact: { kind: string } }).impact.kind).toBe("not_evidence");
  });

  it("recomputes when the shared sources are refreshed (new exclusion), not from a cached result", () => {
    const input = improvingNine(); publish(input); mount(input, "cur-3-1");
    expect((box.current as { impact: { kind: string } }).impact.kind).toBe("estimate");
    publish({ ...input, overrides: exclusionOverride("cur-3-1") }); mount(input, "cur-3-1");
    expect((box.current as { impact: { kind: string; runStatus?: string } }).impact).toMatchObject({ kind: "not_evidence", runStatus: "excluded" });
  });
});

describe("Run Detail / Plan Insights parity (shared fixture, identical evaluation time)", () => {
  it("renders the same current estimate in the Plan Insights panel and the Run Detail card", () => {
    vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
    const input = currentFixture(1.5, 4, 9) as Fixture; publish(input); mount(input, "base-0-0");
    const card = box.current as Extract<CurrentImpactCard, { state: "ready" }>;
    const panelHost = document.createElement("div"); document.body.appendChild(panelHost);
    const panelRoot = createRoot(panelHost);
    const ready = { workouts: loaded, overrides: loaded, races: loaded, plans: loaded };
    act(() => panelRoot.render(<RacePerformancePanel races={[...input.races]} workouts={[...input.workouts]} overrides={input.overrides ?? {}}
      plan={null} selectedRace={null} sources={ready} asOf={new Date(input.asOf)} timeZone={input.timeZone} />));
    const panelValue = panelHost.querySelector('[data-testid="estimate-values"] p')!.textContent!;
    act(() => root.render(<RunImpactSection prediction={null} ctl={null} currentEstimate={card} />));
    const cardValue = container.querySelector('[data-testid="impact-with"]')!.textContent;
    expect(cardValue).toBe(panelValue);
    expect(cardValue).toBe("~2:09");
    expect(estimateCurrentHalfMarathon(input).finishMinutes).toBe(129);
    act(() => panelRoot.unmount()); panelHost.remove();
  });
});

describe("boundaries", () => {
  const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  it("performs no Firestore or service access and imports no legacy prediction model", () => {
    for (const file of ["../useCurrentHalfRunImpact.ts", "../../utils/currentHalfRunImpact.ts"]) {
      const text = src(file);
      expect(text, file).not.toMatch(/from ["'](firebase|@\/lib\/firebase|@\/services\/|@google-cloud)/);
      expect(text, file).not.toMatch(/racePrediction|bestEffortExtraction|runImpact|riegelFit|predictRaceTime|computeRunImpact/);
    }
  });
  it("gives the Run Detail page the current-estimate card and disables the legacy prediction whenever it is enabled", () => {
    const page = src("../../app/(app)/runs/[id]/page.tsx");
    expect(page).toContain("useCurrentHalfRunImpact(");
    expect(page).toMatch(/if \(isRacePerformanceDisplayEnabled\(\)\) return null;/);
    expect(page).not.toContain("RACE_PERFORMANCE_UNAVAILABLE_REASON");
  });
});
