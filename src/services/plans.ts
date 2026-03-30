import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { COLLECTIONS } from "@/lib/firestore";
import { type RunningPlan } from "@/types";

export async function fetchPlans(uid: string): Promise<RunningPlan[]> {
  const snap = await getDocs(collection(db, COLLECTIONS.runningPlans(uid)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as RunningPlan));
}

export async function savePlan(uid: string, plan: RunningPlan): Promise<void> {
  await setDoc(doc(db, COLLECTIONS.runningPlans(uid), plan.id), plan);
}

export async function deletePlan(uid: string, planId: string): Promise<void> {
  await deleteDoc(doc(db, COLLECTIONS.runningPlans(uid), planId));
}

export async function setActivePlan(
  uid: string,
  planId: string,
  allPlans: RunningPlan[]
): Promise<void> {
  // Only one plan can be active at a time
  await Promise.all(
    allPlans.map((p) =>
      updateDoc(doc(db, COLLECTIONS.runningPlans(uid), p.id), {
        isActive: p.id === planId,
      })
    )
  );
}
