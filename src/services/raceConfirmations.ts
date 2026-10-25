import { getIdTokenResult, type User } from "firebase/auth";
import { doc, getDocFromServer, runTransaction, serverTimestamp } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { isAuthorizedTrainingUser } from "@/lib/trainingAuthorization";
import { isRacePerformanceEnabled } from "@/lib/racePerformanceGate";
import { canonicalizePerformanceValue } from "@/utils/performanceEvidence";
import { buildRaceConfirmationRevision, buildRaceConfirmationSnapshot, isRaceConfirmationDocumentId, MAX_RACE_CONFIRMATION_BYTES, normalizeRaceConfirmationHistory, validateRaceConfirmationInput } from "@/utils/raceConfirmation";
import { normalizeRaceDocument } from "@/services/races";
import type { HealthWorkout } from "@/types/healthWorkout";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { Race } from "@/types/race";
import type { RaceConfirmationHistory, RaceConfirmationRevision, SaveRaceConfirmationInput } from "@/types/raceConfirmation";

export class RaceConfirmationConflictError extends Error {
  constructor(message = "Race, linked workout, overrides or confirmation changed. Reload the race and review the current observations before submitting.") {
    super(message); this.name = "RaceConfirmationConflictError";
  }
}

function assertSession(uid: string, user: User | null): asserts user is User {
  if (!isRacePerformanceEnabled()) throw new Error("Race confirmation is disabled outside opted-in development/preview builds.");
  if (!isRaceConfirmationDocumentId(uid) || !user || auth.currentUser !== user || user.uid !== uid
    || !isAuthorizedTrainingUser(user.email, user.emailVerified)) throw new Error("Race confirmation requires the current verified owner session.");
}

function matchesRequest(revision: RaceConfirmationRevision, input: SaveRaceConfirmationInput): boolean {
  return canonicalizePerformanceValue({
    raceId: revision.observations.race.id, requestId: revision.requestId, expectedRevisionId: revision.supersedesRevisionId,
    snapshotToken: revision.snapshotToken, observations: revision.observations, details: revision.details, correctionReason: revision.correctionReason,
  }) === canonicalizePerformanceValue(input);
}

/** Explicit, online-only owner action. Reads three existing parent documents and
 * writes only new nested confirmation fields in the existing race document.
 * No workout/override mutation, new collection, offline queue or child read.
 * Current rules cannot enforce historical immutability: chronology stays untrusted. */
