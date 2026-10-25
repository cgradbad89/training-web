import type { HealthWorkout } from "@/types/healthWorkout";
import type { Race } from "@/types/race";
import type { RaceConfirmationRevision } from "@/types/raceConfirmation";
import { canonicalizePerformanceValue } from "@/utils/performanceEvidence";

/** Entirely synthetic parent summaries and owner submissions; no owner records. */
export function confirmedRaceFixture(options: { id?: string; date?: string; seconds?: number; elapsed?: number; availableAt?: string } = {}) {
  const id = options.id ?? "synthetic-september";
  const raceDate = options.date ?? "2026-09-20";
  const seconds = options.seconds ?? 7_871;
  const start = new Date(`${raceDate}T12:00:00.000Z`);
  const end = new Date(start.getTime() + (options.elapsed ?? seconds) * 1000);
  const workout = { workoutId: `run-${id}`, name: "Synthetic race run", activityType: "running", displayType: "Run",
    startDate: start, endDate: end, syncedAt: new Date(end.getTime() + 3600_000), durationSeconds: seconds,
    distanceMeters: 21_097.5, distanceMiles: 21_097.5 / 1609.344, isRunLike: true, sourceName: "Synthetic watch" } as HealthWorkout;
  const race: Race = { id, name: "Synthetic stored race", raceDate, raceDistance: "halfMarathon", createdAt: "2026-01-01T00:00:00.000Z",
    isActive: false, actualRunId: workout.workoutId, actualRunDate: raceDate, actualRunDurationSeconds: seconds };
  const revision: RaceConfirmationRevision = {
    revisionId: "11111111-1111-4111-8111-111111111111", requestId: "11111111-1111-4111-8111-111111111111",
    revisionNumber: 1, supersedesRevisionId: null, availableAt: options.availableAt ?? "2026-10-24T16:00:00.000Z",
    details: { officialEventName: "Synthetic official event", raceDate, distanceMeters: 21_097.5, finishSeconds: seconds,
      timeBasis: "chip", status: "verified", kind: "official_race", effort: "maximal", conditions: "Flat, mild, no limitations",
      source: "https://results.example.test/result", timingReconciliation: null, linkedWorkoutId: workout.workoutId },
    correctionReason: null,
    observations: { timeZone: "America/New_York", race: { id, name: race.name, raceDate, raceDistance: "halfMarathon", customDistanceMiles: null,
      actualRunId: workout.workoutId, actualRunDate: raceDate, actualRunDistanceMiles: null, actualRunDurationSeconds: seconds,
      result: null, createdAt: race.createdAt, performanceEvidence: null }, workout: { workoutId: workout.workoutId, startDate: start.toISOString(),
      endDate: end.toISOString(), syncedAt: workout.syncedAt.toISOString(), durationSeconds: seconds, distanceMeters: 21_097.5,
      distanceMiles: workout.distanceMiles, isRunLike: true, activityType: "running" }, override: null },
    snapshotToken: "synthetic-original-observations",
  };
  revision.snapshotToken = canonicalizePerformanceValue(revision.observations);
  race.confirmationHistory = { schemaVersion: 1, chronology: "client_document_untrusted", currentRevisionId: revision.revisionId,
    revisions: { [revision.revisionId]: revision } };
  return { race, workout, revision };
}

export function correctRaceFixture(race: Race, updates: Partial<RaceConfirmationRevision["details"]>, availableAt: string) {
  const history = race.confirmationHistory!;
  const previous = history.revisions[history.currentRevisionId];
  const revision: RaceConfirmationRevision = { ...structuredClone(previous), revisionId: "22222222-2222-4222-8222-222222222222",
    requestId: "22222222-2222-4222-8222-222222222222", revisionNumber: previous.revisionNumber + 1,
    supersedesRevisionId: previous.revisionId, availableAt, correctionReason: "Synthetic source correction",
    details: { ...previous.details, ...updates } };
  race.confirmationHistory = { ...history, currentRevisionId: revision.revisionId,
    revisions: { ...history.revisions, [revision.revisionId]: revision } };
  return revision;
}
