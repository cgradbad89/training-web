import { collection, query, orderBy, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";

export interface MileSplitDoc {
  id: string;
  [key: string]: unknown;
}

const cache = new Map<string, MileSplitDoc[]>();
const inFlight = new Map<string, Promise<MileSplitDoc[]>>();

/**
 * Get mile splits from cache or fetch them.
 * Deduplicates concurrent requests for the same workoutId.
 */
export async function getMileSplits(
  uid: string,
  workoutId: string
): Promise<MileSplitDoc[]> {
  const cacheKey = `${uid}/${workoutId}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey)!;
  }

  const promise = getDocs(
    query(
      collection(db, `users/${uid}/healthWorkouts/${workoutId}/mileSplits`),
      orderBy("mile", "asc")
    )
  )
    .then((snap) => {
      const docs = snap.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      cache.set(cacheKey, docs);
      inFlight.delete(cacheKey);
      return docs;
    })
    .catch((err) => {
      inFlight.delete(cacheKey);
      throw err;
    });

  inFlight.set(cacheKey, promise);
  return promise;
}
