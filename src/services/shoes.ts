import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { COLLECTIONS } from "@/lib/firestore";
import { type RunningShoe, type ShoeAssignment, type ShoeAutoAssignmentRule } from "@/types";
import { toDate } from "@/utils/dates";

// ─── Shoes ────────────────────────────────────────────────────────────────────

export async function fetchShoes(uid: string): Promise<RunningShoe[]> {
  const snap = await getDocs(collection(db, COLLECTIONS.runningShoes(uid)));
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      ...data,
      id: d.id,
      purchaseDate: data.purchaseDate
        ? toDate(data.purchaseDate).toISOString().split("T")[0]
        : undefined,
      addedAt: toDate(data.addedAt).toISOString(),
    } as RunningShoe;
  });
}

export async function createShoe(
  uid: string,
  data: Omit<RunningShoe, "id" | "addedAt">
): Promise<string> {
  const id = crypto.randomUUID();
  const shoe: RunningShoe = {
    ...data,
    id,
    addedAt: new Date().toISOString(),
  };
  await setDoc(doc(db, COLLECTIONS.runningShoes(uid), id), shoe);
  return id;
}

export async function updateShoe(
  uid: string,
  shoeId: string,
  data: Partial<RunningShoe>
): Promise<void> {
  await updateDoc(doc(db, COLLECTIONS.runningShoes(uid), shoeId), data as Record<string, unknown>);
}

export async function saveShoe(uid: string, shoe: RunningShoe): Promise<void> {
  await setDoc(doc(db, COLLECTIONS.runningShoes(uid), shoe.id), shoe);
}

export async function deleteShoe(uid: string, shoeId: string): Promise<void> {
  await deleteDoc(doc(db, COLLECTIONS.runningShoes(uid), shoeId));
}

// ─── Manual assignments doc ───────────────────────────────────────────────────
// The "manual" document stores a flat map: { [activityId: string]: shoeId | null }
// This mirrors the iOS RunningShoeAssignmentStore pattern.

export async function fetchManualShoeAssignmentsMap(
  uid: string
): Promise<Record<string, string | null>> {
  const ref = doc(db, COLLECTIONS.shoeAssignments(uid), "manual");
  const snap = await getDoc(ref);
  if (!snap.exists()) return {};
  return snap.data() as Record<string, string | null>;
}

/**
 * Merge-writes partial assignments into the manual doc.
 * Does NOT overwrite unrelated entries — uses { merge: true }.
 */
export async function saveManualAssignments(
  uid: string,
  assignments: Record<string, string | null>
): Promise<void> {
  const ref = doc(db, COLLECTIONS.shoeAssignments(uid), "manual");
  await setDoc(ref, assignments, { merge: true });
}

/**
 * Batch-write multiple activity→shoe assignments.
 * Uses writeBatch for atomicity. Each write is a merge so unrelated
 * entries in the manual doc are not overwritten.
 */
export async function batchAssignShoe(
  uid: string,
  activityIds: number[],
  shoeId: string
): Promise<void> {
  const ref = doc(db, COLLECTIONS.shoeAssignments(uid), "manual");
  const batch = writeBatch(db);
  const payload: Record<string, string> = {};
  for (const id of activityIds) {
    payload[String(id)] = shoeId;
  }
  batch.set(ref, payload, { merge: true });
  await batch.commit();
}

// ─── Assignments ──────────────────────────────────────────────────────────────

export async function fetchShoeAssignments(uid: string): Promise<ShoeAssignment[]> {
  const snap = await getDocs(collection(db, COLLECTIONS.shoeAssignments(uid)));
  return snap.docs.map((d) => d.data() as ShoeAssignment);
}

export async function saveShoeAssignment(
  uid: string,
  assignment: ShoeAssignment
): Promise<void> {
  await setDoc(
    doc(db, COLLECTIONS.shoeAssignments(uid), String(assignment.activityId)),
    assignment
  );
}

// ─── Auto-assignment rules (legacy subcollection — use inline rules on shoe doc instead) ──

export async function fetchAutoAssignmentRules(
  uid: string
): Promise<ShoeAutoAssignmentRule[]> {
  const snap = await getDocs(collection(db, COLLECTIONS.shoeAutoAssignmentRules(uid)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as ShoeAutoAssignmentRule));
}

export async function saveAutoAssignmentRule(
  uid: string,
  rule: ShoeAutoAssignmentRule
): Promise<void> {
  await setDoc(doc(db, COLLECTIONS.shoeAutoAssignmentRules(uid), rule.id), rule);
}

export async function deleteAutoAssignmentRule(
  uid: string,
  ruleId: string
): Promise<void> {
  await deleteDoc(doc(db, COLLECTIONS.shoeAutoAssignmentRules(uid), ruleId));
}