export async function saveRaceConfirmation(uid: string, supplied: SaveRaceConfirmationInput): Promise<Race> {
  const user = auth.currentUser;
  assertSession(uid, user);
  // Detach caller-owned input before the first await; retries use the exact same payload.
  const input = JSON.parse(canonicalizePerformanceValue(supplied)) as SaveRaceConfirmationInput;
  validateRaceConfirmationInput(input);
  if (Date.parse(input.observations.workout.endDate) > Date.now()) throw new Error("Only completed historical events can be confirmed.");
  if (Date.parse(input.observations.race.performanceEvidence?.knownAt ?? "") > Date.now()) throw new Error("Existing confirmation chronology is in the future; it cannot be replaced by an earlier receipt.");
  const token = await getIdTokenResult(user, true);
  assertSession(uid, user);
  if (token.claims.sub !== uid || !isAuthorizedTrainingUser(
    typeof token.claims.email === "string" ? token.claims.email : null, token.claims.email_verified === true,
  )) throw new Error("Race confirmation requires a refreshed verified owner token.");
  const reference = doc(db, "users", uid, "halfMarathonRaces", input.raceId);
  await runTransaction(db, async transaction => {
    assertSession(uid, user);
    const raceSnapshot = await transaction.get(reference);
    assertSession(uid, user);
    if (!raceSnapshot.exists()) throw new RaceConfirmationConflictError("The race no longer exists. Confirmation cannot recreate it.");
    const rawRace = raceSnapshot.data();
    const race = normalizeRaceDocument(raceSnapshot.id, rawRace);
    let previous: RaceConfirmationHistory | null = null;
    if (Object.prototype.hasOwnProperty.call(rawRace, "confirmationHistory")) {
      previous = normalizeRaceConfirmationHistory(rawRace.confirmationHistory);
      if (!previous) throw new RaceConfirmationConflictError("Saved confirmation history is invalid; it must not be overwritten.");
    }
    const existing = previous?.revisions[input.requestId];
    if (existing) {
      if (!matchesRequest(existing, input)) throw new RaceConfirmationConflictError("This confirmation request ID already belongs to different evidence.");
      return; // An acknowledged or previously committed retry adds no revision/write.
    }
    const priorReceipt = previous?.revisions[previous.currentRevisionId]?.availableAt;
    if (priorReceipt && Date.parse(priorReceipt) > Date.now()) throw new RaceConfirmationConflictError("Existing confirmation receipt is in the future. It cannot be replaced with an earlier receipt.");
    if ((previous?.currentRevisionId ?? null) !== input.expectedRevisionId || race.actualRunId !== input.details.linkedWorkoutId) throw new RaceConfirmationConflictError();
    const workoutReference = doc(db, "users", uid, "healthWorkouts", input.details.linkedWorkoutId);
    const overrideReference = doc(db, "users", uid, "workoutOverrides", input.details.linkedWorkoutId);
    const [workoutSnapshot, overrideSnapshot] = await Promise.all([transaction.get(workoutReference), transaction.get(overrideReference)]);
    assertSession(uid, user);
    if (!workoutSnapshot.exists()) throw new RaceConfirmationConflictError("The linked workout no longer exists.");
    const rawWorkout = workoutSnapshot.data();
    const workout = {
      ...rawWorkout, workoutId: rawWorkout.workoutId ?? workoutSnapshot.id,
      // Match the existing parent loader's display defaults; missing required
      // distance/duration/dates are still rejected by confirmation validation.
      activityType: rawWorkout.activityType ?? "", distanceMiles: rawWorkout.distanceMiles ?? 0,
      durationSeconds: rawWorkout.durationSeconds ?? 0, distanceMeters: rawWorkout.distanceMeters ?? null,
      syncedAt: rawWorkout.syncedAt ?? new Date(0),
    } as HealthWorkout;
    const override = overrideSnapshot.exists() ? overrideSnapshot.data() as WorkoutOverride : null;
    if (override && override.userId !== uid) throw new RaceConfirmationConflictError("The linked override belongs to a different identity.");
    const current = buildRaceConfirmationSnapshot(race, workout, override, input.observations.timeZone);
    if (current.snapshotToken !== input.snapshotToken) throw new RaceConfirmationConflictError();
    const revision = buildRaceConfirmationRevision(input, previous, null);
    const next: RaceConfirmationHistory = {
      schemaVersion: 1, chronology: "client_document_untrusted", currentRevisionId: revision.revisionId,
      revisions: { ...previous?.revisions, [revision.revisionId]: revision },
    };
    if (new TextEncoder().encode(canonicalizePerformanceValue(next)).length > MAX_RACE_CONFIRMATION_BYTES) throw new Error("Confirmation history storage limit reached; existing evidence must not be discarded.");
    assertSession(uid, user);
    // Field updates append only this revision; original timestamp objects and
    // legacy race/workout observations remain byte-for-byte untouched.
    transaction.update(reference, {
      "confirmationHistory.schemaVersion": 1,
      "confirmationHistory.chronology": "client_document_untrusted",
      "confirmationHistory.currentRevisionId": revision.revisionId,
      [`confirmationHistory.revisions.${revision.revisionId}`]: { ...revision, availableAt: serverTimestamp() },
    });
  });
  assertSession(uid, user);
  // Resolve the server timestamp; never publish a browser-estimated known-at.
  // A failed acknowledgement/read is safely retried with the same request ID.
  const saved = await getDocFromServer(reference);
  assertSession(uid, user);
  if (!saved.exists()) throw new RaceConfirmationConflictError("The saved race is no longer available.");
  const result = normalizeRaceDocument(saved.id, saved.data());
  if (!result.confirmationHistory?.revisions[input.requestId]?.availableAt) throw new Error("Confirmation was submitted but its receipt time is unresolved. Reload or retry the same request before using this evidence.");
  return result;
}
