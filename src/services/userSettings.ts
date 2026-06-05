import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { COLLECTIONS } from "@/lib/firestore";
import { type UserSettings } from "@/types";
import { fetchRoutePoints } from "@/services/routes";

const PREFS_DOC = "prefs";
const DEFAULT_MAX_RUNS_FOR_HR_GATHER = 30;

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

function parseOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function docToUserSettings(data: Record<string, unknown>): UserSettings {
  return {
    uid: (data.uid as string) ?? "",
    displayName: data.displayName as string | undefined,
    email: data.email as string | undefined,
    weightThresholdGreen:
      parseOptionalNumber(data.weightThresholdGreen) ?? 173,
    weightThresholdYellow:
      parseOptionalNumber(data.weightThresholdYellow) ?? 180,
    defaultTargetPaceSecPerMile:
      parseOptionalNumber(data.defaultTargetPaceSecPerMile) ?? 600,
    maxHeartRate: parseOptionalNumber(data.maxHeartRate),
    restingHeartRate: parseOptionalNumber(data.restingHeartRate),
    thresholdPaceSecPerMile: parseOptionalNumber(
      data.thresholdPaceSecPerMile
    ),
    suggestedMaxHeartRate: parseOptionalNumber(data.suggestedMaxHeartRate),
    suggestedThresholdPaceSecPerMile: parseOptionalNumber(
      data.suggestedThresholdPaceSecPerMile
    ),
    suggestionsUpdatedAt: data.suggestionsUpdatedAt as
      | UserSettings["suggestionsUpdatedAt"]
      | undefined,
    createdAt: (data.createdAt as string) ?? "",
    updatedAt: (data.updatedAt as string) ?? "",
  };
}

export async function fetchUserSettings(uid: string): Promise<UserSettings | null> {
  const ref = doc(db, COLLECTIONS.userSettings(uid), PREFS_DOC);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return docToUserSettings(snap.data() as Record<string, unknown>);
}

export async function saveUserSettings(
  uid: string,
  settings: Partial<UserSettings>
): Promise<void> {
  const ref = doc(db, COLLECTIONS.userSettings(uid), PREFS_DOC);
  await setDoc(
    ref,
    stripUndefined({
      ...settings,
      uid,
      updatedAt: new Date().toISOString(),
    }),
    { merge: true }
  );
}

export async function saveUserSettingsSuggestions(
  uid: string,
  suggestions: Pick<
    UserSettings,
    "suggestedMaxHeartRate" | "suggestedThresholdPaceSecPerMile"
  >
): Promise<void> {
  const ref = doc(db, COLLECTIONS.userSettings(uid), PREFS_DOC);
  await setDoc(
    ref,
    {
      ...stripUndefined(suggestions),
      uid,
      updatedAt: new Date().toISOString(),
      suggestionsUpdatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function gatherRecentRunHr(
  uid: string,
  maxRuns = DEFAULT_MAX_RUNS_FOR_HR_GATHER
): Promise<number[]> {
  const q = query(
    collection(db, "users", uid, "healthWorkouts"),
    where("isRunLike", "==", true),
    where("hasRoute", "==", true),
    orderBy("startDate", "desc"),
    limit(maxRuns)
  );
  const snap = await getDocs(q);
  const hrValues: number[] = [];

  for (const workoutDoc of snap.docs) {
    const points = await fetchRoutePoints(uid, workoutDoc.id);
    for (const point of points) {
      if (point.hr != null) hrValues.push(point.hr);
    }
  }

  return hrValues;
}
