/**
 * HealthWorkout service.
 *
 * Firestore collection: users/{uid}/healthWorkouts
 * Doc ID: workout UUID (from HealthKit)
 *
 * Schema (Firestore field names written by iOS HealthKitSyncService):
 *   workoutId         string   (UUID)
 *   source            string   "healthkit"
 *   activityType      string   raw HK activity type
 *   displayType       string   human-readable type
 *   startDate         Timestamp
 *   endDate           Timestamp
 *   durationSeconds   number
 *   sourceName        string
 *   isRunLike         boolean
 *   hasRoute          boolean
 *   syncedAt          Timestamp
 *   sourceBundle?     string
 *   calories?         number
 *   avgHeartRate?     number
 *   distanceMiles?    number
 *   distanceMeters?   number
 *   avgPaceSecPerMile? number
 *   avgSpeedMPS?      number
 *   hrDriftPct?       number
 *   cadenceSPM?       number
 *   efficiencyRaw?    number
 *   efficiencyScore?  number
 */

import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  type QueryConstraint,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { toDate } from "@/utils/dates";
import { type HealthWorkout } from "@/types/healthWorkout";
import { type UserSettings } from "@/types/userSettings";
import {
  computeBestEfforts,
  EMPTY_BEST_EFFORTS,
  type BestEffortsMap,
} from "@/utils/bestEfforts";
import {
  computeTrainingLoadV2,
  computeStreamedTrainingLoad,
  resolveMaxHr,
  resolveRestingHr,
  MIN_HRSTREAM_SAMPLES,
} from "@/utils/trainingLoad";
import { fetchRoutePoints, type RoutePoint } from "@/services/routes";
import { fetchHRStream } from "@/services/hrStream";

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

const BEST_EFFORT_KEYS = Object.keys(EMPTY_BEST_EFFORTS) as Array<
  keyof BestEffortsMap
>;

function parseBestEfforts(value: unknown): BestEffortsMap | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const parsed = { ...EMPTY_BEST_EFFORTS };

  for (const key of BEST_EFFORT_KEYS) {
    const v = raw[key];
    parsed[key] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }

  return parsed;
}

function bestEffortsEqual(
  a: BestEffortsMap | undefined,
  b: BestEffortsMap
): boolean {
  if (!a) return false;
  return BEST_EFFORT_KEYS.every((key) => a[key] === b[key]);
}

function docToHealthWorkout(
  id: string,
  data: Record<string, unknown>
): HealthWorkout {
  const displayType = (data.displayType as string) ?? "Workout";
  const distanceMiles = (data.distanceMiles as number) ?? 0;

  return {
    workoutId: (data.workoutId as string) ?? id,
    name: displayType,
    activityType: (data.activityType as string) ?? "",
    displayType,
    startDate: toDate(data.startDate),
    endDate: toDate(data.endDate),
    durationSeconds: (data.durationSeconds as number) ?? 0,
    sourceName: (data.sourceName as string) ?? "Apple Watch",
    isRunLike: (data.isRunLike as boolean) ?? false,
    hasRoute: (data.hasRoute as boolean) ?? false,
    hasHRStream: (data.hasHRStream as boolean) ?? false,
    syncedAt: toDate(data.syncedAt),
    sourceBundle: data.sourceBundle as string | undefined,
    calories: (data.calories as number) ?? 0,
    avgHeartRate: (data.avgHeartRate as number | null) ?? null,
    distanceMiles,
    distanceMeters: (data.distanceMeters as number | null) ?? null,
    avgPaceSecPerMile: (data.avgPaceSecPerMile as number | null) ?? null,
    avgSpeedMPS: (data.avgSpeedMPS as number | null) ?? null,
    hrDriftPct: (data.hrDriftPct as number | null) ?? null,
    cadenceSPM: (data.cadenceSPM as number | null) ?? null,
    efficiencyRaw: (data.efficiencyRaw as number | null) ?? null,
    efficiencyScore: (data.efficiencyScore as number | null) ?? null,
    elevationGainM: (data.elevationGainM as number | null) ?? null,
    prBadges: Array.isArray(data.prBadges)
      ? (data.prBadges as unknown[]).filter(
          (v): v is string => typeof v === "string"
        )
      : undefined,
    bestEfforts: parseBestEfforts(data.bestEfforts),
    trainingLoadV2:
      typeof data.trainingLoadV2 === "number" &&
      Number.isFinite(data.trainingLoadV2)
        ? (data.trainingLoadV2 as number)
        : data.trainingLoadV2 === null
          ? null
          : undefined,
    trainingLoadMethod:
      data.trainingLoadMethod === "streamed" ||
      data.trainingLoadMethod === "avg-hr-fallback"
        ? data.trainingLoadMethod
        : undefined,
  };
}

