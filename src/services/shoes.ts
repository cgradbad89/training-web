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

// ─── Shoes ────────────────────────────────────────────────────────────────────

export async function fetchShoes(uid: string): Promise<RunningShoe[]> {
  const snap = await getDocs(collection(db, COLLECTIONS.runningShoes(uid)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as RunningShoe));
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

// ─── Auto-assignment rules ────────────────────────────────────────────────────

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
