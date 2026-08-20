/**
 * Admin-SDK repair for persisted best-effort freshness.
 *
 * The operation is dry-run by default at its runner boundary. It only writes a
 * workout after confirming routeComplete !== false, reading that workout's
 * existing route subcollection, and freshly recomputing the persisted map.
 * Partial routes are logged and never force-computed.
 */

import admin from "firebase-admin";
import { type RoutePoint } from "@/services/routes";
import {
  BEST_EFFORT_DISTANCES_M,
  computeBestEfforts,
  withBestEffortsFreshness,
  type BestEffortKey,
  type BestEffortsMap,
} from "@/utils/bestEfforts";
import { BEST_EFFORTS_COMPUTATION_VERSION } from "@/utils/fastestMileSegment";
import { getDb, resolveUid } from "./backfillTrainingLoad";

export interface BestEffortRepairOptions {
  dryRun: boolean;
  uid?: string;
}

export interface BestEffortRepairReport {
  scanned: number;
  stale: number;
  missing: number;
  repaired: number;
  diffs: Array<{
    workoutId: string;
    oldValue: number | null;
    newValue: number;
    deltaSeconds: number;
  }>;
}

export interface BestEffortRepairStore {
  resolveUid(override?: string): Promise<string>;
  listRunWorkouts(uid: string): Promise<
    Array<{ workoutId: string; data: Record<string, unknown> }>
  >;
  readRoute(uid: string, workoutId: string): Promise<RoutePoint[]>;
  writeBestEfforts(
    uid: string,
    workoutId: string,
    bestEfforts: BestEffortsMap
  ): Promise<void>;
  readBestEfforts(uid: string, workoutId: string): Promise<unknown>;
}

const BEST_EFFORT_KEYS = Object.keys(
  BEST_EFFORT_DISTANCES_M
) as BestEffortKey[];
const VALUE_STALE_TOLERANCE_SECONDS = 1;
const CONFIRMATION_SAMPLE_SIZE = 5;

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rawBestEfforts(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function valueChanged(
  existing: Record<string, unknown>,
  fresh: BestEffortsMap
): boolean {
  return BEST_EFFORT_KEYS.some((key) => {
    const oldValue = finiteNumber(existing[key]);
    const newValue = finiteNumber(fresh[key]);
    if (oldValue === null || newValue === null) return oldValue !== newValue;
    return Math.abs(oldValue - newValue) > VALUE_STALE_TOLERANCE_SECONDS;
  });
}

function freshnessChanged(existing: Record<string, unknown>): boolean {
  return (
    existing.computedFromRouteComplete !== true ||
    !Number.isFinite(existing.computedFromPointCount) ||
    existing.computationVersion !== BEST_EFFORTS_COMPUTATION_VERSION
  );
}

function toIsoTimestamp(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    const maybeTimestamp = value as { toDate?: () => Date };
    const date = maybeTimestamp.toDate?.();
    if (date instanceof Date) return date.toISOString();
  }
  return "";
}

function createAdminStore(
  db: admin.firestore.Firestore = getDb()
): BestEffortRepairStore {
  return {
    resolveUid: (override) => resolveUid(db, override),
    async listRunWorkouts(uid) {
      const snap = await db
        .collection(`users/${uid}/healthWorkouts`)
        .where("isRunLike", "==", true)
        .get();
      return snap.docs.map((workoutDoc) => ({
        workoutId: workoutDoc.id,
        data: workoutDoc.data() as Record<string, unknown>,
      }));
    },
    async readRoute(uid, workoutId) {
      const snap = await db
        .collection(`users/${uid}/healthWorkouts/${workoutId}/route`)
        .orderBy("index", "asc")
        .get();
      return snap.docs.map((routeDoc) => {
        const data = routeDoc.data() as Record<string, unknown>;
        return {
          index: finiteNumber(data.index) ?? 0,
          lat: finiteNumber(data.lat) ?? Number.NaN,
          lng: finiteNumber(data.lng) ?? Number.NaN,
          altitude: finiteNumber(data.altitude) ?? 0,
          timestamp: toIsoTimestamp(data.timestamp),
          speed: finiteNumber(data.speed),
          hr: finiteNumber(data.hr),
        };
      });
    },
    async writeBestEfforts(uid, workoutId, bestEfforts) {
      await db.doc(`users/${uid}/healthWorkouts/${workoutId}`).set(
        stripUndefined({ bestEfforts }),
        { merge: true }
      );
    },
    async readBestEfforts(uid, workoutId) {
      const snap = await db.doc(`users/${uid}/healthWorkouts/${workoutId}`).get();
      return snap.exists ? snap.data()?.bestEfforts : undefined;
    },
  };
}

