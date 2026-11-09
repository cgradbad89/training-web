import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEPTEMBER_RACE, fitnessWorld, strongEffortWorld } from "../../../utils/__tests__/fixtures/currentFitnessFixture";
import { computeCurrentFitness } from "../../../utils/performance/hybridCurrentFitness";
import { CurrentFitnessEstimates, CurrentFitnessTable, CURRENT_FITNESS_TITLE } from "../CurrentFitnessTable";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement, root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); });
const mount = (node: React.ReactElement) => act(() => root.render(node));
const q = (id: string) => container.querySelector(`[data-testid='${id}']`)!;
const text = (id: string) => q(id).textContent!.replace(/\s+/g, " ").trim();
const D = "2026-10-30";
const world = (o: Partial<Parameters<typeof fitnessWorld>[0]> = {}) => fitnessWorld({ asOfDate: D, races: [SEPTEMBER_RACE()], ...o });
const fit = (o: Partial<Parameters<typeof fitnessWorld>[0]> = {}) => computeCurrentFitness({ ...world(o), assumeConfirmedRacesMaximal: false });

describe("CurrentFitnessTable (presentational)", () => {
  it("renders ONE table with the four distances in the specified order and the specified columns", () => {
    mount(<CurrentFitnessTable fitness={fit()} />);
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect([...container.querySelectorAll("thead th")].map(th => th.textContent)).toEqual(["Distance", "Predicted time", "Pace/mile", "Evidence quality"]);
    expect([...container.querySelectorAll("tbody tr[data-testid^='current-fitness-row-']")].map(tr => tr.getAttribute("data-testid"))).toEqual(
      ["current-fitness-row-5k", "current-fitness-row-10mi", "current-fitness-row-half", "current-fitness-row-marathon"]);
    expect([...container.querySelectorAll("tbody th")].map(th => th.textContent)).toEqual(["5K", "10 miles", "Half marathon", "Marathon"]);
  });
  it("shows model output: time, pace per mile and confidence for each available row", () => {
    mount(<CurrentFitnessTable fitness={fit()} />);
    expect([text("current-fitness-time-5k"), text("current-fitness-pace-5k")]).toEqual(["28:30", "9:10"]);
    expect([text("current-fitness-time-10mi"), text("current-fitness-pace-10mi")]).toEqual(["1:38:30", "9:50"]);
    expect([text("current-fitness-time-half"), text("current-fitness-pace-half"), text("current-fitness-confidence-half")]).toEqual(["2:11:00", "10:00", "Moderate"]);
    expect(text("current-fitness-confidence-5k")).toBe("Low");
  });
  it("labels the estimator, shows an as-of date, and says it is current fitness and not a race-day forecast", () => {
    mount(<CurrentFitnessTable fitness={fit()} />);
    expect(container.textContent).toContain(CURRENT_FITNESS_TITLE);
    expect(CURRENT_FITNESS_TITLE).toBe("Experimental — Hybrid Performance Model v1.1");
    expect(text("current-fitness-asof")).toBe("Current fitness as of Oct 30, 2026 — what you could reasonably race today, not a race-day forecast. Evidence quality reflects model rules, not a calibrated probability.");
  });
  it("shows simultaneous real restrictions without inventing a conflict", () => {
    const fitness = fit({ asOfDate: "2026-11-10" });
    const row = fitness.rows.find(r => r.id === "5k")!;
    expect(row.estimate.confidenceRestrictions).toEqual(expect.arrayContaining(["race_age", "distant_evidence", "limited_precision"]));
    mount(<CurrentFitnessTable fitness={fitness} />);
    const note = text("current-fitness-note-5k");
    expect(note).toContain("over 42 days old");
    expect(note).toContain("converted from a distant race distance");
    expect(note).toContain("not precise enough");
    expect(note).not.toMatch(/conflict|disagree/);
  });
  it("explains low evidence quality even when status remains available", () => {
    const fitness = computeCurrentFitness(world(), { readinessOverride: 0.1 });
    const row = fitness.rows.find(r => r.id === "half")!;
    expect(row.status).toBe("available");
    expect(row.confidence).toBe("low");
    mount(<CurrentFitnessTable fitness={fitness} />);
    expect(text("current-fitness-note-half")).toContain("Endurance readiness is below the Moderate threshold.");
    expect(text("current-fitness-note-half")).not.toMatch(/conflict|disagree/);
  });
  it("shows an unavailable row as an explicit insufficient-evidence state with a reason — never a number", () => {
    mount(<CurrentFitnessTable fitness={fit()} />);
    const marathon = q("current-fitness-row-marathon");
    expect(marathon.getAttribute("data-status")).toBe("unavailable");
    expect(text("current-fitness-time-marathon")).toBe("—"); expect(text("current-fitness-pace-marathon")).toBe("—");
    expect(text("current-fitness-confidence-marathon")).toBe("Insufficient evidence");
    expect(text("current-fitness-note-marathon")).toMatch(/Needs recent long runs/);
  });
  it("shows a provisional row with its number AND a visible provisional note", () => {
    mount(<CurrentFitnessTable fitness={fit()} />);
    expect(q("current-fitness-row-5k").getAttribute("data-status")).toBe("provisional");
    expect(text("current-fitness-note-5k")).toBe("Evidence is not precise enough for Moderate. Much of the estimate is converted from a distant race distance.");
    expect(text("current-fitness-time-5k")).toBe("28:30");
    expect(container.querySelector("[data-testid='current-fitness-note-half']")).toBeNull();   // a clean row carries no note
  });
  it("a world with no evidence renders four explicit unavailable rows", () => {
    mount(<CurrentFitnessTable fitness={fit({ races: [] })} />);
    for (const id of ["5k", "10mi", "half", "marathon"]) { expect(q(`current-fitness-row-${id}`).getAttribute("data-status")).toBe("unavailable"); expect(text(`current-fitness-note-${id}`)).toBe("No qualifying race or strong effort yet."); }
  });
  it("is responsive: the table scrolls inside its own wrapper instead of overflowing the page, at desktop and mobile widths", () => {
    for (const width of [1280, 375]) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      act(() => window.dispatchEvent(new Event("resize")));
      mount(<CurrentFitnessTable fitness={fit()} />);
      const wrapper = container.querySelector("table")!.parentElement!;
      expect(wrapper.className).toContain("overflow-x-auto");
      expect(container.querySelector("table")!.className).toContain("w-full");
      expect(container.querySelectorAll("tbody tr[data-testid^='current-fitness-row-']")).toHaveLength(4);
      // figures never wrap; notes live on their own full-width line, so a 375 px viewport neither squeezes the Distance column nor widens the page
      expect([...container.querySelectorAll("tbody td[colspan='4']")].every(td => td.getAttribute("colspan") === "4")).toBe(true);
      for (const id of ["5k", "10mi", "half", "marathon"]) expect(q(`current-fitness-time-${id}`).className).toContain("whitespace-nowrap");
    }
  });
  it("has an accessible caption and row/column header scopes", () => {
    mount(<CurrentFitnessTable fitness={fit()} />);
    expect(container.querySelector("caption")!.textContent).toMatch(/5K, 10 miles, half marathon and marathon/);
    expect(container.querySelectorAll("thead th[scope='col']")).toHaveLength(4);
    expect(container.querySelectorAll("tbody th[scope='row']")).toHaveLength(4);
  });
});

