import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningPlan } from "@/types/plan";
import { HYBRID_AS_OF } from "@/utils/__tests__/fixtures/hybridFixture";
import { confirmedRaceFixture } from "@/utils/__tests__/fixtures/raceConfirmationFixture";
import { cadenceRuns } from "@/utils/__tests__/fixtures/policyStudyFixture";
import { isDemonstratedRaceEvidenceEnabled } from "@/lib/racePerformanceGate";
import { RacePerformancePanel, type RacePerformanceSources } from "../RacePerformancePanel";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...rest}>{children}</a> }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ready = { hasLoaded: true, resolution: "success" as const };
const sources: RacePerformanceSources = { workouts: ready, overrides: ready, races: ready, plans: ready };
const PLAN: RunningPlan = { id: "p", name: "Spring HM", startDate: "2026-11-09", status: "active", isActive: true, createdAt: "x", updatedAt: "x",
  weeks: Array.from({ length: 19 }, (_, w) => ({ weekNumber: w + 1, entries: [
    { id: `t${w}`, weekIndex: w, weekday: 2, dayOfWeek: 1, distanceMiles: 4 }, { id: `s${w}`, weekIndex: w, weekday: 6, dayOfWeek: 5, distanceMiles: Math.min(12, 8 + w * 0.3) }] })) };

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(HYBRID_AS_OF));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const inDialog = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const openDetails = () => { const b = Array.from(container.querySelectorAll("button")).find(x => /Estimate Details/.test(x.textContent ?? "")); expect(b, "details button").toBeTruthy(); act(() => b!.click()); };
function mountWithHardRace() {
  const f = confirmedRaceFixture({ id: "sep", date: "2026-09-20", seconds: 7871 });
  f.revision.details.effort = "hard"; f.workout.avgHeartRate = 168; f.workout.hasRoute = true;
  const workouts = [...cadenceRuns({ start: "2025-08-04", end: "2026-11-06", gaps: [2, 2, 3], miles: [5, 6, 5, 8] }), f.workout];
  act(() => root.render(<RacePerformancePanel races={[f.race]} workouts={workouts} overrides={{}} plan={PLAN} selectedRace={null} sources={sources}
    asOf={new Date(HYBRID_AS_OF)} timeZone="America/New_York" />));
}

describe("demonstrated-race policy in the Plan Insights panel (estimator-level maximal assumption switched off)", () => {
  beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_DISABLE_CONFIRMED_RACE_MAXIMAL_ASSUMPTION", "true"); });
  it("labels a demonstrated-only number and withholds the race-day forecast with its own cause", () => {
    mountWithHardRace();
    expect(q("hybrid-v11-estimate")?.getAttribute("data-status")).toBe("provisional");
    expect(q("hybrid-v11-demonstrated")?.textContent).toMatch(/Demonstrated performance, not a maximal-performance prediction/);
    expect(q("hybrid-v11-demonstrated")?.textContent).toMatch(/not run at maximal effort/);
    expect(q("race-day-forecast")?.getAttribute("data-status")).toBe("withheld");
    expect(q("forecast-withheld-reason")?.textContent).toMatch(/not projected forward/);
  });
  it("the demonstrated-policy kill switch restores the strict v1.1 behaviour exactly: no label, no number", () => {
    vi.stubEnv("NEXT_PUBLIC_DISABLE_DEMONSTRATED_RACE_EVIDENCE", "true");
    expect(isDemonstratedRaceEvidenceEnabled()).toBe(false);
    mountWithHardRace();
    expect(q("hybrid-v11-demonstrated")).toBeNull();
    expect(q("hybrid-v11-estimate")?.getAttribute("data-status")).toBe("unavailable");
  });
  it("the gate follows the hybrid v1.1 gate and only the exact string 'true' disables it", () => {
    expect(isDemonstratedRaceEvidenceEnabled()).toBe(true);
    for (const v of ["false", "1", "TRUE", ""]) { vi.stubEnv("NEXT_PUBLIC_DISABLE_DEMONSTRATED_RACE_EVIDENCE", v); expect(isDemonstratedRaceEvidenceEnabled()).toBe(true); }
    vi.stubEnv("NEXT_PUBLIC_DISABLE_HYBRID_V11", "true");
    expect(isDemonstratedRaceEvidenceEnabled()).toBe(false);
  });
});

describe("owner-approved assumption: confirmed hard/nonmaximal races anchor the estimators as maximal (default)", () => {
  it("uses the ordinary path: no demonstrated label, a number, and an available race-day forecast, with the one explanatory line", () => {
    mountWithHardRace();
    expect(q("hybrid-v11-demonstrated")).toBeNull();
    expect(q("hybrid-v11-estimate")?.getAttribute("data-status")).not.toBe("unavailable");
    expect(q("race-day-forecast")?.getAttribute("data-status")).toBe("provisional");
    openDetails();
    expect(inDialog("confirmed-effort-assumption")?.textContent).toBe("Confirmed race efforts are treated as maximal for prediction purposes.");
  });
  it("the rollback switch removes the line and returns to the labelled demonstrated-race behaviour", () => {
    vi.stubEnv("NEXT_PUBLIC_DISABLE_CONFIRMED_RACE_MAXIMAL_ASSUMPTION", "true");
    mountWithHardRace();
    openDetails();
    expect(inDialog("confirmed-effort-assumption")).toBeNull();
    expect(q("hybrid-v11-demonstrated")).toBeTruthy();
  });
});
