/**
 * Create, edit and delete manually entered activities.
 *
 * Stored alongside iOS records at users/{uid}/healthWorkouts/{manual_<UUID>},
 * recognized only by `entrySource: "manual"`. Every write runs in a transaction
 * that first re-reads the target, so an Apple Health record can never be changed
 * through this workflow, and a retry after a lost acknowledgement cannot duplicate.
 * Transactions also fail promptly offline rather than queueing an unconfirmed
 * write, so a save is only reported once the server has it.
 */

import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { isAuthorizedTrainingUser } from "@/lib/trainingAuthorization";
import { docToHealthWorkout } from "@/services/healthWorkouts";
import { fetchPlans } from "@/services/plans";
import { fetchRaces } from "@/services/races";
import { type HealthWorkout } from "@/types/healthWorkout";
import { isWorkoutPlan, type Plan } from "@/types/plan";
import { type WorkoutOverride } from "@/types/workoutOverride";
import { toDate, toLocalIsoDate } from "@/utils/dates";
import {
  buildManualActivityFields,
  MANUAL_ACTIVITY_ID_PREFIX,
  MANUAL_DERIVED_FIELDS,
  MANUAL_OPTIONAL_FIELDS,
  validateManualActivityInput,
  type ManualActivityInput,
} from "@/utils/manualActivity";

export type ManualActivityErrorCode =
  | "unauthorized"
  | "invalid"
  | "not_found"
  | "not_manual"
  | "linked_race"
  | "linked_performance"
  | "write_failed";

export class ManualActivityError extends Error {
  constructor(public readonly code: ManualActivityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManualActivityError";
  }
}

export interface ManualActivityUpdateResult {
  workout: HealthWorkout;
  /** Omitted when unchanged; null when the override doc was removed. */
  override?: WorkoutOverride | null;
  /** Plans whose auto-matched session was released by this edit. */
  plans: Plan[];
}

export interface ManualActivityDeleteResult {
  /** True when an override doc existed and was removed. */
  overrideRemoved: boolean;
  plans: Plan[];
}

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

/** Confirmed owner only; Firebase authentication alone is insufficient here. */
function assertOwner(uid: string): void {
  const user = auth.currentUser;
  if (!uid || !user || user.uid !== uid || !isAuthorizedTrainingUser(user.email, user.emailVerified)) {
    throw new ManualActivityError("unauthorized", "Please sign in again to change activities.");
  }
}

function assertValidInput(input: ManualActivityInput): void {
  const [firstError] = Object.values(validateManualActivityInput(input));
  if (firstError) throw new ManualActivityError("invalid", firstError);
}

function assertManualId(workoutId: string): void {
  if (!workoutId.startsWith(MANUAL_ACTIVITY_ID_PREFIX)) {
    throw new ManualActivityError("not_manual", "Apple Health activities can't be changed here.");
  }
}

function asFailure(cause: unknown, action: string): ManualActivityError {
  if (cause instanceof ManualActivityError) return cause;
  const code = (cause as { code?: string } | null)?.code;
  const detail =
    code === "permission-denied"
      ? "Your account doesn't have permission to make this change."
      : code === "unavailable"
        ? "You appear to be offline. Nothing was saved — try again when you're connected."
        : "Nothing was saved. Please try again.";
  return new ManualActivityError("write_failed", `Couldn't ${action} this activity. ${detail}`, { cause });
}

const workoutRef = (uid: string, id: string) => doc(db, "users", uid, "healthWorkouts", id);
const overrideRef = (uid: string, id: string) => doc(db, "users", uid, "workoutOverrides", id);
const planRef = (uid: string, id: string) => doc(db, "users", uid, "plans", id);
const manualShoeRef = (uid: string) => doc(db, "users", uid, "shoeAssignments", "manual");

/** Races keep a copy of their linked run's measurements and any confirmation
 *  evidence. Scanning the whole race is safe: the ID is a namespaced UUID. */
async function findLinkedRaceName(uid: string, workoutId: string): Promise<string | null> {
  const races = await fetchRaces(uid);
  const linked = races.find((race) => JSON.stringify(race).includes(workoutId));
  return linked ? linked.name : null;
}

/** Release sessions AutoMatch completed from this activity. `matchedWorkoutId` is
 *  only ever written by AutoMatch, so a manually completed session is untouched. */
