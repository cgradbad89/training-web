// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Race } from "@/types/race";
import type { HealthWorkout } from "@/types/healthWorkout";
import { estimateCurrentHalfMarathon } from "@/utils/experimentalCurrentPerformance";
import { canonicalizePerformanceValue, shiftPerformanceDate } from "@/utils/performanceEvidence";
import { researchRiegelSeconds, researchVdotSeconds } from "@/utils/racePerformance";
import { currentFixture } from "@/utils/__tests__/fixtures/currentPerformanceFixture";
import { researchRun, workoutResearchFixture } from "@/utils/__tests__/fixtures/workoutRaceResearchFixture";
import { checkpointSchedule, dueCheckpoints, replayCheckpoint, sealCheckpoint } from "./checkpoint";
import { PROTOCOL, digest, type Horizon, type RecordValue } from "./evidence";
import { evaluateStudy } from "./evaluate";
import { runValidationFiles } from "./offline";
import { sealOutcome } from "./outcome";

vi.mock("firebase/firestore", () => { throw new Error("Firestore must never be loaded"); });
vi.mock("firebase-admin/firestore", () => { throw new Error("Admin Firestore must never be loaded"); });
vi.mock("@/services/performanceTelemetry", () => { throw new Error("Telemetry must never be loaded"); });

const target = { subject: "synthetic-runner", raceId: "held-out-race", raceDate: "2026-10-27", timeZone: "America/New_York" };

function revision(id: string, value: Race | HealthWorkout | RecordValue, availableAt: string) {
  const doc: RecordValue = JSON.parse(JSON.stringify(value));
  return { id, revision: id + "-1", availableAt, doc };
}

function capture(horizon: Horizon = 1, fixture = currentFixture(1.5, 4, 9), currentTarget = target) {
  const capturedAt = shiftPerformanceDate(currentTarget.raceDate, -horizon) + "T16:00:00.000Z";
  return {
    protocol: PROTOCOL, target: currentTarget, horizon, capturedAt,
    source: { kind: "synthetic", reference: "Synthetic fixtures", authorization: "Synthetic only", codeRevision: "fixture-v1" },
    coverage: { workouts: "complete", races: "complete", overrides: "complete", workoutsFrom: "2025-11-01", limitations: [] },
    inputs: {
      workouts: fixture.workouts.filter(w => w.syncedAt.toISOString() <= capturedAt).map(w => revision(w.workoutId, w, w.syncedAt.toISOString())),
      races: fixture.races.filter(race => race.createdAt <= capturedAt).map(race => revision(race.id, race, race.createdAt)),
      overrides: [] as ReturnType<typeof revision>[],
      features: [] as RecordValue[],
    },
  };
}

function outcomeInput(currentTarget = target, finishSeconds = 7400) {
  return {
    protocol: PROTOCOL, dataKind: "synthetic", target: currentTarget, name: "Synthetic Half",
    kind: "official_race", distanceMeters: 21097.5, timingBasis: "chip", finishSeconds,
    recordedDurationSeconds: finishSeconds, recordedElapsedSeconds: finishSeconds,
    workoutId: null, timingReconciliation: null, effort: "maximal", effortSource: "Synthetic effort attestation",
    conditions: "Dry, measured course", source: { timingReference: "Synthetic timing",
      distanceReference: "Synthetic course certificate", knownAt: currentTarget.raceDate + "T20:00:00.000Z" },
  };
}

function study(checkpoints: unknown[], outcomes: unknown[], dataKind = "synthetic", testFromDate = "2026-10-25") {
  return { protocol: PROTOCOL, subject: target.subject, dataKind, checkpoints, outcomes, testFromDate, captureKind: "historical_capture" };
}

