import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { type RunningPlan } from "@/types";

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

const plansPath = (uid: string) => `users/${uid}/plans`;

export async function fetchPlans(uid: string): Promise<RunningPlan[]> {
  const snap = await getDocs(collection(db, plansPath(uid)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as RunningPlan));
}

export async function savePlan(uid: string, plan: RunningPlan): Promise<void> {
  await setDoc(doc(db, plansPath(uid), plan.id), stripUndefined(plan));
}

export async function createPlan(
  uid: string,
  data: Omit<RunningPlan, "id" | "createdAt" | "updatedAt">
): Promise<RunningPlan> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const plan: RunningPlan = { ...data, id, createdAt: now, updatedAt: now };
  await setDoc(doc(db, plansPath(uid), id), stripUndefined(plan));
  return plan;
}

export async function updatePlan(
  uid: string,
  plan: RunningPlan
): Promise<void> {
  const updated = { ...plan, updatedAt: new Date().toISOString() };
  await setDoc(doc(db, plansPath(uid), plan.id), stripUndefined(updated));
}

export async function deletePlan(uid: string, planId: string): Promise<void> {
  await deleteDoc(doc(db, plansPath(uid), planId));
}

/**
 * Atomically sets one plan as active and deactivates all others.
 * Uses writeBatch for atomicity.
 */
export async function setActivePlan(
  uid: string,
  planId: string,
  allPlans: RunningPlan[]
): Promise<void> {
  const batch = writeBatch(db);
  for (const p of allPlans) {
    batch.update(doc(db, plansPath(uid), p.id), stripUndefined({ isActive: p.id === planId }));
  }
  await batch.commit();
}
