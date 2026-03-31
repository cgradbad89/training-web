import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { COLLECTIONS } from "@/lib/firestore";
import { type RunningShoe, type ShoeAssignment, type ShoeAutoAssignmentRule } from "@/types";
import { toDate } from "@/utils/dates";

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

// ─── Shoes ────────────────────────────────────────────────────────────────────

export async function fetchShoes(uid: string): Promise<RunningShoe[]> {
  const snap = await getDocs(collection(db, `users/${uid}/shoes`));
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
  await setDoc(doc(db, `users/${uid}/shoes`, id), stripUndefined(shoe));
  return id;
}

export async function updateShoe(
  uid: string,
  shoeId: string,
  data: Partial<RunningShoe>
): Promise<void> {
  await updateDoc(doc(db, `users/${uid}/shoes`, shoeId), stripUndefined(data) as Record<string, unknown>);
}

export async function saveShoe(uid: string, shoe: RunningShoe): Promise<void> {
  await setDoc(doc(db, `users/${uid}/shoes`, shoe.id), shoe);
}

export async function deleteShoe(uid: string, shoeId: string): Promise<void> {
  await deleteDoc(doc(db, `users/${uid}/shoes`, shoeId));
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
  await setDoc(ref, stripUndefined(assignments), { merge: true });
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