describe("prospective checkpoint capture", () => {
  it.each([
    ["2026-03-09", "2026-03-08", "2026-03-09T03:59:59.999Z"],
    ["2026-11-02", "2026-11-01", "2026-11-02T04:59:59.999Z"],
  ])("uses local calendar days through DST for %s", (raceDate, checkpointDate, cutoff) => {
    expect(checkpointSchedule({ ...target, raceDate }, 1)).toEqual({ checkpointDate, cutoff });
  });

  it("uses the target timezone for date-only and actual instant boundaries", () => {
    const pacific = { ...target, timeZone: "Pacific/Honolulu" };
    const input = capture(1, undefined, pacific);
    const { cutoff } = checkpointSchedule(pacific, 1);
    expect(sealCheckpoint({ ...input, capturedAt: cutoff }).cutoff).toBe("2026-10-27T09:59:59.999Z");
    expect(() => sealCheckpoint({ ...input, capturedAt: "2026-10-27T10:00:00.000Z" })).toThrow("Actual capture");
    expect(() => sealCheckpoint({ ...input, capturedAt: "2026-10-25T16:00:00.000Z" })).toThrow("Actual capture");
  });

  it("derives only due keys and ignores retries after the local checkpoint day", () => {
    expect(dueCheckpoints([target, target], "2026-10-13T16:00:00Z")).toMatchObject([{ horizon: 14, checkpointDate: "2026-10-13" }]);
    expect(dueCheckpoints([target], "2026-10-14T16:00:00Z")).toEqual([]);
  });

  it("excludes same-target, target-day, future, late-synced and unknown-sync parents", () => {
    const input = capture();
    const heldOut = researchRun("target-link", "2026-10-20");
    const future = researchRun("future", "2026-10-28");
    const targetDay = researchRun("same-day", target.raceDate);
    const pending = researchRun("pending", "2026-10-26");
    const delayed = researchRun("late-sync", "2026-10-23");
    pending.endDate = new Date("2026-10-26T17:00:00Z");
    delayed.syncedAt = new Date("2026-10-27T10:00:00Z");
    const unknown = revision("unknown-sync", researchRun("unknown-sync", "2026-10-24"), input.capturedAt);
    unknown.doc.syncedAt = null;
    input.inputs.workouts.push(unknown, ...[heldOut, future, targetDay, pending, delayed].map(w => revision(w.workoutId, w, input.capturedAt)));
    input.inputs.races.push(revision(target.raceId, {
      id: target.raceId, name: "Target", raceDate: target.raceDate, raceDistance: "halfMarathon",
      createdAt: "2026-09-01T12:00:00Z", actualRunId: heldOut.workoutId, result: "1:20:00",
    }, input.capturedAt));
    const sealed = sealCheckpoint(input);
    expect(sealed.results.inputExclusions).toEqual(expect.arrayContaining([
      { source: "workout", id: "target-link", reason: "held_out_workout" },
      { source: "workout", id: "same-day", reason: "target_date_or_later" },
      { source: "workout", id: "future", reason: "target_date_or_later" },
      { source: "workout", id: "pending", reason: "incomplete_at_capture" },
      { source: "workout", id: "late-sync", reason: "ingested_after_capture" },
      { source: "workout", id: "unknown-sync", reason: "unknown_ingestion_timestamp" },
      { source: "race", id: target.raceId, reason: "target_date_or_later" },
    ]));
    expect(sealed.results.predictions).toEqual(sealCheckpoint(capture()).results.predictions);
  });

  it("uses an available correction and withholds on a post-capture correction", () => {
    const input = capture();
    const id = input.inputs.workouts.at(-1)!.id;
    const override = revision(id, { workoutId: id, isExcluded: true, updatedAt: input.capturedAt }, input.capturedAt);
    input.inputs.overrides.push(override);
    expect(sealCheckpoint(input).results.eligibleWorkoutIds).not.toContain(id);
    override.doc.updatedAt = "2026-10-26T16:00:00.001Z";
    expect(sealCheckpoint(input).results.predictions.experimental.reason).toContain("post-capture revision");
    override.availableAt = "2026-10-27T00:00:00.000Z";
    expect(() => sealCheckpoint(input)).toThrow("revision became available after capture");
  });

  it("rejects missing or epoch revision dates without assuming ingestion", () => {
    const input = capture();
    input.inputs.workouts[0].availableAt = "";
    expect(() => sealCheckpoint(input)).toThrow("known UTC instant");
    input.inputs.workouts[0].availableAt = "1970-01-01T00:00:00.000Z";
    expect(() => sealCheckpoint(input)).toThrow("known UTC instant");
  });

  it("rejects a later race/confirmation document revision", () => {
    const input = capture();
    input.inputs.races[0].availableAt = "2026-10-29T16:00:00.000Z";
    expect(() => sealCheckpoint(input)).toThrow("races.");
  });

  it("collapses identical repeats and rejects conflicting same-ID revisions", () => {
    const input = capture();
    const before = sealCheckpoint(input);
    const first = input.inputs.workouts[0];
    input.inputs.workouts.reverse().push(structuredClone(first));
    expect(sealCheckpoint(input)).toEqual(before);
    input.inputs.workouts.at(-1)!.doc.durationSeconds = 100;
    expect(() => sealCheckpoint(input)).toThrow("Conflicting workouts revisions");
  });

  it("withholds when scope or a race anchor is missing", () => {
    const input = capture();
    input.coverage.overrides = "unknown";
    expect(sealCheckpoint(input).results.predictions.experimental).toMatchObject({ seconds: null, reason: "Incomplete overrides scope (unknown)" });
    input.coverage.overrides = "complete";
    input.inputs.races = [];
    expect(sealCheckpoint(input).results.predictions.experimental).toMatchObject({ seconds: null, reason: expect.stringContaining("No usable race anchor") });
  });

  it("withholds when the bounded workout window cannot cover the oldest allowed anchor", () => {
    const input = capture();
    input.coverage.workoutsFrom = "2026-08-01";
    expect(sealCheckpoint(input).results.coverageReasons).toContain("Workout scope must start by 2026-03-04");
  });

  it("replays exactly across JSON and rejects both corruption and model-version mismatch", () => {
    const sealed = sealCheckpoint(capture());
    expect(replayCheckpoint(JSON.parse(canonicalizePerformanceValue(sealed)))).toEqual(sealed);
    expect(() => replayCheckpoint({ ...sealed, results: { ...sealed.results, eligibleWorkoutIds: [] } })).toThrow("integrity digest");
    expect(() => replayCheckpoint({ ...sealed, modelVersions: { ...sealed.modelVersions, experimental: "different" } })).toThrow("model-version mismatch");
    const { integrityDigest, ...payload } = sealed;
    expect(integrityDigest).toBe(digest(payload));
    payload.results.predictions.experimental.seconds = 1;
    expect(() => replayCheckpoint({ ...payload, integrityDigest: digest(payload) })).toThrow("did not replay identically");
  });

  it("keeps only compact feature references and withholds incompatible or late revisions", () => {
    const input = capture();
    const [a, b, c] = input.inputs.workouts;
    const feature = (parent: typeof a) => ({
      workoutId: parent.id, parentRevision: parent.revision, revision: "1", digest: "a".repeat(64),
      status: "accepted", extractorVersion: "steady-interval-v2", qualityPolicyVersion: "observational-v1",
      extractedAt: "2026-10-20T16:00:00Z", availableAt: "2026-10-21T16:00:00Z", rawTelemetry: "not retained",
    });
    input.inputs.features = [feature(a), { ...feature(b), availableAt: "2026-10-27T00:00:00Z" }, { ...feature(c), extractedAt: null, parentRevision: "old" }];
    const sealed = sealCheckpoint(input);
    expect(sealed.results.featureChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ workoutId: a.id, status: "compatible_reference_only" }),
      expect.objectContaining({ workoutId: b.id, status: "ineligible", reasons: ["No trustworthy pre-capture feature date"] }),
      expect.objectContaining({ workoutId: c.id, status: "ineligible", reasons: ["No trustworthy pre-capture feature date", "No matching eligible parent revision"] }),
    ]));
    expect(sealed.inputs.features[0]).not.toHaveProperty("rawTelemetry");
    expect(sealed.results.predictions).toEqual(sealCheckpoint(capture()).results.predictions);
  });
});

