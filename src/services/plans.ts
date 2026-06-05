import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  type Plan,
  type PlanStatus,
  type RunningPlan,
  isRunningPlan,
  isWorkoutPlan,
  derivePlanStatus,
  isActiveFromStatus,
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
    // status is the in-app source of truth; legacy docs derive it from isActive.
    // isActive is normalized from the resolved status so the in-memory object is
    // internally consistent. NO write-back here — Firestore stays as-is until a
    // normal edit re-saves the doc.
    const status = derivePlanStatus(data);
    return {
      ...data,
      id: d.id,
      planType,
      status,
      isActive: isActiveFromStatus(status),
      startDate: toDate(data.startDate).toISOString().split("T")[0],
      createdAt: toDate(data.createdAt).toISOString(),
    } as Plan;
  });
}

export async function fetchPlan(uid: string, planId: string): Promise<Plan | null> {
  const snap = await getDoc(doc(db, plansPath(uid), planId));
  if (!snap.exists()) return null;
  const data = snap.data();
  const planType = (data.planType as string | undefined) ?? "running";
  const status = derivePlanStatus(data);
  return {
    ...data,
    id: snap.id,
    planType,
    status,
    isActive: isActiveFromStatus(status),
    startDate: toDate(data.startDate).toISOString().split("T")[0],
    createdAt: toDate(data.createdAt).toISOString(),
  } as Plan;
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
 * Pure: the fields to merge for a completion-state change.
 *   - "complete" → { status:"completed", isActive:false, completedAt: nowIso }
 *   - "reopen"   → { status:"draft",     isActive:false, completedAt: undefined }
 * Both clear the active flag (completing clears active; reopening returns the
 * plan to draft, never straight back to active). completedAt:undefined is
 * dropped by stripUndefined on write, which removes the field on reopen.
 * `nowIso` is a parameter so the transition is deterministic in tests.
 */
export function planCompletionPatch(
  action: "complete" | "reopen",
  nowIso: string = new Date().toISOString()
): { status: PlanStatus; isActive: boolean; completedAt: string | undefined } {
  if (action === "complete") {
    return { status: "completed", isActive: false, completedAt: nowIso };
  }
  return { status: "draft", isActive: false, completedAt: undefined };
}

/**
 * Persist a completion-state change for a SINGLE plan. Self-only — unlike
 * setActivePlan it never touches sibling plans (completing merely clears its
 * own active flag; it does not promote another plan to active). status and
 * isActive are always written together (dual-write invariant). Returns the
 * merged plan for optimistic local update.
 */
export async function setPlanCompletion(
  uid: string,
  plan: Plan,
  action: "complete" | "reopen"
): Promise<Plan> {
  const merged = { ...plan, ...planCompletionPatch(action) } as Plan;
  await updatePlan(uid, merged);
  return merged;
}

/**
 * Pure decision for what a same-type plan's status+isActive should become when
 * `targetId` is being activated.
 *   - The target itself          → { status: "active",  isActive: true }
 *   - A sibling that's "completed" → null (LEAVE UNCHANGED — don't un-complete it)
 *   - Any other sibling           → { status: "draft",  isActive: false }
 * Returning null means "write nothing for this plan", which preserves the
 * ≤1-active-per-type invariant without demoting a completed plan.
 */
export function nextStatusForSibling(
  plan: { id: string; status: PlanStatus },
  targetId: string
): { status: PlanStatus; isActive: boolean } | null {
  if (plan.id === targetId) return { status: "active", isActive: true };
  if (plan.status === "completed") return null;
  return { status: "draft", isActive: false };
}

/**
 * Atomically sets one plan as active, deactivating other plans of the
 * SAME TYPE. Running and Workout plans are independent — activating a
 * workout plan does not affect the active running plan and vice versa.
 *
 * Dual-writes status (in-app truth) and isActive (iOS mirror) together. A
 * same-type sibling that is already "completed" is left untouched so
 * activating another plan never silently un-completes it.
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
    // Plans of other types keep their current status/isActive value.
    const sameType =
      (targetIsRunning && isRunningPlan(p)) ||
      (targetIsWorkout && isWorkoutPlan(p));
    if (!sameType) continue;
    const next = nextStatusForSibling(p, planId);
    if (!next) continue; // completed sibling — leave unchanged
    batch.update(doc(db, plansPath(uid), p.id), stripUndefined(next));
  }
  await batch.commit();
}

/**
 * Backward-compatible helper: most existing call sites only know about
 * RunningPlan and pass it to update. Allows them to keep working unchanged.
 */
export type RunningPlanInput = Omit<RunningPlan, "id" | "createdAt" | "updatedAt">;
