import { describe, expect, it } from "vitest";
import type { Race } from "@/types/race";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { RaceConfirmationDraft, RaceConfirmationHistory } from "@/types/raceConfirmation";
import { buildRaceConfirmationInput, buildRaceConfirmationRevision, buildRaceConfirmationSnapshot, normalizeRaceConfirmationHistory, raceConfirmationInstant, validateRaceConfirmationInput } from "@/utils/raceConfirmation";

const race: Race = { id: "synthetic-race", name: "Synthetic Harbor Half", raceDate: "2026-09-20", raceDistance: "halfMarathon", actualRunId: "synthetic-run", actualRunDurationSeconds: 7871, isActive: false, createdAt: "2026-09-01T12:00:00.000Z" };
const workout = { workoutId: "synthetic-run", startDate: new Date("2026-09-20T12:00:00.000Z"), endDate: new Date("2026-09-20T14:11:11.000Z"), durationSeconds: 7871, distanceMiles: 13.109, distanceMeters: 21097.5, isRunLike: true, activityType: "running", syncedAt: new Date("2026-09-20T15:00:00.000Z") } as HealthWorkout;
const draft: RaceConfirmationDraft = { officialEventName: "Synthetic Harbor Half", raceDate: race.raceDate, distanceMeters: 21097.5, finishSeconds: 7871, timeBasis: "chip", status: "verified", effort: "maximal", conditions: "Flat course; cool weather.", source: "https://example.test/results/synthetic" };
const make = (changes: Partial<RaceConfirmationDraft> = {}, changedRace = race, changedWorkout = workout, override: WorkoutOverride | null = null) => buildRaceConfirmationInput({ race: changedRace, workout: changedWorkout, override, timeZone: "America/New_York", draft: { ...draft, ...changes }, requestId: "request-one" });
const override = (changes: Partial<WorkoutOverride>): WorkoutOverride => ({ workoutId: workout.workoutId, userId: "owner", isExcluded: false, excludedAt: null, excludedReason: null, durationSecondsOverride: null, distanceMilesOverride: null, runTypeOverride: null, updatedAt: "2026-10-23T12:00:00.000Z", ...changes });
const history = (): RaceConfirmationHistory => {
  const revision = buildRaceConfirmationRevision(make(), null, "2026-10-24T12:00:00.000Z");
  return { schemaVersion: 1, chronology: "client_document_untrusted", currentRevisionId: revision.revisionId, revisions: { [revision.revisionId]: revision } };
};