describe("exact model and outcomes", () => {
  it("executes the production estimator and reconciles the grouped summary effects", () => {
    const fixture = currentFixture(1.5, 4, 9);
    const result = sealCheckpoint(capture(1, fixture)).results;
    const live = estimateCurrentHalfMarathon(fixture);
    expect(result.predictions.experimental.seconds).toBe(live.finishMinutes! * 60);
    expect(result.predictions.same_anchor.seconds).toBe(7860);
    expect(result.predictions.experimental.seconds).toBe(7740);
    const at = result.attribution!;
    expect(at.volumeFrequencySeconds + at.enduranceSeconds + at.comparablePaceSeconds).toBeCloseTo(live.adjustmentSeconds);
    expect(at.anchorSeconds + at.combinedSeconds + at.roundingSeconds).toBe(7740);
  });

  it("attributes the applied matched pace effect on the unchanged production path", () => {
    const fixture = workoutResearchFixture();
    const matchingTarget = { ...target, raceDate: "2026-10-26" };
    const result = sealCheckpoint(capture(1, fixture, matchingTarget)).results;
    expect(result.predictions.experimental.seconds).toBe(estimateCurrentHalfMarathon(fixture).finishMinutes! * 60);
    expect(result.attribution!.comparablePaceSeconds).toBeLessThan(0);
  });

  it("isolates freshness at fixed inputs when identifiable", () => {
    const newer = currentFixture(1.5, 4, 9);
    const earlier = newer.races[0];
    const anchor = newer.workouts[0];
    earlier.raceDate = "2026-06-25";
    earlier.createdAt = "2026-06-25T16:00:00Z";
    anchor.startDate = new Date("2026-06-25T12:00:00Z");
    anchor.endDate = new Date(anchor.startDate.getTime() + anchor.durationSeconds * 1000);
    anchor.syncedAt = new Date(anchor.endDate.getTime() + 1000);
    const prior = currentFixture().workouts.slice(1, 25).map(w => ({
      ...w, workoutId: "earlier-" + w.workoutId,
      startDate: new Date(w.startDate.getTime() - 66 * 86400000), endDate: new Date(w.endDate.getTime() - 66 * 86400000),
      syncedAt: new Date(w.syncedAt.getTime() - 66 * 86400000),
    }));
    const olderAnchor = { ...newer, workouts: [...newer.workouts, ...prior] };
    const at = sealCheckpoint(capture(1, olderAnchor)).results.attribution!;
    expect(at.freshnessMultiplier).toBeCloseTo(57 / 90);
    expect(at.freshnessEffectSeconds).toBeGreaterThan(0);
    expect(at.fixedInputsAdjustmentWithoutFreshnessSeconds! * at.freshnessMultiplier!).toBeCloseTo(at.combinedSeconds);
  });

  it("uses existing Riegel and VDOT with independently qualified different-distance anchor evidence", () => {
    const fixture = currentFixture();
    const race = fixture.races[0];
    const workout = fixture.workouts[0];
    race.raceDistance = "10K";
    workout.distanceMeters = 10000;
    workout.distanceMiles = 10000 / 1609.344;
    race.performanceEvidence = { status: "verified", kind: "official_race", knownAt: "2026-08-30T16:00:00Z",
      raceDate: race.raceDate, distanceMeters: 10000, finishSeconds: 3700, effort: "maximal", conditions: "Dry", source: "Synthetic" };
    workout.durationSeconds = 3700;
    workout.endDate = new Date(workout.startDate.getTime() + 3700 * 1000);
    const prediction = sealCheckpoint(capture(1, fixture)).results.predictions;
    expect(prediction.same_distance.seconds).toBeNull();
    expect(prediction.riegel.seconds).toBe(researchRiegelSeconds(3700, 10000, 21097.5));
    expect(prediction.vdot.seconds).toBe(researchVdotSeconds(3700, 10000, 21097.5));
  });

  it("keeps official timing separate from a conflicting recorded clock", () => {
    const raw = { ...outcomeInput(), recordedElapsedSeconds: 8000 };
    expect(sealOutcome(raw).qualificationReasons).toContain("Clock disagreement requires documented reconciliation");
    expect(sealOutcome({ ...raw, timingReconciliation: "Official chip clock, device included pre-start delay" }).qualificationReasons).toEqual([]);
    expect(() => sealOutcome({ ...raw, finishSeconds: -20 })).toThrow("must be positive");
  });

  it("withholds unverified timing and nonmaximal outcomes and accepts independently timed trials", () => {
    const unverified = sealOutcome({ ...outcomeInput(), finishSeconds: null, timingBasis: "unverified", effort: "nonmaximal" });
    expect(unverified.qualificationReasons).toHaveLength(2);
    expect(sealOutcome({ ...outcomeInput(), kind: "measured_time_trial", timingBasis: "independent_elapsed" }).qualificationReasons).toEqual([]);
  });
});

