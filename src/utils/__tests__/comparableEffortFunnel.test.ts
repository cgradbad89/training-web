import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { ResearchRun } from "@/types/workoutRaceResearch";
import { buildComparableEffortFunnel, firstFailingPairGate, FUNNEL_VERSION } from "../comparableEffortFunnel";
import { estimateCurrentHalfMarathon } from "../experimentalCurrentPerformance";
import { pairResearchRuns } from "../workoutRaceResearch";
import { researchRace, researchRun } from "./fixtures/workoutRaceResearchFixture";

const AS_OF = "2026-10-10T16:00:00.000Z";
const run = (id: string, date: string, pace = 600, extra: Partial<HealthWorkout> = {}) => researchRun(id, date, pace, extra);
function fixture(opts: { recent?: Partial<HealthWorkout>; baseline?: Partial<HealthWorkout>; asOf?: string; withAnchor?: boolean } = {}) {
  const anchor = researchRace("anchor", "2026-08-30", 7871);
  const baselineDates = ["2026-07-10", "2026-07-17", "2026-07-24", "2026-08-02", "2026-08-09", "2026-08-16"];
  const recentDates = ["2026-09-17", "2026-09-19", "2026-09-25", "2026-09-27", "2026-10-02", "2026-10-04"];
  const workouts = [...(opts.withAnchor === false ? [] : [anchor.workout]),
    ...baselineDates.map((d, i) => run(`SECRET-base-${i}`, d, 600, opts.baseline)),
    ...recentDates.map((d, i) => run(`SECRET-recent-${i}`, d, 576, opts.recent))];
  return { races: opts.withAnchor === false ? [] : [anchor.race], workouts, overrides: {}, asOf: opts.asOf ?? AS_OF, timeZone: "America/New_York" };
}
const gate = (f: ReturnType<typeof buildComparableEffortFunnel>, name: string) => f.gates.find(g => g.gate === name)!;

describe("comparable-effort funnel: reconciliation with the live estimator", () => {
  it("reproduces the estimator's matched pairs, effective pairs and weighting", () => {
    const input = fixture(), estimate = estimateCurrentHalfMarathon(input), funnel = buildComparableEffortFunnel(input);
    expect(estimate.adjustmentMethod).toBe("matched_effort");
    expect(funnel.matchedPairs).toBe(estimate.diagnostics.matchedPairs);
    expect(funnel.matchedWeeks).toBe(estimate.diagnostics.matchedWeeks);
    expect(funnel.effectivePairs).toBeCloseTo(estimate.diagnostics.effectivePairs, 12);
    expect(funnel.paceWeight).toBe(1);
    expect(funnel.version).toBe(FUNNEL_VERSION);
  });

  it("reconciles every gate: candidates = previous survivors, excluded = candidates − surviving", () => {
    const f = buildComparableEffortFunnel(fixture({ recent: { avgHeartRate: null } }));
    for (const g of f.gates) expect(g.excluded).toBe(g.candidates - g.surviving);
    const names = f.gates.map(g => g.gate), start = names.indexOf("Valid HR");
    for (let i = start + 1; i < names.indexOf("One-to-one matching") + 1; i++) expect(f.gates[i].candidates).toBe(f.gates[i - 1].surviving);
    expect(gate(f, "Valid HR").candidates).toBe(6 * 6);
    expect(f.gates[names.indexOf("Steady 20–90 min")].surviving).toBe(12);
  });

  it("is deterministic and does not change the estimator's output", () => {
    const input = fixture(), before = JSON.stringify(estimateCurrentHalfMarathon(input));
    expect(buildComparableEffortFunnel(input)).toEqual(buildComparableEffortFunnel(input));
    expect(JSON.stringify(estimateCurrentHalfMarathon(input))).toBe(before);
  });
});

