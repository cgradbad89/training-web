import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { COLLECTIONS } from "@/lib/firestore";
import { type Race } from "@/types";
import { toDate } from "@/utils/dates";

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

export async function fetchRaces(uid: string): Promise<Race[]> {
  const snap = await getDocs(collection(db, COLLECTIONS.halfMarathonRaces(uid)));
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      ...data,
      id: d.id,
      raceDate: toDate(data.raceDate).toISOString().split("T")[0],
      createdAt: toDate(data.createdAt).toISOString(),
    } as Race;
  });
}

export async function createRace(
  uid: string,
  data: Omit<Race, "id" | "createdAt">
): Promise<string> {
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
  await setDoc(
    doc(db, COLLECTIONS.halfMarathonRaces(uid), raceId),
    stripUndefined(data),
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

/** Legacy full-save helper — kept for backward compat */
export async function saveRace(uid: string, race: Race): Promise<void> {
  await setDoc(doc(db, COLLECTIONS.halfMarathonRaces(uid), race.id), race);
}