export function releasePlansMatchedTo(plans: Plan[], workoutId: string): Plan[] {
  const changed: Plan[] = [];
  for (const plan of plans) {
    if (!isWorkoutPlan(plan)) continue;
    let touched = false;
    const weeks = plan.weeks.map((week) => ({
      ...week,
      entries: week.entries.map((entry) => {
        if (entry.matchedWorkoutId !== workoutId) return entry;
        touched = true;
        const cleared = { ...entry, completed: false };
        delete cleared.completedAt;
        delete cleared.matchedWorkoutId;
        return cleared;
      }),
    }));
    if (touched) changed.push({ ...plan, weeks, updatedAt: new Date().toISOString() } as Plan);
  }
  return changed;
}

/** Personal Insights notices through its workout revision, but Run Detail's cached
 *  CTL check only compares the newest workout ID, which a backdated change leaves
 *  alone. Best-effort: the save has already succeeded, and a missing doc is fine. */
function invalidateAggregatedStats(uid: string): void {
  void Promise.resolve()
    .then(() =>
      updateDoc(doc(db, "users", uid, "insights", "aggregatedStats"), {
        "freshnessFingerprint.latestWorkoutId": "manual-activity-changed",
      })
    )
    .catch((err: { code?: string }) => {
      if (err?.code !== "not-found") {
        console.warn("[manualActivities] aggregated stats not invalidated", err);
      }
    });
}

export async function createManualActivity(
  uid: string,
  input: ManualActivityInput,
  idempotencyId: string
): Promise<HealthWorkout> {
  assertOwner(uid);
  assertValidInput(input);
  assertManualId(idempotencyId);
  const ref = workoutRef(uid, idempotencyId);
  const now = new Date();

  try {
    const workout = await runTransaction(db, async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists()) {
        const data = existing.data() as Record<string, unknown>;
        if (data.entrySource !== "manual") {
          throw new ManualActivityError("not_manual", "Apple Health activities can't be changed here.");
        }
        // An earlier attempt reached the server; never write it twice.
        return docToHealthWorkout(existing.id, data);
      }
      const fields = buildManualActivityFields(input);
      const stored = {
        ...fields,
        workoutId: idempotencyId,
        startDate: Timestamp.fromDate(fields.startDate as Date),
        endDate: Timestamp.fromDate(fields.endDate as Date),
        createdAt: Timestamp.fromDate(now),
        updatedAt: Timestamp.fromDate(now),
      };
      tx.set(ref, stored);
      return docToHealthWorkout(idempotencyId, stored);
    });
    invalidateAggregatedStats(uid);
    return workout;
  } catch (cause) {
    throw asFailure(cause, "save");
  }
}

export async function updateManualActivity(
  uid: string,
  workoutId: string,
  input: ManualActivityInput
): Promise<ManualActivityUpdateResult> {
  assertOwner(uid);
  assertValidInput(input);
  assertManualId(workoutId);
  const ref = workoutRef(uid, workoutId);
  const ovRef = overrideRef(uid, workoutId);
  const now = new Date();

  try {
    const [linkedRace, plans] = await Promise.all([
      findLinkedRaceName(uid, workoutId),
      fetchPlans(uid),
    ]);

    const result = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) {
        throw new ManualActivityError("not_found", "This activity no longer exists.");
      }
      const previous = snap.data() as Record<string, unknown>;
      if (previous.entrySource !== "manual") {
        throw new ManualActivityError("not_manual", "Apple Health activities can't be changed here.");
      }
      const ovSnap = await tx.get(ovRef);

      const fields = buildManualActivityFields(input);
      const startDate = fields.startDate as Date;
      const previousStart = toDate(previous.startDate);
      const measuresChanged =
        previous.durationSeconds !== fields.durationSeconds ||
        (previous.distanceMiles ?? null) !== (fields.distanceMiles ?? null) ||
        previous.activityType !== fields.activityType ||
        (previous.avgHeartRate ?? null) !== (fields.avgHeartRate ?? null);
      const raceFieldsChanged =
        measuresChanged || previousStart.getTime() !== startDate.getTime();
      if (linkedRace && raceFieldsChanged) {
        throw new ManualActivityError(
          "linked_race",
          `This activity is linked to the race "${linkedRace}". Unlink it on the Races page before changing its date, type, or measurements.`
        );
      }

      const stored: Record<string, unknown> = {
        ...fields,
        startDate: Timestamp.fromDate(startDate),
        endDate: Timestamp.fromDate(fields.endDate as Date),
        updatedAt: Timestamp.fromDate(now),
      };
      const writes: Record<string, unknown> = { ...stored };
      for (const field of MANUAL_OPTIONAL_FIELDS) {
        if (!(field in fields)) writes[field] = deleteField();
      }
      const clearDerived = measuresChanged;
      if (clearDerived) {
        for (const field of MANUAL_DERIVED_FIELDS) writes[field] = deleteField();
      }
      tx.set(ref, writes, { merge: true });

      // Overrides layer over the stored values, so a leftover one would hide the
      // edit. Exclusion is independent and survives.
      let nextOverride: WorkoutOverride | null | undefined;
      if (ovSnap.exists()) {
        const override = ovSnap.data() as WorkoutOverride;
        const hasFieldOverride =
          override.distanceMilesOverride != null ||
          override.durationSecondsOverride != null ||
          override.runTypeOverride != null;
        if (hasFieldOverride) {
          if (override.isExcluded) {
            nextOverride = {
              ...override,
              distanceMilesOverride: null,
              durationSecondsOverride: null,
              runTypeOverride: null,
              updatedAt: now.toISOString(),
            };
            tx.set(ovRef, stripUndefined(nextOverride));
          } else {
            nextOverride = null;
            tx.delete(ovRef);
          }
        }
      }

      // A session matched by date and type no longer holds if either moved.
      const matchBasisChanged =
        previous.activityType !== fields.activityType ||
        toLocalIsoDate(previousStart) !== toLocalIsoDate(startDate);
      const releasedPlans = matchBasisChanged ? releasePlansMatchedTo(plans, workoutId) : [];
      for (const plan of releasedPlans) {
        tx.set(planRef(uid, plan.id), stripUndefined(plan));
      }

      const merged: Record<string, unknown> = { ...previous, ...stored };
      for (const field of MANUAL_OPTIONAL_FIELDS) {
        if (!(field in fields)) delete merged[field];
      }
      if (clearDerived) {
        for (const field of MANUAL_DERIVED_FIELDS) delete merged[field];
      }
      return {
        workout: docToHealthWorkout(workoutId, merged),
        ...(nextOverride !== undefined ? { override: nextOverride } : {}),
        plans: releasedPlans,
      };
    });
    invalidateAggregatedStats(uid);
    return result;
  } catch (cause) {
    throw asFailure(cause, "save");
  }
}