/** Testable core; production callers use repairBestEffortsFreshness below. */
export async function repairBestEffortsFreshnessWithStore(
  options: BestEffortRepairOptions,
  store: BestEffortRepairStore
): Promise<BestEffortRepairReport> {
  const uid = await store.resolveUid(options.uid);
  const workouts = await store.listRunWorkouts(uid);
  const report: BestEffortRepairReport = {
    scanned: 0,
    stale: 0,
    missing: 0,
    repaired: 0,
    diffs: [],
  };
  const repairedIds: string[] = [];

  for (const workout of workouts) {
    report.scanned += 1;
    const { workoutId, data } = workout;

    if (data.routeComplete === false) {
      console.log(`[best-efforts-repair] SKIP_PARTIAL ${workoutId}`);
      continue;
    }

    let points: RoutePoint[];
    try {
      points = await store.readRoute(uid, workoutId);
    } catch (error) {
      console.warn(`[best-efforts-repair] SKIP_ROUTE_ERROR ${workoutId}`, error);
      continue;
    }
    if (points.length < 2) {
      console.log(`[best-efforts-repair] SKIP_NO_ROUTE ${workoutId}`);
      continue;
    }

    const existing = rawBestEfforts(data.bestEfforts);
    const fresh = withBestEffortsFreshness(
      computeBestEfforts(points),
      true,
      points.length
    );
    if (!freshnessChanged(existing) && !valueChanged(existing, fresh)) continue;

    report.stale += 1;
    const oldValue = finiteNumber(existing["1mi"]);
    const newValue = finiteNumber(fresh["1mi"]);
    if (newValue !== null) {
      if (oldValue === null) report.missing += 1;
      report.diffs.push({
        workoutId,
        oldValue,
        newValue,
        deltaSeconds: newValue - (oldValue ?? 0),
      });
    }

    if (!options.dryRun) {
      await store.writeBestEfforts(uid, workoutId, fresh);
      report.repaired += 1;
      repairedIds.push(workoutId);
    }
  }

  if (!options.dryRun && repairedIds.length > 0) {
    const confirmations = [];
    for (const workoutId of repairedIds.slice(0, CONFIRMATION_SAMPLE_SIZE)) {
      const persisted = rawBestEfforts(
        await store.readBestEfforts(uid, workoutId)
      );
      confirmations.push({
        workoutId,
        value1mi: finiteNumber(persisted["1mi"]),
        computedFromRouteComplete:
          persisted.computedFromRouteComplete === true,
        computedFromPointCount: finiteNumber(
          persisted.computedFromPointCount
        ),
        computationVersion: finiteNumber(persisted.computationVersion),
      });
    }
    console.log(
      "[best-efforts-repair] POST_WRITE_CONFIRMATION",
      JSON.stringify(confirmations, null, 2)
    );
  }

  console.log(
    "[best-efforts-repair] REPORT",
    JSON.stringify(report, null, 2)
  );
  return report;
}

export function repairBestEffortsFreshness(
  options: BestEffortRepairOptions
): Promise<BestEffortRepairReport> {
  return repairBestEffortsFreshnessWithStore(options, createAdminStore());
}