describe("explicit race confirmations", () => {
  it("distinguishes official verification from an explicit owner attestation without changing observations", () => {
    const before = JSON.stringify({ race, workout });
    expect(make().details.status).toBe("verified");
    expect(make({ status: "owner_confirmed", source: "I attest this was my finish time based on my race receipt." }).details.status).toBe("owner_confirmed");
    expect(JSON.stringify({ race, workout })).toBe(before);
    expect(make().observations.workout.durationSeconds).toBe(7871);
  });
  it.each(["", "not a URL", "javascript:alert(1)", "https://user:password@example.test/result"])("rejects missing or unsafe official provenance: %s", source => {
    expect(() => make({ source })).toThrow();
  });
  it("requires attestation prose for owner-confirmed evidence", () => {
    expect(() => make({ status: "owner_confirmed", source: "https://example.test/result" })).toThrow("attestation");
  });
  it.each(["unknown", "nonmaximal", "hard"] as const)("records %s effort honestly without promoting it", effort => {
    expect(make({ effort }).details.effort).toBe(effort);
  });
  it("requires conditions to be explicitly described", () => expect(() => make({ conditions: " " })).toThrow("Conditions"));
  it("requires an explanation for April-like recorded/elapsed timing disagreement", () => {
    const discrepant = { ...workout, durationSeconds: 8130, endDate: new Date("2026-09-20T14:25:59.000Z") };
    const record = { ...race, actualRunDurationSeconds: 8130 };
    expect(() => make({ finishSeconds: 8130 }, record, discrepant)).toThrow("timing explanation");
    const result = make({ finishSeconds: 8130, timingReconciliation: "Official chip result differs from watch elapsed time; explanation supplied by owner." }, record, discrepant);
    expect(result.observations.workout.durationSeconds).toBe(8130);
    expect(result.observations.workout.endDate).toBe("2026-09-20T14:25:59.000Z");
  });
  it("accepts consistent September-like timing without fabricating reconciliation", () => expect(make().details.timingReconciliation).toBeNull());
  it("does not let a duration override hide the original recorded-versus-elapsed conflict", () => {
    const raw = { ...workout, durationSeconds: 8130, endDate: new Date("2026-09-20T14:25:59.000Z") };
    const record = { ...race, actualRunDurationSeconds: undefined };
    const correction = override({ durationSecondsOverride: 8759 });
    expect(() => make({ finishSeconds: 8759 }, record, raw, correction)).toThrow("timing explanation");
    const confirmed = make({ finishSeconds: 8759, timingReconciliation: "Original watch duration omits stopped time; the official result was independently checked." }, record, raw, correction);
    expect(confirmed.observations.workout.durationSeconds).toBe(8130);
    expect(confirmed.observations.override?.durationSecondsOverride).toBe(8759);
  });
  it("requires an explanation when a valid previously entered result contradicts the linked duration", () => {
    const record = { ...race, result: "1:00:00" };
    expect(() => make({}, record)).toThrow("timing explanation");
    const confirmed = make({ timingReconciliation: "The old manually entered result was a typo; the official chip result was checked." }, record);
    expect(confirmed.observations.race.result).toBe("1:00:00");
    expect(confirmed.details.finishSeconds).toBe(7871);
  });
  it.each(["invalid", "1:61:00", "00:00"])("does not infer timing from invalid entered text %s", result => {
    expect(make({}, { ...race, result }).details.timingReconciliation).toBeNull();
  });
  it("uses the symmetric one-percent timing tolerance at either side of the boundary", () => {
    const raw = { ...workout, durationSeconds: 10000, endDate: new Date("2026-09-20T14:45:00.000Z") }; // 9,900 elapsed.
    const record = { ...race, actualRunDurationSeconds: 10000 };
    expect(make({ finishSeconds: 9900 }, record, raw).details.timingReconciliation).toBeNull();
    expect(() => make({ finishSeconds: 9899 }, record, raw)).toThrow("timing explanation");
    expect(make({ finishSeconds: 9900 }, { ...record, actualRunDurationSeconds: 9900 }, { ...raw, durationSeconds: 9900, endDate: new Date("2026-09-20T14:46:40.000Z") }).details.timingReconciliation).toBeNull();
  });
  it("rejects the wrong linked workout and event date", () => {
    expect(() => make({}, { ...race, actualRunId: "different" })).toThrow("identity");
    expect(() => make({ raceDate: "2026-09-21" })).toThrow("date");
  });
  it("rejects incompatible official and workout distances", () => {
    expect(() => make({ distanceMeters: 10000 })).toThrow("distance");
    expect(() => make({}, race, { ...workout, distanceMiles: 6.2, distanceMeters: 10000 })).toThrow("distance");
  });
  it("uses effective meter distance consistently with the evaluator and keeps raw measurements intact", () => {
    const raw = { ...workout, distanceMiles: 13.109, distanceMeters: 10000 };
    expect(() => make({}, race, raw)).toThrow("distance");
    const confirmed = make({}, race, raw, override({ distanceMilesOverride: 13.109 }));
    expect(confirmed.observations.workout.distanceMeters).toBe(10000);
    expect(confirmed.observations.override?.distanceMilesOverride).toBe(13.109);
    expect(make({}, race, { ...workout, distanceMeters: null }).details.distanceMeters).toBe(21097.5);
  });
  it("makes snapshot changes visible and refuses tampered observations", () => {
    const first = make();
    expect(buildRaceConfirmationSnapshot({ ...race, result: "2:12:00" }, workout, null, "America/New_York").snapshotToken).not.toBe(first.snapshotToken);
    first.observations.workout.durationSeconds += 1;
    expect(() => validateRaceConfirmationInput(first)).toThrow("observations");
  });
  it.each(["nested.field", "__proto__", "constructor", "toString"])("rejects unsafe request ID %s before persistence", requestId => {
    const input = make(); input.requestId = requestId;
    expect(() => validateRaceConfirmationInput(input)).toThrow("request ID");
  });
});