export async function deleteManualActivity(
  uid: string,
  workoutId: string
): Promise<ManualActivityDeleteResult> {
  assertOwner(uid);
  assertManualId(workoutId);
  const ref = workoutRef(uid, workoutId);
  const ovRef = overrideRef(uid, workoutId);
  const shoeRef = manualShoeRef(uid);

  try {
    // Link checks and cleanup targets are read first: a transaction can't query.
    const [linkedRace, featureSnap, plans, dismissedSnap] = await Promise.all([
      findLinkedRaceName(uid, workoutId),
      getDoc(doc(db, "users", uid, "performanceFeatures", workoutId)),
      fetchPlans(uid),
      getDocs(collection(db, "users", uid, "dismissedDuplicates")),
    ]);
    if (linkedRace) {
      throw new ManualActivityError(
        "linked_race",
        `This activity is linked to the race "${linkedRace}". Unlink it on the Races page before deleting it.`
      );
    }
    if (featureSnap.exists()) {
      // Saved performance snapshots cite this evidence and are not editable here.
      throw new ManualActivityError(
        "linked_performance",
        "Saved performance analysis uses this activity, so it can't be deleted. Exclude it instead to remove it from your stats."
      );
    }
    const dismissedIds = dismissedSnap.docs
      .map((dismissed) => dismissed.id)
      .filter((id) => id.includes(workoutId));

    const result = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      // Already gone: an earlier attempt succeeded and its acknowledgement was lost.
      if (!snap.exists()) return { overrideRemoved: false, plans: [] };
      if ((snap.data() as Record<string, unknown>).entrySource !== "manual") {
        throw new ManualActivityError("not_manual", "Apple Health activities can't be changed here.");
      }
      const [ovSnap, shoeSnap] = await Promise.all([tx.get(ovRef), tx.get(shoeRef)]);

      tx.delete(ref);
      if (ovSnap.exists()) tx.delete(ovRef);
      if (shoeSnap.exists() && workoutId in (shoeSnap.data() as Record<string, unknown>)) {
        tx.set(shoeRef, { [workoutId]: deleteField() }, { merge: true });
      }
      for (const id of dismissedIds) {
        tx.delete(doc(db, "users", uid, "dismissedDuplicates", id));
      }
      const releasedPlans = releasePlansMatchedTo(plans, workoutId);
      for (const plan of releasedPlans) {
        tx.set(planRef(uid, plan.id), stripUndefined(plan));
      }
      return { overrideRemoved: ovSnap.exists(), plans: releasedPlans };
    });
    invalidateAggregatedStats(uid);
    return result;
  } catch (cause) {
    throw asFailure(cause, "delete");
  }
}
