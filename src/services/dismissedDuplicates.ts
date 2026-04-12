/**
 * Persistent storage for dismissed duplicate workout suggestions.
 *
 * Collection: users/{uid}/dismissedDuplicates/{docId}
 * docId is deterministic: sort the two workout IDs alphabetically and join with "_".
 * This ensures the same pair always maps to the same document regardless of order.
 */

import {
  collection,
  doc,
  getDocs,
  setDoc,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

const basePath = (uid: string) => `users/${uid}/dismissedDuplicates`;

/** Build a deterministic doc ID for a pair of workout IDs. */
export function dismissedPairKey(id1: string, id2: string): string {
  return [id1, id2].sort().join("_");
}

/** Fetch all dismissed pair keys as a Set. One-time read — not a listener. */
export async function fetchDismissedDuplicates(uid: string): Promise<Set<string>> {
  const snap = await getDocs(collection(db, basePath(uid)));
  return new Set(snap.docs.map((d) => d.id));
}

/** Write a dismissed pair to Firestore. Idempotent — overwrites if doc exists. */
export async function dismissDuplicate(
  uid: string,
  workoutId1: string,
  workoutId2: string
): Promise<void> {
  const docId = dismissedPairKey(workoutId1, workoutId2);
  await setDoc(doc(db, basePath(uid), docId), {
    workoutId1,
    workoutId2,
    dismissedAt: serverTimestamp(),
  });
}