describe("study scoring and independent evidence", () => {
  it("withholds real evidence with self-declared provenance or a late independent receipt", () => {
    const input = capture();
    input.source.kind = "historical_capture";
    const checkpoint = sealCheckpoint(input);
    const outcome = sealOutcome({ ...outcomeInput(), dataKind: "real" });
    const request = study([checkpoint], [outcome], "real");
    expect(evaluateStudy(request)).toMatchObject({ eligibleOutcomeCount: 0, exclusions: expect.arrayContaining([
      expect.objectContaining({ kind: "checkpoint", reason: "Missing independent custody or outcome review receipt" }),
    ]) });
    const outcomeReceipt = { kind: "outcome", digest: outcome.integrityDigest, anchoredAt: outcome.source.knownAt, reference: "Reviewed timing and distance" };
    const captureReceipt = { kind: "historical_input", digest: checkpoint.inputDigest, anchoredAt: "2026-10-27T04:00:00Z", reference: "External immutable pin" };
    expect(evaluateStudy(request, [outcomeReceipt, captureReceipt]).exclusions[0].reason).toContain("outside the evidence");
    expect(evaluateStudy(request, [outcomeReceipt, { ...captureReceipt, anchoredAt: checkpoint.cutoff }]).cases.find(row => row.horizon === 1)?.errors?.experimental.predictedSeconds).toBe(7740);
  });

  it("requires a prediction receipt for prospective evaluation and separates historical replay", () => {
    const input = capture();
    input.source.kind = "prospective_capture";
    const checkpoint = sealCheckpoint(input);
    const outcome = sealOutcome({ ...outcomeInput(), dataKind: "real" });
    const request = { ...study([checkpoint], [outcome], "real"), captureKind: "prospective_capture" };
    const timingReceipt = { kind: "outcome", digest: outcome.integrityDigest, anchoredAt: outcome.source.knownAt, reference: "Independent timing" };
    const inputReceipt = { kind: "historical_input", digest: checkpoint.inputDigest, anchoredAt: checkpoint.cutoff, reference: "Input-only pin" };
    expect(evaluateStudy(request, [timingReceipt, inputReceipt]).exclusions[0].reason).toContain("Missing independent custody");
    const sealedReceipt = { ...inputReceipt, kind: "checkpoint", digest: checkpoint.integrityDigest };
    const report = evaluateStudy(request, [timingReceipt, sealedReceipt]);
    expect(report.cases.find(row => row.horizon === 1)?.errors?.experimental.predictedSeconds).toBe(7740);
    expect(report.evidenceCustody).toContainEqual(expect.objectContaining({ digest: checkpoint.integrityDigest }));
    expect(evaluateStudy({ ...request, captureKind: "historical_capture" }, [timingReceipt, sealedReceipt]).exclusions[0].reason)
      .toContain("capture kind");
  });

  it("excludes held-out outcome workout identity even if a capture linked it later", () => {
    const checkpoint = sealCheckpoint(capture());
    const outcome = sealOutcome({ ...outcomeInput(), workoutId: checkpoint.results.eligibleWorkoutIds[0] });
    expect(evaluateStudy(study([checkpoint], [outcome])).cases.find(row => row.horizon === 1)).toMatchObject({
      errors: null, reason: "Held-out outcome workout was eligible in the checkpoint",
    });
  });

  it("reports zero denominators as unavailable and separates missing and corrupt artifacts", () => {
    const report = evaluateStudy(study([null, { protocol: PROTOCOL }], []));
    expect(report.eligibleOutcomeCount).toBe(0);
    expect(report.exclusions).toHaveLength(2);
    expect(report.summaries[0].methods.experimental).toMatchObject({
      predictions: 0, abstentionRate: null, availability: null, meanAbsoluteErrorSeconds: null, signedBiasSeconds: null, errorsAtLeastFiveMinutes: null,
    });
  });

  it("keeps checkpoints for the same outcome correlated and calculates paired errors in seconds", () => {
    const checkpoints = ([28, 14, 7, 1] as const).map(horizon => sealCheckpoint(capture(horizon)));
    const outcome = sealOutcome(outcomeInput());
    const report = evaluateStudy(study(checkpoints, [outcome, outcome]));
    expect(report.eligibleOutcomeCount).toBe(1);
    expect(report.cases).toHaveLength(4);
    const one = report.summaries.find(row => row.split === "test" && row.horizon === 1)!;
    expect(one.methods.experimental).toMatchObject({ availability: 1, abstentionRate: 0,
      meanAbsoluteErrorSeconds: 340, signedBiasSeconds: 340, errorsAtLeastFiveMinutes: 1 });
    expect(one.pairedAgainstExperimental.same_anchor).toMatchObject({ count: 1, deltaMeanAbsoluteErrorSeconds: -120 });
    expect(one.pairedAgainstExperimental.same_distance.count).toBe(0);
    expect(report.cases.find(row => row.horizon === 1)!.componentErrors).toHaveProperty("noEndurance");
  });

  it("keeps development outcomes out of the test split and signed error can be negative", () => {
    const checkpoint = sealCheckpoint(capture());
    const report = evaluateStudy(study([checkpoint], [sealOutcome(outcomeInput(target, 8000))], "synthetic", "2026-11-01"));
    expect(report.summaries.find(row => row.split === "development" && row.horizon === 1)!.methods.experimental.signedBiasSeconds).toBe(-260);
    expect(report.summaries.find(row => row.split === "test" && row.horizon === 1)!.eligibleOutcomes).toBe(0);
  });

  it("rejects conflicting outcomes and competing checkpoint artifacts without selecting by output", () => {
    const checkpoint = sealCheckpoint(capture());
    const outcome = sealOutcome(outcomeInput());
    const competitor = sealCheckpoint({ ...capture(), capturedAt: "2026-10-26T17:00:00.000Z" });
    const report = evaluateStudy(study([checkpoint, competitor], [outcome]));
    expect(report.exclusions[0].reason).toContain("Conflicting checkpoint");
    expect(report.summaries.find(row => row.split === "test" && row.horizon === 1)!.missingOrExcludedCheckpoints).toBe(1);
    const conflicting = sealOutcome(outcomeInput({ ...target, raceId: "alias" }));
    expect(evaluateStudy(study([], [outcome, conflicting])).eligibleOutcomeCount).toBe(0);
  });

  it("runs offline with create-only private artifacts and produces machine-readable and human reports", () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
    const folder = mkdtempSync(join(tmpdir(), "synthetic-phase3d-"));
    try {
      const input = join(folder, "input.json");
      const output = join(folder, "output.json");
      const markdown = join(folder, "report.md");
      writeFileSync(input, JSON.stringify(study([sealCheckpoint(capture())], [sealOutcome(outcomeInput())])));
      const report = runValidationFiles({ mode: "evaluate", input, output, markdown });
      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report);
      expect(readFileSync(markdown, "utf8")).toContain("Eligible independent outcomes** 1");
      expect(() => runValidationFiles({ mode: "evaluate", input, output })).toThrow("EEXIST");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