export async function fetchHealthWorkouts(
  uid: string,
  opts: { limitCount?: number } = {}
): Promise<HealthWorkout[]> {
  const constraints: QueryConstraint[] = [orderBy("startDate", "desc")];
  if (opts.limitCount) constraints.push(limit(opts.limitCount));

  const q = query(
    collection(db, "users", uid, "healthWorkouts"),
    ...constraints
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) =>
    docToHealthWorkout(d.id, d.data() as Record<string, unknown>)
  );
}

export async function fetchHealthWorkout(
  uid: string,
  workoutId: string
): Promise<HealthWorkout | null> {
  const snap = await getDoc(
    doc(db, "users", uid, "healthWorkouts", workoutId)
  );
  if (!snap.exists()) return null;
  return docToHealthWorkout(snap.id, snap.data() as Record<string, unknown>);
}

/**
 * Real-time listener for healthWorkouts. Calls `onData` whenever the
 * result set changes (initial load + subsequent writes from iOS sync).
 * Returns an unsubscribe function — caller MUST call it on unmount.
 */
export function onHealthWorkoutsSnapshot(
  uid: string,
  opts: { limitCount?: number; isRunLike?: boolean },
  onData: (workouts: HealthWorkout[]) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  const constraints: QueryConstraint[] = [orderBy("startDate", "desc")];
  if (opts.isRunLike !== undefined) {
    constraints.push(where("isRunLike", "==", opts.isRunLike));
  }
  if (opts.limitCount) constraints.push(limit(opts.limitCount));

  const q = query(
    collection(db, "users", uid, "healthWorkouts"),
    ...constraints
  );

  return onSnapshot(
    q,
    (snap) => {
      onData(
        snap.docs.map((d) =>
          docToHealthWorkout(d.id, d.data() as Record<string, unknown>)
        )
      );
    },
    (err) => {
      console.error("[onHealthWorkoutsSnapshot] listener error:", err);
      onError?.(err);
    }
  );
}

export async function computeAndStoreBestEfforts(
  uid: string,
  workoutId: string,
  points: RoutePoint[]
): Promise<BestEffortsMap> {
  const bestEfforts = computeBestEfforts(points);
  const ref = doc(db, "users", uid, "healthWorkouts", workoutId);
  const snap = await getDoc(ref);
  const existing = snap.exists()
    ? parseBestEfforts((snap.data() as Record<string, unknown>).bestEfforts)
    : undefined;

  if (bestEffortsEqual(existing, bestEfforts)) {
    return bestEfforts;
  }

  await setDoc(ref, stripUndefined({ bestEfforts }), { merge: true });
  return bestEfforts;
}

/**
 * Compute Training Load V2 for a single workout and persist it.
 *
 * Mirrors computeAndStoreBestEfforts: resolves the profile HR anchors, then
 * selects the load model via a 3-tier chain and merges the result back via
 * owner setDoc(merge:true) — the same write pattern computeAndStoreBestEfforts
 * uses in production (so no new Firestore rule is required). NEVER writes 0 for
 * a null load: a null is written explicitly so the UI renders "—".
 *
 * Method-selection (3-tier):
 *   1. hasRoute       → per-second streamed integral over route-point HR
 *                       (UNCHANGED run path). method "streamed".
 *   2. hasHRStream    → per-sample streamed integral over the iOS hrStream
 *                       subcollection. method "streamed". Teaches non-route
 *                       workouts (HIIT/OTF/strength) a true intensity basis.
 *   3. else           → avg-HR Banister baseline. method "avg-hr-fallback".
 *
 * An empty/too-sparse hrStream despite hasHRStream falls through to tier 3
 * (defensive — never errors).
 */
