import { describe, expect, it } from "vitest";
import { evaluateRacePerformance } from "@/utils/racePerformance";
import { selectRaceConfirmationEvidence } from "@/utils/raceConfirmationEvidence";
import type { WorkoutOverride } from "@/types/workoutOverride";
import { confirmedRaceFixture, correctRaceFixture } from "./fixtures/raceConfirmationFixture";

const asOf = "2026-10-25T16:00:00.000Z";
const timeZone = "America/New_York";
function evaluate(fixture = confirmedRaceFixture(), cutoff = asOf, historical = false) {
  return evaluateRacePerformance({ races: [fixture.race], workouts: [fixture.workout], asOf: cutoff, timeZone,
    asOfMode: historical ? "historical" : "current" });
}

describe("Phase 3B confirmation evidence consumption", () => {
  it("makes a consistent confirmed September observation an eligible dated benchmark while withholding forecasts", () => {
    const fixture = confirmedRaceFixture();
    const result = evaluate(fixture);
    expect(result.latestBenchmark).toMatchObject({ name: "Synthetic official event", raceDate: "2026-09-20", status: "verified",
      finishSeconds: 7871, timingAgreement: "consistent", eligibleSameDistanceBenchmark: true, confirmationRevisionId: fixture.revision.revisionId,
      confirmationChronology: "client_document_untrusted" });
    expect(result.currentCapability.estimatedSeconds).toBeNull();
    expect(result.currentCapability.confidenceInterval).toBeNull();
    expect(result.raceDayForecast.estimatedSeconds).toBeNull();
    expect(result.raceDayForecast.confidenceInterval).toBeNull();
  });
  it("distinguishes an explicit owner attestation from official-result verification", () => {
    const fixture = confirmedRaceFixture();
    fixture.revision.details.status = "owner_confirmed";
    fixture.revision.details.source = "I confirm the posted chip result, distance, effort and conditions.";
    expect(evaluate(fixture).latestBenchmark).toMatchObject({ status: "owner_confirmed", eligibleForEquivalence: true });
  });
  it.each(["", "Owner says this is official", "javascript:alert(1)"])("rejects a verified result lacking an official URL: %s", source => {
    const fixture = confirmedRaceFixture();
    fixture.revision.details.source = source;
    expect(evaluate(fixture).latestBenchmark).toBeNull();
    expect(evaluate(fixture).evidence[0].reasons).toContain("invalid_confirmation_history");
  });
  it("keeps an April duration/elapsed conflict until its exact confirmation explicitly reconciles it", () => {
    const fixture = confirmedRaceFixture({ id: "synthetic-april", date: "2026-04-26", seconds: 8130, elapsed: 8759 });
    expect(evaluate(fixture).evidence[0]).toMatchObject({ status: "inconsistent", timingAgreement: "discrepant", eligibleForEquivalence: false });
    fixture.revision.details.finishSeconds = 8200;
    fixture.revision.details.timingReconciliation = "Synthetic official chip timing excludes the documented pre-start wait.";
    expect(evaluate(fixture).latestBenchmark).toMatchObject({ finishSeconds: 8200, durationSeconds: 8130, elapsedSeconds: 8759,
      timingAgreement: "reconciled", status: "verified", eligibleForEquivalence: true });
  });
  it.each(["unknown", "hard", "nonmaximal"] as const)("does not qualify %s effort for equivalence", effort => {
    const fixture = confirmedRaceFixture();
    fixture.revision.details.effort = effort;
    expect(evaluate(fixture).evidence[0].eligibleForEquivalence).toBe(false);
  });
  it("rejects an incorrect current workout link and nominal distance", () => {
    const fixture = confirmedRaceFixture();
    fixture.race.actualRunId = "different-run";
    expect(evaluate(fixture).evidence[0].reasons).toContain("confirmation_workout_identity_mismatch");
    fixture.race.actualRunId = fixture.workout.workoutId;
    fixture.revision.details.distanceMeters = 10_000;
    expect(evaluate(fixture).evidence[0].reasons).toContain("invalid_confirmation_history");
    expect(evaluate(fixture).evidence[0].eligibleForEquivalence).toBe(false);
  });
  it("selects a correction only once available, keeping original observations and input parents unchanged", () => {
    const fixture = confirmedRaceFixture();
    const originalRevision = structuredClone(fixture.revision);
    const originalWorkout = structuredClone(fixture.workout);
    correctRaceFixture(fixture.race, { finishSeconds: 7800 }, "2026-10-26T16:00:00.000Z");
    expect(evaluate(fixture).latestBenchmark?.finishSeconds).toBe(7871);
    expect(evaluate(fixture, "2026-10-26T16:00:00.000Z").latestBenchmark?.finishSeconds).toBe(7800);
    expect(fixture.race.confirmationHistory?.revisions[fixture.revision.revisionId]).toEqual(originalRevision);
    expect(fixture.workout).toEqual(originalWorkout);
  });
  it.each(["duration", "end", "distance", "race", "override", "missing", "timezone"] as const)("requires a new confirmation when original %s observations change", change => {
    const fixture = confirmedRaceFixture();
    const original = structuredClone(fixture.revision.observations);
    const current = structuredClone(fixture.workout);
    if (change === "duration") current.durationSeconds -= 5;
    if (change === "end") current.endDate = new Date(current.endDate.getTime() + 1000);
    if (change === "distance") current.distanceMiles += 0.01;
    if (change === "race") fixture.race.result = "2:11:10";
    const overrides = change === "override" ? { [current.workoutId]: { workoutId: current.workoutId, userId: "synthetic-owner",
      isExcluded: false, updatedAt: "2026-10-25T12:00:00.000Z", distanceMilesOverride: null, durationSecondsOverride: 7870,
      runTypeOverride: null, excludedAt: null, excludedReason: null } as WorkoutOverride } : undefined;
    const result = evaluateRacePerformance({ races: [fixture.race], workouts: change === "missing" ? [] : [current], overrides,
      asOf, timeZone: change === "timezone" ? "UTC" : timeZone });
    expect(result.latestBenchmark).toBeNull();
    expect(result.evidence[0]).toMatchObject({ eligibleForEquivalence: false, confirmationRevisionId: null, status: "inconsistent" });
    expect(result.evidence[0].reasons).toContain("confirmation_observations_changed");
    expect(fixture.revision.observations).toEqual(original);
    expect(fixture.workout.durationSeconds).toBe(7871);
  });
  it("does not leak future confirmations, including their event names or maximal-effort claims", () => {
    const fixture = confirmedRaceFixture();
    const result = evaluate(fixture, "2026-10-23T16:00:00.000Z");
    expect(result.latestBenchmark).toMatchObject({ name: "Synthetic stored race", status: "recorded_unverified", effort: "unknown",
      confirmationRevisionId: null, eligibleForEquivalence: false });
  });
  it("abstains historically even when a client-stored receipt predates the cutoff", () => {
    const fixture = confirmedRaceFixture({ availableAt: "2026-09-21T16:00:00.000Z" });
    const result = evaluate(fixture, asOf, true);
    expect(result.latestBenchmark).toBeNull();
    expect(result.evidence[0]).toMatchObject({ availableAsOf: false, eligibleForEquivalence: false });
    expect(result.evidence[0].reasons).toContain("confirmation_chronology_untrusted");
  });
  it("does not fall back to a legacy knownAt when the saved history is malformed", () => {
    const fixture = confirmedRaceFixture();
    fixture.race.performanceEvidence = selectRaceConfirmationEvidence(fixture.race, asOf, timeZone).confirmation;
    fixture.race.confirmationHistory = null;
    expect(evaluate(fixture).latestBenchmark).toBeNull();
    expect(evaluate(fixture, asOf, true).latestBenchmark).toBeNull();
  });
  it("rejects missing, repeated, detached and reordered corrections instead of guessing a history", () => {
    for (const defect of ["missing", "request", "detached", "backdated"] as const) {
      const fixture = confirmedRaceFixture();
      const correction = correctRaceFixture(fixture.race, { finishSeconds: 7800 }, "2026-10-25T16:00:00.000Z");
      if (defect === "missing") correction.supersedesRevisionId = "missing";
      if (defect === "request") correction.requestId = fixture.revision.requestId;
      if (defect === "detached") fixture.race.confirmationHistory!.revisions.orphan = { ...correction, revisionId: "orphan" };
      if (defect === "backdated") correction.availableAt = "2026-10-23T16:00:00.000Z";
      expect(evaluate(fixture).evidence[0].reasons).toContain("invalid_confirmation_history");
    }
  });
  it("withholds unresolved receipt timestamps rather than inventing availability", () => {
    const fixture = confirmedRaceFixture();
    fixture.revision.availableAt = null;
    expect(evaluate(fixture).evidence[0]).toMatchObject({ status: "recorded_unverified", eligibleForEquivalence: false });
    expect(evaluate(fixture).evidence[0].reasons).toContain("unknown_confirmation_revision_time");
  });
  it("permits research equivalence from current eligible evidence without making a personal forecast", () => {
    const fixture = confirmedRaceFixture();
    const result = evaluateRacePerformance({ races: [fixture.race], workouts: [fixture.workout], asOf, timeZone, targetDistanceMeters: 10_000 });
    expect(result.researchEquivalences).toHaveLength(2);
    expect(result.researchEquivalences.every(item => item.purpose === "research_only")).toBe(true);
    expect(result.currentCapability.estimatedSeconds).toBeNull();
    expect(result.raceDayForecast.estimatedSeconds).toBeNull();
  });
});
