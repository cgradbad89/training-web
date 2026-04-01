/**
 * HealthWorkout service.
 *
 * Firestore collection: users/{uid}/healthWorkouts
 * Doc ID: workout UUID (from HealthKit)
 *
 * Schema (Firestore field names written by iOS HealthKitSyncService):
 *   workoutId         string   (UUID)
 *   source            string   "healthkit"
 *   activityType      string   raw HK activity type
 *   displayType       string   human-readable type
 *   startDate         Timestamp
 *   endDate           Timestamp
 *   durationSeconds   number
 *   sourceName        string
 *   isRunLike         boolean
 *   hasRoute          boolean
 *   syncedAt          Timestamp
 *   sourceBundle?     string
 *   calories?         number
 *   avgHeartRate?     number
 *   distanceMiles?    number
 *   distanceMeters?   number
 *   avgPaceSecPerMile? number
 *   avgSpeedMPS?      number
 *   hrDriftPct?       number
 *   cadenceSPM?       number
 *   efficiencyRaw?    number
 *   efficiencyScore?  number
 */

import {
  collection,
  doc,
  getDocs,
  getDoc,
  query,
  orderBy,
  limit,
  type QueryConstraint,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { toDate } from "@/utils/dates";
import { type HealthWorkout } from "@/types/healthWorkout";

function docToHealthWorkout(
  id: string,
  data: Record<string, unknown>
): HealthWorkout {
  const displayType = (data.displayType as string) ?? "Workout";
  const distanceMiles = (data.distanceMiles as number) ?? 0;

  return {
    workoutId: (data.workoutId as string) ?? id,
    name: displayType,
    activityType: (data.activityType as string) ?? "",
    displayType,
    startDate: toDate(data.startDate),
    endDate: toDate(data.endDate),
    durationSeconds: (data.durationSeconds as number) ?? 0,
    sourceName: (data.sourceName as string) ?? "Apple Watch",
    isRunLike: (data.isRunLike as boolean) ?? false,
    hasRoute: (data.hasRoute as boolean) ?? false,
    syncedAt: toDate(data.syncedAt),
    sourceBundle: data.sourceBundle as string | undefined,
    calories: (data.calories as number) ?? 0,
    avgHeartRate: (data.avgHeartRate as number | null) ?? null,
    distanceMiles,
    distanceMeters: (data.distanceMeters as number | null) ?? null,
    avgPaceSecPerMile: (data.avgPaceSecPerMile as number | null) ?? null,
    avgSpeedMPS: (data.avgSpeedMPS as number | null) ?? null,
    hrDriftPct: (data.hrDriftPct as number | null) ?? null,
    cadenceSPM: (data.cadenceSPM as number | null) ?? null,
    efficiencyRaw: (data.efficiencyRaw as number | null) ?? null,
    efficiencyScore: (data.efficiencyScore as number | null) ?? null,
  };
}

export async function fetchHealthWorkouts(
  uid: string,
  opts: { limitCount?: number } = {}
): Promise<HealthWorkout[]> {
  const constraints: QueryConstraint[] = [orderBy("startDate", "desc")];
  if (opts.limitCount) constraints.push(limit(opts.limitCount));

  const q = query(
    collection(db, "users", uid, "healthWorkouts"),
    ...constraints
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) =>
    docToHealthWorkout(d.id, d.data() as Record<string, unknown>)
  );
}

export async function fetchHealthWorkout(
  uid: string,
  workoutId: string
): Promise<HealthWorkout | null> {
  const snap = await getDoc(
    doc(db, "users", uid, "healthWorkouts", workoutId)
  );
  if (!snap.exists()) return null;
  return docToHealthWorkout(snap.id, snap.data() as Record<string, unknown>);
}
