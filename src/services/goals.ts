import {
  collection,
  doc,
  getDocs,
  setDoc,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { COLLECTIONS } from "@/lib/firestore";
import { type RunningGoal } from "@/types/goal";

// Mirrors the read/parse + stripUndefined pattern of src/services/races.ts.
function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

/**
 * Fetch all goals (active and soft-deleted) for a user. createdAt/updatedAt
 * remain Firestore Timestamps, matching the RunningGoal type. Callers decide
 * how to filter isActive.
 */
export async function fetchGoals(uid: string): Promise<RunningGoal[]> {
  const snap = await getDocs(collection(db, COLLECTIONS.goals(uid)));
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      ...data,
      id: d.id,
    } as RunningGoal;
  });
}

export async function createGoal(
  uid: string,
  goal: Omit<RunningGoal, "id" | "createdAt" | "updatedAt">
): Promise<string> {
  const id = crypto.randomUUID();
  // stripUndefined only the plain user fields; server timestamps are added
  // afterwards so the JSON-based strip can't corrupt the Timestamp sentinels.
  await setDoc(doc(db, COLLECTIONS.goals(uid), id), {
    ...stripUndefined(goal),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return id;
}

export async function updateGoal(
  uid: string,
  goalId: string,
  patch: Partial<RunningGoal>
): Promise<void> {
  // Never let id/createdAt/updatedAt flow through the JSON strip (would corrupt
  // Timestamps); updatedAt is always refreshed server-side.
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = patch;
  void _id;
  void _c;
  void _u;
  await setDoc(
    doc(db, COLLECTIONS.goals(uid), goalId),
    {
      ...stripUndefined(rest),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

/** Soft delete: set isActive = false. Never hard-delete the document. */
export async function softDeleteGoal(
  uid: string,
  goalId: string
): Promise<void> {
  await updateGoal(uid, goalId, { isActive: false });
}
