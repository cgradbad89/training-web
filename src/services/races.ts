import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  updateDoc,
  deleteField,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { COLLECTIONS } from "@/lib/firestore";
import { type Race } from "@/types";
import { type HealthWorkout } from "@/types/healthWorkout";
import { toDate, toLocalIsoDate } from "@/utils/dates";
import { normalizeRaceConfirmationHistory } from "@/utils/raceConfirmation";

/** Preserve invalid history presence so an evaluator cannot fall back to legacy trust. */
export function normalizeRaceDocument(id: string, data: Record<string, unknown>): Race {
  return {
    ...data, id,
    raceDate: toDate(data.raceDate).toISOString().split("T")[0],
    createdAt: toDate(data.createdAt).toISOString(),
    ...(Object.prototype.hasOwnProperty.call(data, "confirmationHistory")
      ? { confirmationHistory: normalizeRaceConfirmationHistory(data.confirmationHistory) } : {}),
  } as Race;
}

function assertOrdinaryRaceFields(data: object): void {
  if (Object.keys(data).some(key => key === "performanceEvidence" || key === "confirmationHistory"
    || key.startsWith("performanceEvidence.") || key.startsWith("confirmationHistory."))) {
    throw new Error("Confirmation evidence can only be saved through the explicit versioned confirmation workflow.");
  }
}

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

export async function fetchRaces(uid: string): Promise<Race[]> {
  const snap = await getDocs(collection(db, COLLECTIONS.halfMarathonRaces(uid)));
  return snap.docs.map((d) => normalizeRaceDocument(d.id, d.data() as Record<string, unknown>));
}

export async function createRace(
  uid: string,
  data: Omit<Race, "id" | "createdAt">
): Promise<string> {
  assertOrdinaryRaceFields(data);
  const id = crypto.randomUUID();
  const race: Race = { ...data, id, createdAt: new Date().toISOString() };
  await setDoc(doc(db, COLLECTIONS.halfMarathonRaces(uid), id), stripUndefined(race));
  return id;
}

export async function updateRace(
  uid: string,
  raceId: string,
  data: Partial<Omit<Race, "id" | "createdAt">>
): Promise<void> {
  assertOrdinaryRaceFields(data);
  const writes = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      value === undefined ? deleteField() : value,
    ])
  );
  await setDoc(
    doc(db, COLLECTIONS.halfMarathonRaces(uid), raceId),
    writes,
    { merge: true }
  );
}

export async function deleteRace(uid: string, raceId: string): Promise<void> {
  await deleteDoc(doc(db, COLLECTIONS.halfMarathonRaces(uid), raceId));
}

/**
 * Atomically sets one race as active and all others as inactive.
 * Fetches all races internally so callers don't need to supply the list.
 */
export async function setActiveRace(uid: string, raceId: string): Promise<void> {
  const races = await fetchRaces(uid);
  const batch = writeBatch(db);
  for (const r of races) {
    batch.update(doc(db, COLLECTIONS.halfMarathonRaces(uid), r.id), {
      isActive: r.id === raceId,
    });
  }
  await batch.commit();
}

// Exhaustive ordinary schema: a newly added Race field must declare full-save
// behavior here. Evidence is owned exclusively by the confirmation workflow.
const ordinaryRaceFields = {
  id: true, name: true, raceDate: true, raceDistance: true,
  customDistanceMiles: true, location: true, targetPaceSecondsPerMile: true,
  linkedStravaActivityId: true, result: true, notes: true, isActive: true,
  createdAt: true, linkedPlanId: true, actualRunId: true, actualRunDate: true,
  actualRunDistanceMiles: true, actualRunDurationSeconds: true, actualRunAvgPace: true,
} satisfies Record<keyof Omit<Race, "performanceEvidence" | "confirmationHistory">, true>;

/** Full-save ordinary fields, preserving independently saved evidence. */
export async function saveRace(uid: string, race: Race): Promise<void> {
  assertOrdinaryRaceFields(race);
  // Explicit deletion preserves full-save clearing without a read/transaction
  // or changes to offline write behavior. Never send evidence, even a stale copy.
  const writes = Object.fromEntries(
    (Object.keys(ordinaryRaceFields) as (keyof typeof ordinaryRaceFields)[])
      .map(key => [key, race[key] === undefined ? deleteField() : race[key]])
  );
  await setDoc(doc(db, COLLECTIONS.halfMarathonRaces(uid), race.id), writes, { merge: true });
}

export async function associateRunWithRace(
  uid: string,
  raceId: string,
  run: HealthWorkout
): Promise<void> {
  await updateRace(uid, raceId, {
    actualRunId: run.workoutId,
    actualRunDate: toLocalIsoDate(run.startDate),
    actualRunDistanceMiles: run.distanceMiles,
    actualRunDurationSeconds: run.durationSeconds,
    actualRunAvgPace: run.avgPaceSecPerMile ?? undefined,
  });
}

export async function disassociateRunFromRace(
  uid: string,
  raceId: string
): Promise<void> {
  await updateDoc(doc(db, COLLECTIONS.halfMarathonRaces(uid), raceId), {
    actualRunId: deleteField(),
    actualRunDate: deleteField(),
    actualRunDistanceMiles: deleteField(),
    actualRunDurationSeconds: deleteField(),
    actualRunAvgPace: deleteField(),
  });
}
