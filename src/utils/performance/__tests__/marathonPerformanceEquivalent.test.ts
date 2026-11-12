import { describe, expect, it } from "vitest";
import { confirmedHalf, fitnessWorld, SEPTEMBER_RACE, strongEffortWorld } from "@/utils/__tests__/fixtures/currentFitnessFixture";
import { distanceRace } from "@/utils/__tests__/fixtures/hybridV11Fixture";
import { computeCurrentFitness } from "../hybridCurrentFitness";
import { marathonPerformanceEquivalent } from "../marathonPerformanceEquivalent";

const world = () => fitnessWorld({ asOfDate: "2026-11-12", races: [SEPTEMBER_RACE()], adapted: false, gaps: [3, 3, 4], miles: [3, 4, 3, 8] });
const marathon = (fitness: ReturnType<typeof computeCurrentFitness>) => fitness.rows.find(row => row.id === "marathon")!;

describe("supplementary marathon performance equivalent", () => {
  it("reuses the exact pre-gate base with known low readiness while the official marathon stays withheld", () => {
    const fitness = computeCurrentFitness(world());
    const row = marathon(fitness), benchmark = fitness.marathonEquivalent!;
    expect(row.estimate.readiness!.score).not.toBeNull();
    expect(row.estimate.readiness!.score).toBeLessThan(0.2);
    expect([row.status, row.finishSeconds, row.confidence, row.unavailableCause]).toEqual(["unavailable", null, null, "insufficient_endurance_preparation"]);
    expect(benchmark.seconds).toBe(row.estimate.combination.baseSeconds);
    expect(benchmark.confidence).toBe("low");
    expect(benchmark.version).toBe("experimental-marathon-equivalent-v1");
    expect(fitness.version).toBe("experimental-hybrid-v1.1-targets-2");
    expect(benchmark.sources).toEqual([expect.objectContaining({ raceId: "september", date: "2026-09-20", ageDays: 53, effectiveShare: 1, qualifyingHalf: true })]);
  });

  it("copies the original mixed-evidence base and effective shares without re-adding the half", () => {
    const fitness = computeCurrentFitness(strongEffortWorld("2026-11-12"));
    const combination = marathon(fitness).estimate.combination, benchmark = fitness.marathonEquivalent!;
    expect(benchmark.sources.length).toBeGreaterThan(1);
    expect(benchmark.seconds).toBe(combination.baseSeconds);
    expect(benchmark.sources.map(source => source.effectiveShare)).toEqual(combination.items.map(item => item.effectiveShare));
    expect(benchmark.sources.filter(source => source.qualifyingHalf)).toHaveLength(1);
    expect(benchmark.sources.find(source => source.qualifyingHalf)!.effectiveShare).toBeLessThan(1);
    expect(new Set(benchmark.sources.map(source => source.clusterId)).size).toBe(benchmark.sources.length);
    expect(benchmark.sources.reduce((sum, source) => sum + source.effectiveShare, 0)).toBeCloseTo(1, 12);
  });

  it("honours same-day deduplication and identifies only the half that actually contributes", () => {
    const duplicate = confirmedHalf({ id: "other-half", date: "2026-09-20", seconds: 7900, effort: "maximal" });
    const fitness = computeCurrentFitness(fitnessWorld({ asOfDate: "2026-11-12", races: [SEPTEMBER_RACE(), duplicate] }));
    const benchmark = fitness.marathonEquivalent!;
    expect(benchmark.sources).toHaveLength(1);
    expect(benchmark.sources[0].raceId).toBe("other-half");
    expect(benchmark.sources[0].effectiveShare).toBe(1);
    expect(marathon(fitness).estimate.qualification.base.excludedByReason.same_day_duplicate_effort).toBe(1);
  });

  it.each(["removed", "invalid confirmation", "conflicting result", "conflicting workout", "excluded", "unconfirmed", "unknown effort", "future race", "expired"])("omits unsupported evidence: %s", scenario => {
    const input = world();
    const race = input.races[0];
    if (scenario === "removed") input.races = [];
    if (scenario === "invalid confirmation") Object.values(race.confirmationHistory!.revisions)[0].details.source = "";
    if (scenario === "conflicting result") race.result = "1:50:00";
    if (scenario === "conflicting workout") {
      const workout = input.workouts.find(w => w.workoutId === race.actualRunId)!;
      input.workouts.push({ ...workout, durationSeconds: workout.durationSeconds + 900 });
    }
    if (scenario === "excluded") Object.assign(input.overrides, { [race.actualRunId!]: { workoutId: race.actualRunId, isExcluded: true, updatedAt: "2026-11-11T12:00:00.000Z" } });
    if (scenario === "unconfirmed") delete race.confirmationHistory;
    if (scenario === "unknown effort") Object.values(race.confirmationHistory!.revisions)[0].details.effort = "unknown";
    if (scenario === "future race") input.asOf = "2026-09-19T17:00:00.000Z";
    if (scenario === "expired") input.asOf = "2027-03-20T17:00:00.000Z";
    expect(computeCurrentFitness(input).marathonEquivalent).toBeNull();
  });

  it("requires confirmation even when a linked recorded half legitimately carries the official base", () => {
    const input = world(); delete input.races[0].confirmationHistory;
    const fitness = computeCurrentFitness(input);
    expect(marathon(fitness).estimate.combination.baseSeconds).not.toBeNull();
    expect(fitness.marathonEquivalent).toBeNull();
  });

  it("keeps the 180-day boundary inclusive and removes the benchmark at day 181", () => {
    const input = fitnessWorld({ asOfDate: "2027-03-20", races: [SEPTEMBER_RACE()], adapted: false });
    expect(computeCurrentFitness({ ...input, asOf: "2027-03-19T17:00:00.000Z" }).marathonEquivalent).not.toBeNull();
    expect(computeCurrentFitness({ ...input, asOf: "2027-03-20T17:00:00.000Z" }).marathonEquivalent).toBeNull();
  });

  it("never uses an optimistic conversion when training readiness is unknown", () => {
    const input = world();
    input.workouts = input.workouts.filter(w => w.workoutId === input.races[0].actualRunId);
    const fitness = computeCurrentFitness(input);
    expect(marathon(fitness).estimate.combination.baseSeconds).not.toBeNull();
    expect(marathon(fitness).estimate.readiness!.score).toBeNull();
    expect(fitness.marathonEquivalent).toBeNull();
  });

  it("does not attribute a zero-weight or superseded half to a base carried by other evidence", () => {
    const estimate = structuredClone(marathon(computeCurrentFitness(world())).estimate);
    estimate.combination.items[0].effectiveShare = 0;
    expect(marathonPerformanceEquivalent(estimate)).toBeNull();
    estimate.combination.items[0].effectiveShare = 1;
    estimate.qualification.independent = [];
    expect(marathonPerformanceEquivalent(estimate)).toBeNull();
  });

  it.each([null, 0, -1, NaN, Infinity])("does not fabricate an invalid base: %s", base => {
    const estimate = structuredClone(marathon(computeCurrentFitness(world())).estimate);
    estimate.combination.baseSeconds = base;
    expect(marathonPerformanceEquivalent(estimate)).toBeNull();
  });

  it("omits a contradictory weighted race group", () => {
    const input = world(), other = distanceRace("conflicting-10mi", "2026-10-18", 16093.44, 70 * 60, true, "custom");
    other.race.customDistanceMiles = 10;
    input.races.push(other.race); input.workouts.push(other.workout);
    const fitness = computeCurrentFitness(input);
    expect(marathon(fitness).estimate.combination.flags).toContain("contradictory_evidence");
    expect(fitness.marathonEquivalent).toBeNull();
  });

  it("respects maximal-assumption rollback and the existing demonstrated-race selection, without inventing a fallback base", () => {
    const input = { ...world(), assumeConfirmedRacesMaximal: false };
    const withheld = computeCurrentFitness(input);
    expect(marathon(withheld).estimate.combination.baseSeconds).toBeNull();
    expect(withheld.marathonEquivalent).toBeNull();
    const prepared = fitnessWorld({ asOfDate: "2026-11-12", races: [SEPTEMBER_RACE()], adapted: false, gaps: [1, 2, 2, 2], miles: [8, 8, 10, 20, 7, 8] });
    const fallback = computeCurrentFitness({ ...prepared, assumeConfirmedRacesMaximal: false });
    expect(marathon(fallback).estimate.demonstrated.basis).toBe("demonstrated_performance_only");
    expect(fallback.marathonEquivalent!.seconds).toBe(marathon(fallback).estimate.combination.baseSeconds);
    expect(computeCurrentFitness({ ...prepared, assumeConfirmedRacesMaximal: false }, { strictMaximalOnly: true }).marathonEquivalent).toBeNull();
  });

  it("ignores target pace and reads without changing any official estimate diagnostics", () => {
    const input = world(), before = computeCurrentFitness(input);
    const estimate = marathon(before).estimate, snapshot = structuredClone(estimate);
    marathonPerformanceEquivalent(estimate);
    expect(estimate).toEqual(snapshot);
    input.races[0].targetPaceSecondsPerMile = 300;
    const after = computeCurrentFitness(input);
    expect(after.rows).toEqual(before.rows);
    expect(after.marathonEquivalent).toEqual(before.marathonEquivalent);
  });
});