describe("comparable-effort funnel: each pairwise gate matches the live pairing rule", () => {
  const anchorDate = "2026-08-30", asOfDate = "2026-10-10";
  const asRun = (w: HealthWorkout, date: string): ResearchRun => ({ workout: w, date, paceSecondsPerMile: w.durationSeconds / w.distanceMiles, recordedType: "Run" });
  const baseline = run("b", "2026-08-20", 600), control = run("r", "2026-09-20", 576);
  const cases: [string, number, Partial<HealthWorkout>][] = [
    ["missing HR", 0, { avgHeartRate: null }],
    ["HR too different", 1, { avgHeartRate: 155 }],
    ["duration too different", 2, { durationSeconds: 3900 }],
    ["elapsed ≠ recorded duration", 3, { endDate: new Date(control.endDate.getTime() + 300_000) }],
    ["indoor", 4, { displayType: "Indoor Run" }],
    ["different route", 5, { routeClusterId: "elsewhere" }],
    ["different terrain", 6, { elevationGainM: 200 }],
    ["no weather", 7, { weather: null }],
    ["weather differs", 8, { weather: { ...control.weather!, tempF: 80 } }],
    ["different conditions", 9, { weather: { ...control.weather!, conditionCode: 3 } }],
  ];
  const livePairs = (r: HealthWorkout) => pairResearchRuns([asRun(baseline, "2026-08-20"), asRun(r, "2026-09-20")], anchorDate, asOfDate, AS_OF, new Set(), 35).pairs.length;

  it("a matching pair passes every gate and is paired by the live function", () => {
    expect(firstFailingPairGate(baseline, control, AS_OF)).toBe(-1);
    expect(livePairs(control)).toBe(1);
  });
  it.each(cases)("%s fails gate %i, and the live function also rejects it", (_name, index, patch) => {
    const recent = { ...control, ...patch };
    expect(firstFailingPairGate(baseline, recent, AS_OF)).toBe(index);
    expect(livePairs(recent)).toBe(0);
  });
});

describe("comparable-effort funnel: attribution and boundaries", () => {
  it("attributes missing HR to missing data, not mismatch, and names the binding gate", () => {
    const f = buildComparableEffortFunnel(fixture({ recent: { avgHeartRate: null } }));
    expect(gate(f, "Valid HR")).toMatchObject({ surviving: 0, excluded: 36, missingData: 36 });
    expect(f.matchedPairs).toBe(0);
    expect(f.marginal.find(m => m.gate === "Valid HR")!.passes).toBe(0);
    expect(f.marginal.find(m => m.gate === "Same route")!.passes).toBe(36);
    expect(f.verdict).toContain("does not contribute");
  });
  it("separates a mismatch from missing data (HR present but different)", () => {
    const f = buildComparableEffortFunnel(fixture({ recent: { avgHeartRate: 160 } }));
    expect(gate(f, "HR match")).toMatchObject({ excluded: 36, missingData: 0 });
  });
  it("reports the weather gate when weather is absent", () => {
    const f = buildComparableEffortFunnel(fixture({ recent: { weather: null } }));
    expect(gate(f, "Weather available")).toMatchObject({ surviving: 0, missingData: 36 });
  });
  it("stops cleanly with an explanation when there is no race anchor", () => {
    const f = buildComparableEffortFunnel(fixture({ withAnchor: false }));
    expect(f.anchorDate).toBeNull(); expect(f.gates).toHaveLength(1); expect(f.verdict).toContain("No race anchor");
  });
  it("stops cleanly when the anchor has expired", () => {
    const f = buildComparableEffortFunnel(fixture({ asOf: "2027-03-20T16:00:00.000Z" }));
    expect(f.anchorExpired).toBe(true); expect(f.verdict).toContain("180 days");
  });
  it("lets the one-to-one rule and the final confidence gate explain thin evidence", () => {
    const f = buildComparableEffortFunnel(fixture({ asOf: "2026-09-21T16:00:00.000Z" }));
    expect(gate(f, "Final confidence").surviving).toBe(0);
    expect(f.verdict).toContain("does not contribute");
  });
  it("publishes counts and rules only: no workout ids or race names", () => {
    const text = JSON.stringify(buildComparableEffortFunnel(fixture()));
    expect(text).not.toContain("SECRET"); expect(text).not.toContain("Synthetic");
  });
});

describe("research isolation", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === "__tests__" ? [] : walk(path)) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
  it("is not imported by any live source module", () => {
    const root = join(__dirname, "..", "..");
    const importers = walk(root).filter(f => !f.endsWith("comparableEffortFunnel.ts") && readFileSync(f, "utf8").includes("comparableEffortFunnel"));
    expect(importers).toEqual([]);
  });
  it("performs no database access", () => {
    const text = readFileSync(join(__dirname, "..", "comparableEffortFunnel.ts"), "utf8");
    expect(text).not.toMatch(/from ["'](firebase|@\/lib\/firebase|@\/services\/|@google-cloud)/);
  });
});
