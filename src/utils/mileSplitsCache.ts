import {
  collection,
  query,
  orderBy,
  getDocs,
  doc,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { type MileSplitCacheWrite } from "@/utils/mileSplitDocs";

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

/**
 * Persist computed per-mile distance/pace onto the mileSplits subcollection
 * (merge writes — iOS's avgBpm/sampleCount fields are never touched), then
 * refresh the module cache so subsequent reads in this session see the
 * cached splits without a refetch.
 */
export async function saveMileSplitCache(
  uid: string,
  workoutId: string,
  writes: MileSplitCacheWrite[]
): Promise<void> {
  if (writes.length === 0) return;
  const base = `users/${uid}/healthWorkouts/${workoutId}/mileSplits`;

  const batch = writeBatch(db);
  for (const w of writes) {
    batch.set(doc(db, base, w.docId), w.data, { merge: true });
  }
  await batch.commit();

  // Merge into the in-memory cache (matching by doc id; add new docs).
  const cacheKey = `${uid}/${workoutId}`;
  const existing = cache.get(cacheKey);
  if (existing) {
    const byId = new Map(existing.map((d) => [d.id, d]));
    for (const w of writes) {
      byId.set(w.docId, { ...(byId.get(w.docId) ?? { id: w.docId }), ...w.data });
    }
    cache.set(
      cacheKey,
      [...byId.values()].sort(
        (a, b) => ((a.mile as number) ?? 0) - ((b.mile as number) ?? 0)
      )
    );
  }
}
