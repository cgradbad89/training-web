/**
 * hrStream service.
 *
 * Firestore subcollection: users/{uid}/healthWorkouts/{workoutId}/hrStream/{chunkIndex}
 *
 * Written by iOS (MEA repo, commit 3715519) for ALL workouts that have in-window
 * HR samples — per-sample heart rate streamed as chunked documents so non-route
 * workouts (HIIT, OTF, strength) can be scored from the per-sample integral
 * instead of a coarse whole-run avg.
 *
 * Cross-repo contract (MEA WORKOUTS_WEB_HANDOFF.md — do not alter):
 *   - chunkIndex doc id: zero-padded "%04d".
 *   - doc shape: { chunkIndex: Int, samples: [ { t: Timestamp, hr: Int } ] }.
 *   - Chunks are globally time-ordered; read ascending by chunkIndex and
 *     concatenate each doc's samples array in order.
 *   - Each sample: t = Firestore Timestamp, hr = Int bpm (never null in a stream).
 *   - Parent healthWorkouts doc carries hasHRStream === true when a stream exists;
 *     absent/false ⇒ no stream (the subcollection has no docs).
 *
 * Mirrors the fetchRoutePoints service pattern (auth/error handling, ascending
 * order read, Timestamp → ISO mapping).
 */

import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase";

export interface HRStreamSample {
  /** ISO string — Timestamp.toDate().toISOString() */
  timestamp: string;
  hr: number;
}

interface RawStreamSample {
  t?: { toDate?: () => Date } | null;
  hr?: number;
}

export async function fetchHRStream(
  uid: string,
  workoutId: string
): Promise<HRStreamSample[]> {
  const ref = collection(
    db,
    "users",
    uid,
    "healthWorkouts",
    workoutId,
    "hrStream"
  );
  const q = query(ref, orderBy("chunkIndex", "asc"));
  const snap = await getDocs(q);

  const out: HRStreamSample[] = [];
  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>;
    const samples = Array.isArray(data.samples)
      ? (data.samples as RawStreamSample[])
      : [];
    for (const s of samples) {
      out.push({
        timestamp: s.t?.toDate?.()?.toISOString() ?? "",
        hr: (s.hr as number) ?? 0,
      });
    }
  }
  return out;
}
