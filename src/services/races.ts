import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { COLLECTIONS } from "@/lib/firestore";
import { type HalfMarathonRace } from "@/types";

export async function fetchRaces(uid: string): Promise<HalfMarathonRace[]> {
  const snap = await getDocs(collection(db, COLLECTIONS.halfMarathonRaces(uid)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as HalfMarathonRace));
}

export async function saveRace(uid: string, race: HalfMarathonRace): Promise<void> {
  await setDoc(doc(db, COLLECTIONS.halfMarathonRaces(uid), race.id), race);
}

export async function deleteRace(uid: string, raceId: string): Promise<void> {
  await deleteDoc(doc(db, COLLECTIONS.halfMarathonRaces(uid), raceId));
}

export async function setActiveRace(
  uid: string,
  raceId: string,
  allRaces: HalfMarathonRace[]
): Promise<void> {
  await Promise.all(
    allRaces.map((r) =>
      updateDoc(doc(db, COLLECTIONS.halfMarathonRaces(uid), r.id), {
        isActive: r.id === raceId,
      })
    )
  );
}