describe("append-only provenance and available-at normalization", () => {
  it("requires a correction reason and retains the prior original revision", () => {
    const first = history();
    expect(() => make({}, { ...race, confirmationHistory: first })).toThrow("correction reason");
    const input = { ...make({ source: "https://example.test/result/corrected", correctionReason: "Corrected source link." }, { ...race, confirmationHistory: first }), requestId: "request-two" };
    const corrected = buildRaceConfirmationRevision(input, first, "2026-10-25T12:00:00.000Z");
    expect(corrected.supersedesRevisionId).toBe("request-one");
    expect(corrected.revisionNumber).toBe(2);
    expect(first.revisions["request-one"].availableAt).toBe("2026-10-24T12:00:00.000Z");
  });
  it("refuses stale revisions and dates before event completion or previous availability", () => {
    expect(() => buildRaceConfirmationRevision(make(), history(), "2026-10-25T12:00:00.000Z")).toThrow("changed");
    expect(() => buildRaceConfirmationRevision(make(), null, "2026-09-01T12:00:00.000Z")).toThrow("before the completed event");
    const first = history();
    const input = { ...make({ correctionReason: "Corrected provenance." }, { ...race, confirmationHistory: first }), requestId: "request-two" };
    expect(() => buildRaceConfirmationRevision(input, first, "2026-10-23T12:00:00.000Z")).toThrow("predate");
  });
  it("normalizes server timestamps without inventing a prior known-at", () => {
    const first = history();
    const time = Date.parse("2026-10-24T12:00:00.000Z") / 1000;
    const raw = { ...first, revisions: { "request-one": { ...first.revisions["request-one"], availableAt: { seconds: time, nanoseconds: 0 } } } };
    expect(normalizeRaceConfirmationHistory(raw)?.revisions["request-one"].availableAt).toBe("2026-10-24T12:00:00.000Z");
    expect(raceConfirmationInstant({ _seconds: time, _nanoseconds: 0 })).toBe("2026-10-24T12:00:00.000Z");
    expect(raceConfirmationInstant(null)).toBeNull();
    expect(raceConfirmationInstant("2026-09-20")).toBeNull();
    expect(raceConfirmationInstant({ seconds: time, nanoseconds: 1, toDate: () => new Date(time * 1000) }, true)).toBe("2026-10-24T12:00:00.001Z");
  });
  it("rejects unchanged evidence under a new request ID", () => {
    const first = history();
    const input = { ...make({ correctionReason: "Retrying the same result." }, { ...race, confirmationHistory: first }), requestId: "request-two" };
    expect(() => buildRaceConfirmationRevision(input, first, "2026-10-25T12:00:00.000Z")).toThrow("already confirmed");
  });
  it("keeps a bounded append-only revision history without dropping earlier evidence", () => {
    let previous = history();
    for (let number = 2; number <= 50; number++) {
      const requestId = `request-${String(number).padStart(3, "0")}`;
      const nextInput = { ...make({ source: `https://example.test/results/${number}`, correctionReason: "Corrected source reference." }, { ...race, confirmationHistory: previous }), requestId };
      const revision = buildRaceConfirmationRevision(nextInput, previous, "2026-10-25T12:00:00.000Z");
      previous = { ...previous, currentRevisionId: requestId, revisions: { ...previous.revisions, [requestId]: revision } };
    }
    const nextInput = { ...make({ source: "https://example.test/results/51", correctionReason: "Another correction." }, { ...race, confirmationHistory: previous }), requestId: "request-051" };
    expect(() => buildRaceConfirmationRevision(nextInput, previous, "2026-10-26T12:00:00.000Z")).toThrow("revision limit");
    expect(Object.keys(previous.revisions)).toHaveLength(50);
    expect(previous.revisions["request-one"].observations.workout.durationSeconds).toBe(7871);
  });
  it("retains unresolved receipts as null and invalid history as a fail-closed null", () => {
    const first = history(); first.revisions["request-one"].availableAt = null;
    expect(normalizeRaceConfirmationHistory(first)?.revisions["request-one"].availableAt).toBeNull();
    expect(normalizeRaceConfirmationHistory({ ...first, chronology: "trusted" })).toBeNull();
    expect(() => make({}, { ...race, confirmationHistory: null })).toThrow("invalid");
  });
});