export async function computeAndStoreTrainingLoad(
  uid: string,
  workoutId: string,
  settings: UserSettings | null | undefined
): Promise<{ load: number | null; method: string } | null> {
  const ref = doc(db, "users", uid, "healthWorkouts", workoutId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;

  const data = snap.data() as Record<string, unknown>;
  const maxHr = resolveMaxHr(settings);
  const restingHr = resolveRestingHr(settings);
  const durationSeconds = (data.durationSeconds as number) ?? 0;
  const avgHeartRate = (data.avgHeartRate as number | null) ?? null;
  const activityType = (data.activityType as string) ?? undefined;
  const hasRoute = (data.hasRoute as boolean) ?? false;
  const hasHRStream = (data.hasHRStream as boolean) ?? false;

  let load: number | null;
  let method: "streamed" | "avg-hr-fallback";

  // Tier 1 — route runs: per-second integral over route-point HR (UNCHANGED).
  if (hasRoute) {
    const points = await fetchRoutePoints(uid, workoutId);
    const result = computeStreamedTrainingLoad(
      points.map((p) => ({ timestamp: p.timestamp, hr: p.hr })),
      durationSeconds,
      avgHeartRate,
      maxHr,
      restingHr,
      activityType
    );
    load = result.load;
    method = result.method;
  } else if (hasHRStream) {
    // Tier 2 — non-route workouts with an iOS hrStream: integrate over the
    // per-sample HR. The hrStream samples ARE the points array (reuse
    // computeStreamedTrainingLoad verbatim — same Δt-clamp/coverage logic).
    const samples = await fetchHRStream(uid, workoutId);
    if (samples.length >= MIN_HRSTREAM_SAMPLES) {
      const result = computeStreamedTrainingLoad(
        samples.map((s) => ({ timestamp: s.timestamp, hr: s.hr })),
        durationSeconds,
        avgHeartRate,
        maxHr,
        restingHr,
        activityType
      );
      load = result.load;
      method = result.method;
    } else {
      // Empty/too-sparse stream despite the flag → avg-HR fallback (no error).
      load = computeTrainingLoadV2(
        durationSeconds,
        avgHeartRate,
        maxHr,
        restingHr,
        activityType
      );
      method = "avg-hr-fallback";
    }
  } else {
    // Tier 3 — avg-HR Banister baseline.
    load = computeTrainingLoadV2(
      durationSeconds,
      avgHeartRate,
      maxHr,
      restingHr,
      activityType
    );
    method = "avg-hr-fallback";
  }

  // stripUndefined drops `undefined` keys but PRESERVES explicit null, so a
  // null load is stored (→ "—") rather than written as 0.
  await setDoc(
    ref,
    stripUndefined({ trainingLoadV2: load, trainingLoadMethod: method }),
    { merge: true }
  );

  return { load, method };
}

/**
 * Backfill Training Load V2 across all of a user's runs. Mirrors
 * backfillBestEfforts: iterates run-like workouts, computes + stores each, and
 * tallies the outcome. Idempotent — safe to re-run (overwrites the field).
 */
export async function backfillTrainingLoad(
  uid: string,
  settings: UserSettings | null | undefined
): Promise<{
  processed: number;
  streamed: number;
  fallback: number;
  skipped: number;
}> {
  const stats = { processed: 0, streamed: 0, fallback: 0, skipped: 0 };

  const q = query(
    collection(db, "users", uid, "healthWorkouts"),
    where("isRunLike", "==", true),
    orderBy("startDate", "desc")
  );
  const snap = await getDocs(q);

  for (const workoutDoc of snap.docs) {
    const result = await computeAndStoreTrainingLoad(
      uid,
      workoutDoc.id,
      settings
    );
    if (!result) {
      stats.skipped++;
      continue;
    }
    stats.processed++;
    if (result.method === "streamed") stats.streamed++;
    else stats.fallback++;
  }

  return stats;
}

export async function backfillBestEfforts(uid: string): Promise<{
  scanned: number;
  computed: number;
  skippedAlreadyDone: number;
  skippedNoRoute: number;
}> {
  const stats = {
    scanned: 0,
    computed: 0,
    skippedAlreadyDone: 0,
    skippedNoRoute: 0,
  };

  const q = query(
    collection(db, "users", uid, "healthWorkouts"),
    where("hasRoute", "==", true),
    orderBy("startDate", "desc")
  );
  const snap = await getDocs(q);

  for (const workoutDoc of snap.docs) {
    stats.scanned++;
    const data = workoutDoc.data() as Record<string, unknown>;

    // Idempotent resume path: do not spend route reads on already-backfilled
    // docs. Safe to interrupt and re-run.
    if (data.bestEfforts !== undefined) {
      stats.skippedAlreadyDone++;
      continue;
    }

    const points = await fetchRoutePoints(uid, workoutDoc.id);
    if (points.length < 2) {
      stats.skippedNoRoute++;
      continue;
    }

    await computeAndStoreBestEfforts(uid, workoutDoc.id, points);
    stats.computed++;
  }

  return stats;
}
