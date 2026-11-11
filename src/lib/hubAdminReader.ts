/**
 * Read-only Admin Firestore adapter for the Hub summary endpoint (server-only).
 *
 * Reads exactly what the Training tile needs for ONE verified user and ONE
 * Eastern week — nothing is ever written:
 *   - healthWorkouts: `startDate` range query for the week window
 *     (single-field index only; Admin reads bypass security rules);
 *   - workoutOverrides: `getAll` of the override docs whose ids are those
 *     workouts' ids;
 *   - plans: the whole collection (legacy docs lack `status`, so active plans
 *     are resolved in code exactly as the dashboard does).
 * Only the document fields the shared mappers read are selected, so large route/
 * chart caches on workout documents are never transferred.
 *
 * Failures never leak: every Firestore error becomes a `HubReadError` carrying a
 * fixed reason ("permission" or "upstream"); messages, ids and stacks are not
 * kept or logged.
 */

import type { Plan } from "@/types/plan";
import type { WorkoutOverride } from "@/types/workoutOverride";
import type { ZonedWeek } from "@/lib/hubWeek";
import { toHubWorkout, type HubWorkout } from "@/lib/hubTrainingWeek";
import { normalizePlanDocument } from "@/utils/planDocument";

export type HubReadFailure = "permission" | "upstream";

export class HubReadError extends Error {
  constructor(readonly reason: HubReadFailure) {
    super(reason);
    this.name = "HubReadError";
  }
}

/** A week holds a handful of workouts; more than this means something is wrong. */
export const HUB_WORKOUT_LIMIT = 500;

const WORKOUT_FIELDS = [
  "workoutId", "displayType", "activityType", "startDate", "endDate", "durationSeconds",
  "sourceName", "isRunLike", "hasRoute", "hasHRStream", "syncedAt", "avgHeartRate",
  "distanceMiles", "distanceMeters", "avgPaceSecPerMile", "elevationGainM", "weather",
  "routeClusterId", "entrySource", "customTitle", "createdAt", "updatedAt",
] as const;

const PLAN_FIELDS = [
  "name", "planType", "startDate", "weeks", "status", "isActive", "createdAt", "updatedAt",
] as const;

export interface HubWeekRead {
  workouts: HubWorkout[];
  overrides: Record<string, WorkoutOverride>;
  plans: Plan[];
  stagesMs: { workouts: number; overrides: number; plans: number };
  counts: { workouts: number; overrides: number; plans: number };
}

function classify(error: unknown): HubReadFailure {
  if (error instanceof HubReadError) return error.reason;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 7 || code === "permission-denied" || code === "PERMISSION_DENIED"
    ? "permission"
    : "upstream";
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const value = await run();
  return { value, ms: Date.now() - started };
}

export async function readHubWeek(
  uid: string,
  week: Pick<ZonedWeek, "startInstant" | "endExclusiveInstant">
): Promise<HubWeekRead> {
  try {
    const { getFirestore } = await import("@/lib/firebaseAdmin");
    const db = getFirestore();
    const userRef = db.collection("users").doc(uid);

    const workoutsStage = timed(async () => {
      const snap = await userRef
        .collection("healthWorkouts")
        .where("startDate", ">=", week.startInstant)
        .where("startDate", "<", week.endExclusiveInstant)
        .orderBy("startDate", "desc")
        .select(...WORKOUT_FIELDS)
        .limit(HUB_WORKOUT_LIMIT + 1)
        .get();
      if (snap.docs.length > HUB_WORKOUT_LIMIT) throw new HubReadError("upstream");
      return snap.docs.map((d) => toHubWorkout(d.id, d.data() as Record<string, unknown>));
    });
    const plansStage = timed(async () => {
      const snap = await userRef.collection("plans").select(...PLAN_FIELDS).get();
      return snap.docs.map((d) => normalizePlanDocument(d.id, d.data() as Record<string, unknown>));
    });

    const [workoutsResult, plansResult] = await Promise.all([workoutsStage, plansStage]);
    const workouts = workoutsResult.value;

    const overridesResult = await timed(async () => {
      const ids = [...new Set(workouts.map((w) => w.workoutId))].filter(
        (id) => id.length > 0 && !id.includes("/")
      );
      const overrides: Record<string, WorkoutOverride> = {};
      if (ids.length === 0) return overrides;
      const snaps = await db.getAll(
        ...ids.map((id) => userRef.collection("workoutOverrides").doc(id))
      );
      for (const snap of snaps) {
        if (snap.exists) overrides[snap.id] = snap.data() as WorkoutOverride;
      }
      return overrides;
    });

    return {
      workouts,
      overrides: overridesResult.value,
      plans: plansResult.value,
      stagesMs: { workouts: workoutsResult.ms, overrides: overridesResult.ms, plans: plansResult.ms },
      counts: {
        workouts: workouts.length,
        overrides: Object.keys(overridesResult.value).length,
        plans: plansResult.value.length,
      },
    };
  } catch (error) {
    throw new HubReadError(classify(error));
  }
}
