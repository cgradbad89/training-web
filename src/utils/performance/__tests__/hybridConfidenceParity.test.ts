import { describe, expect, it } from "vitest";
import { computeCurrentFitness } from "../hybridCurrentFitness";
import { estimateHybridHalfMarathonV11, HYBRID_V11_POLICY } from "../hybridPerformanceV11";
import { estimateRaceDayForecast } from "../raceDayForecast";
import { estimateCurrentHalfMarathon } from "@/utils/experimentalCurrentPerformance";
import { estimateHrEnhancedHalfMarathon } from "@/utils/hrEnhancedPerformance";
import { APRIL_RACE, SEPTEMBER_RACE, fitnessWorld, strongEffortWorld } from "@/utils/__tests__/fixtures/currentFitnessFixture";
import { athleteV11 } from "@/utils/__tests__/fixtures/hybridV11Fixture";
import { COMBINATION_POLICY } from "../evidenceCombination";
import { READINESS_POLICY } from "../enduranceReadiness";
import type { HybridV11Options } from "../hybridPerformanceV11";
import type { HybridV11Estimate } from "@/types/hybridPerformanceV11";
import type { RunningPlan } from "@/types/plan";
import golden from "./fixtures/hybridConfidenceParity.json";

const plan: RunningPlan = { id: "synthetic-plan", name: "Synthetic spring plan", startDate: "2026-11-09", status: "active", isActive: true,
  createdAt: "synthetic", updatedAt: "synthetic", weeks: Array.from({ length: 19 }, (_, w) => ({ weekNumber: w + 1, entries: [
    { id: `t${w}`, weekIndex: w, weekday: 2, dayOfWeek: 1, distanceMiles: 4 },
    { id: `s${w}`, weekIndex: w, weekday: 6, dayOfWeek: 5, distanceMiles: Math.min(12, 8 + w * 0.3) },
  ] })) };
const prepared = () => fitnessWorld({ asOfDate: "2026-10-30", races: [APRIL_RACE(), SEPTEMBER_RACE()], gaps: [1, 2, 2, 2], miles: [8, 8, 10, 20, 7, 8] });
const cases = {
  ordinary: () => ({ input: fitnessWorld({ asOfDate: "2026-11-10", races: [APRIL_RACE(), SEPTEMBER_RACE()] }) }),
  prepared: () => ({ input: prepared() }),
  recentEfforts: () => ({ input: strongEffortWorld() }),
  conflict: () => ({ input: athleteV11({ raceDate: "2026-07-30", paceChangeFrom: "2026-09-10", paceFactorAfter: 1.05,
    strong: [{ date: "2026-10-02", miles: 6, pace: 548, hr: 172 }, { date: "2026-10-16", miles: 7, pace: 552, hr: 172 }, { date: "2026-10-28", miles: 6, pace: 546, hr: 172 }] }) }),
  noRace: () => ({ input: fitnessWorld({ asOfDate: "2026-11-10" }) }),
  readinessBelow: () => ({ input: prepared(), options: { readinessOverride: 0.499999 } }),
  readinessAt: () => ({ input: prepared(), options: { readinessOverride: 0.5 } }),
  readinessAbove: () => ({ input: prepared(), options: { readinessOverride: 0.500001 } }),
  race42: () => ({ input: fitnessWorld({ asOfDate: "2026-11-01", races: [SEPTEMBER_RACE()] }) }),
  race43: () => ({ input: fitnessWorld({ asOfDate: "2026-11-02", races: [SEPTEMBER_RACE()] }) }),
  race180: () => ({ input: fitnessWorld({ asOfDate: "2027-03-19", races: [SEPTEMBER_RACE()] }) }),
  race181: () => ({ input: fitnessWorld({ asOfDate: "2027-03-20", races: [SEPTEMBER_RACE()] }) }),
};
function estimateContract(e: HybridV11Estimate) {
  return [e.seconds, e.minutes, e.paceSecondsPerMile, e.status, e.confidence, e.evidenceQuality, e.unavailableCause,
    e.adjustmentFraction, e.combination.exponent, e.combination.uncertaintyFraction, e.combination.raceShare,
    e.readiness?.score ?? null, e.sensitivityRange?.fastSeconds ?? null, e.sensitivityRange?.slowSeconds ?? null];
}
function contract(input: ReturnType<typeof prepared>, options: HybridV11Options = {}) {
  const official = estimateCurrentHalfMarathon(input), hr = estimateHrEnhancedHalfMarathon(input, { official });
  const opts = { ...options, official, hrEnhanced: hr };
  const hybrid = estimateHybridHalfMarathonV11(input, opts);
  const fitness = computeCurrentFitness({ ...input, assumeConfirmedRacesMaximal: false }, opts);
  const forecast = estimateRaceDayForecast(input, { raceDate: "2027-03-20", plan, hybrid, official, hrEnhanced: hr });
  return {
    fitness: fitness.rows.map(r => [r.id, r.finishSeconds, r.paceSecondsPerMile, r.status, r.confidence, ...estimateContract(r.estimate)]),
    hybrid: estimateContract(hybrid),
    forecast: [forecast.seconds, forecast.minutes, forecast.paceSecondsPerMile, forecast.status, forecast.currentCapabilitySeconds,
      forecast.scenarioRange, ...forecast.scenarios.map(s => [s.id, s.seconds, s.fraction])],
    official: [official.baselineSeconds, official.adjustmentSeconds, official.finishMinutes, official.paceSecondsPerMile, official.status, official.evidenceQuality],
    hr: [hr.candidateSeconds, hr.candidateMinutes, hr.candidatePaceSecondsPerMile, hr.status, hr.evidenceQuality, hr.blendWeight],
  };
}

describe("numerical preservation against pristine 0a6c85f5 (before confidence/timestamp recovery)", () => {
  for (const [name, make] of Object.entries(cases)) it(`${name}: four distances, current HM, forecast v2, official v2, HR and classifications are unchanged`, () => {
    const c: { input: ReturnType<typeof prepared>; options?: HybridV11Options } = make();
    expect(contract(c.input, c.options)).toEqual(golden[name as keyof typeof golden]);
  });
  it("retains the existing confidence and readiness thresholds", () => {
    expect(HYBRID_V11_POLICY.base.moderateReadiness).toBe(0.5);
    expect(HYBRID_V11_POLICY.base.minimumReadiness).toBe(0.2);
    expect(COMBINATION_POLICY.adequateUncertainty).toBe(0.02);
    expect(COMBINATION_POLICY.minimumItemsWithoutConfirmed).toBe(3);
    expect(READINESS_POLICY.minimumObservedWeeks).toBe(4);
  });
  it("emits a conflict restriction only when the corresponding signal actually conflicts", () => {
    for (const make of Object.values(cases)) {
      const c: { input: ReturnType<typeof prepared>; options?: HybridV11Options } = make();
      for (const row of computeCurrentFitness(c.input, c.options).rows.filter(r => r.status !== "unavailable")) {
        const e = row.estimate;
        expect(e.confidenceRestrictions?.includes("within_group_conflict")).toBe(e.flags.includes("contradictory_evidence"));
        expect(e.confidenceRestrictions?.includes("signal_conflict")).toBe(e.conflicts.length > 0);
        expect(e.confidenceRestrictions?.includes("race_age")).toBe(e.combination.raceDominance === "dominant" && (e.combination.latestRaceAgeDays ?? 0) > 42);
        if (e.confidence === "moderate") expect(e.confidenceRestrictions).toEqual([]);
        if (e.confidence === "low") expect(e.confidenceRestrictions?.length).toBeGreaterThan(0);
      }
    }
  });
});
