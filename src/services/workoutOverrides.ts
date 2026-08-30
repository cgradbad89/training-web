import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { type WorkoutOverride } from "@/types/workoutOverride";

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

const overridePath = (uid: string, workoutId: string) =>
  `users/${uid}/workoutOverrides/${workoutId}`;

export async function fetchOverride(
  uid: string,
  workoutId: string
): Promise<WorkoutOverride | null> {
  const snap = await getDoc(doc(db, overridePath(uid, workoutId)));
  if (!snap.exists()) return null;
  return snap.data() as WorkoutOverride;
}

export async function fetchAllOverrides(
  uid: string
): Promise<Record<string, WorkoutOverride>> {
  const snap = await getDocs(
    collection(db, `users/${uid}/workoutOverrides`)
  );
  const result: Record<string, WorkoutOverride> = {};
  snap.docs.forEach((d) => {
    result[d.id] = d.data() as WorkoutOverride;
  });
  return result;
}

export async function saveOverride(
  uid: string,
  override: WorkoutOverride
): Promise<WorkoutOverride> {
  const ref = doc(db, overridePath(uid, override.workoutId));
  const persisted = stripUndefined({
    ...override,
    updatedAt: new Date().toISOString(),
  });
  await setDoc(ref, persisted);
  return persisted;
}

export async function deleteOverride(
  uid: string,
  workoutId: string
): Promise<void> {
  await deleteDoc(doc(db, overridePath(uid, workoutId)));
}

export async function excludeWorkout(
  uid: string,
  workoutId: string,
  reason?: string
): Promise<WorkoutOverride> {
  const existing = await fetchOverride(uid, workoutId);
  return saveOverride(uid, {
    workoutId,
    userId: uid,
    isExcluded: true,
    excludedAt: new Date().toISOString(),
    excludedReason: reason ?? null,
    distanceMilesOverride: existing?.distanceMilesOverride ?? null,
    durationSecondsOverride: existing?.durationSecondsOverride ?? null,
    runTypeOverride: existing?.runTypeOverride ?? null,
    updatedAt: new Date().toISOString(),
  });
}

export async function restoreWorkout(
  uid: string,
  workoutId: string
): Promise<WorkoutOverride | null> {
  const existing = await fetchOverride(uid, workoutId);
  if (!existing) return null;

  // If no other overrides exist, delete the doc entirely
  const hasOtherOverrides =
    existing.distanceMilesOverride != null ||
    existing.durationSecondsOverride != null ||
    existing.runTypeOverride != null;

  if (hasOtherOverrides) {
    return saveOverride(uid, {
      ...existing,
      isExcluded: false,
      excludedAt: null,
      excludedReason: null,
    });
  }

  await deleteOverride(uid, workoutId);
  return null;
}