describe("CurrentFitnessEstimates (container)", () => {
  // The container is only mounted where the hybrid estimate is enabled (Production release gate or Preview opt-in).
  beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_RACE_PERFORMANCE_DEPLOYMENT_ENV", "production"); });
  const props = (o: Partial<React.ComponentProps<typeof CurrentFitnessEstimates>> = {}) => {
    const w = world({ adapted: false });   // the app hands STORED races to the component; it applies the shared adapter itself
    return { races: w.races, workouts: w.workouts, overrides: w.overrides, sources: { workouts: true, overrides: true, races: true }, asOf: new Date(w.asOf), timeZone: "America/New_York", ...o };
  };
  it("shows a loading state (no numbers) until the race, workout and override sources have all loaded", () => {
    for (const missing of ["workouts", "overrides", "races"] as const) {
      mount(<CurrentFitnessEstimates {...props({ sources: { workouts: true, overrides: true, races: true, [missing]: false } })} />);
      expect(container.querySelector("[data-testid='current-fitness-loading']")).not.toBeNull();
      expect(container.querySelector("[data-testid='current-fitness-table']")).toBeNull();
    }
  });
  it("computes the four distances from the loaded shared data once ready", () => {
    mount(<CurrentFitnessEstimates {...props()} />);
    expect(container.querySelectorAll("[data-testid^='current-fitness-row-']")).toHaveLength(4);
    expect(text("current-fitness-time-half")).toMatch(/^2:1\d:\d\d$/);
  });
  it("applies the owner-approved prediction assumption by default and the rollback switch removes it", () => {
    mount(<CurrentFitnessEstimates {...props()} />);
    expect(text("current-fitness-time-half")).toBe("2:11:00");
    vi.stubEnv("NEXT_PUBLIC_DISABLE_CONFIRMED_RACE_MAXIMAL_ASSUMPTION", "true");
    mount(<CurrentFitnessEstimates {...props()} />);
    // rollback: the confirmed `hard` race is the labelled demonstrated-race fallback (provisional, low) but still shown
    expect(q("current-fitness-row-half").getAttribute("data-status")).toBe("provisional");
  });
  it("says so while physiology evidence is still loading, and still shows the estimates", () => {
    const physiology = { vo2: { state: "loading" as const, entries: undefined, docsRead: 0 }, streams: { state: "loading" as const, summaries: undefined, report: null, eligible: 0, withStream: 0 } };
    mount(<CurrentFitnessEstimates {...props({ physiology })} />);
    expect(container.querySelector("[data-testid='current-fitness-physiology-loading']")).not.toBeNull();
    expect(container.querySelectorAll("[data-testid^='current-fitness-row-']")).toHaveLength(4);
  });
  it("recomputes when the loaded workouts change: new strong evidence moves the 5K, identical inputs do not", () => {
    mount(<CurrentFitnessEstimates {...props()} />);
    const before = text("current-fitness-time-5k");
    mount(<CurrentFitnessEstimates {...props()} />);
    expect(text("current-fitness-time-5k")).toBe(before);   // deterministic
    const strong = strongEffortWorld(D, 520);
    mount(<CurrentFitnessEstimates {...props({ races: strong.races, workouts: strong.workouts })} />);
    expect(text("current-fitness-time-5k")).not.toBe(before);
  });
});
