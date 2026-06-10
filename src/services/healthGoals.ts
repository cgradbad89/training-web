import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  setDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { DayOfWeekGoals, HealthGoalDoc } from "@/types/healthGoal";

export type { DayOfWeekGoals, HealthGoalDoc };

// Mirrors the read/parse + stripUndefined pattern of src/services/goals.ts.
function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

// healthGoals — Firestore security rule must match this exact path.
// NOT the same as users/{uid}/goals (running goals) or
// users/{uid}/settings/healthGoals (threshold goals for KPI coloring).
const healthGoalsCollection = (uid: string) =>
  collection(db, `users/${uid}/healthGoals`);

/**
 * Fetch every healthGoals version for a user, ordered by effectiveFrom
 * ascending. Callers resolve which version applies to a given date with
 * resolveGoalForDate() in src/lib/ringMath.ts.
 */
export async function fetchHealthGoals(uid: string): Promise<HealthGoalDoc[]> {
  const snap = await getDocs(
    query(healthGoalsCollection(uid), orderBy("effectiveFrom", "asc"))
  );
  return snap.docs.map((d) => d.data() as HealthGoalDoc);
}

/**
 * Save a NEW goal version document. History is effective-dated and
 * append-only: prior versions are never overwritten or deleted, so past
 * days keep scoring against the goal that was active at the time.
 */
export async function saveHealthGoals(
  uid: string,
  goalDoc: HealthGoalDoc
): Promise<void> {
  const id = crypto.randomUUID();
  await setDoc(
    doc(db, `users/${uid}/healthGoals`, id),
    stripUndefined(goalDoc)
  );
}
