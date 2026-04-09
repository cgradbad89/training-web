import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  type Plan,
  type RunningPlan,
  isRunningPlan,
  isWorkoutPlan,
} from "@/types/plan";
import { toDate } from "@/utils/dates";

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

const plansPath = (uid: string) => `users/${uid}/plans`;

export async function fetchPlans(uid: string): Promise<Plan[]> {
  const snap = await getDocs(collection(db, plansPath(uid)));
  return snap.docs.map((d) => {
    const data = d.data();
    // Backward compat: documents written before Phase 1 have no planType.
    // Default to "running" so existing plans continue to work unchanged.
    const planType = (data.planType as string | undefined) ?? "running";
    return {
      ...data,
      id: d.id,
      planType,
      startDate: toDate(data.startDate).toISOString().split("T")[0],
      createdAt: toDate(data.createdAt).toISOString(),
    } as Plan;
  });
}

export async function savePlan(uid: string, plan: Plan): Promise<void> {
  await setDoc(doc(db, plansPath(uid), plan.id), stripUndefined(plan));
}

export async function createPlan<T extends Plan>(
  uid: string,
  data: Omit<T, "id" | "createdAt" | "updatedAt">
): Promise<T> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const plan = { ...data, id, createdAt: now, updatedAt: now } as T;
  await setDoc(doc(db, plansPath(uid), id), stripUndefined(plan));
  return plan;
}

export async function updatePlan(uid: string, plan: Plan): Promise<void> {
  const updated = { ...plan, updatedAt: new Date().toISOString() };
  await setDoc(doc(db, plansPath(uid), plan.id), stripUndefined(updated));
}

export async function deletePlan(uid: string, planId: string): Promise<void> {
  await deleteDoc(doc(db, plansPath(uid), planId));
}

/**
 * Atomically sets one plan as active, deactivating other plans of the
 * SAME TYPE. Running and Workout plans are independent — activating a
 * workout plan does not affect the active running plan and vice versa.
 *
 * Legacy pilates plans are always deactivated (we no longer honor an
 * active flag on them since the type is unsupported).
 */
export async function setActivePlan(
  uid: string,
  planId: string,
  allPlans: Plan[]
): Promise<void> {
  const target = allPlans.find((p) => p.id === planId);
  if (!target) return;
  const targetIsRunning = isRunningPlan(target);
  const targetIsWorkout = isWorkoutPlan(target);

  const batch = writeBatch(db);
  for (const p of allPlans) {
    // Only touch plans of the same type as the one being activated.
    // Plans of other types keep their current isActive value.
    const sameType =
      (targetIsRunning && isRunningPlan(p)) ||
      (targetIsWorkout && isWorkoutPlan(p));
    if (!sameType) continue;
    batch.update(
      doc(db, plansPath(uid), p.id),
      stripUndefined({ isActive: p.id === planId })
    );
  }
  await batch.commit();
}

/**
 * Backward-compatible helper: most existing call sites only know about
 * RunningPlan and pass it to update. Allows them to keep working unchanged.
 */
export type RunningPlanInput = Omit<RunningPlan, "id" | "createdAt" | "updatedAt">;
