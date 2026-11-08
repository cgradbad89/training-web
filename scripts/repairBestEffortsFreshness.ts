/**
 * Admin-SDK repair for persisted best-effort cache integrity.
 *
 * SAFE BY CONSTRUCTION:
 *  - The runner boundary is dry-run by default; writing needs REPAIR_BEST_EFFORTS=commit AND an explicit bound
 *    (`limit` and/or `since`), so a one-time full-history backfill can never happen by accident.
 *  - Selection uses the shared cache-integrity policy (`assessBestEffortsCache`) on the PARENT documents only. A valid, current
 *    record's route is never read. A dry run reads no routes at all (it estimates their size from workout duration).
 *  - Partial routes (routeComplete === false) are never read or force-computed.
 *  - Idempotent and resumable: a repaired record becomes `valid_current` (or `unavailable_confirmed` after bounded retries), so a
 *    re-run selects nothing for it. A recomputed record never replaces a better-grounded one (`shouldReplaceBestEfforts`).
 *  - Estimated cost = one parent-collection query + (for commit) one full route read and one parent write per repaired workout.
 */

import admin from "firebase-admin";
import { type RoutePoint } from "@/services/routes";
import {
  assessBestEffortsCache,
  computeBestEfforts,
  nextVerificationAttempts,
  parseStoredBestEfforts,
  routeDistanceMeters,
  shouldReplaceBestEfforts,
  withBestEffortsFreshness,
  type BestEffortCacheState,
  type BestEffortsMap,
  type WorkoutRouteFacts,
} from "@/utils/bestEfforts";
import { getDb, resolveUid } from "./backfillTrainingLoad";

export interface BestEffortRepairOptions {
  dryRun: boolean;
  uid?: string;
  /** Maximum number of workouts to repair (newest first). REQUIRED in commit mode unless `since` is given. */
  limit?: number;
  /** Only workouts that started on or after this ISO date (YYYY-MM-DD). Lets a repair exclude old history. */
  since?: string;
  /** Dry run only: also read the selected routes (bounded by `limit`) to report value diffs. Never writes. */
  verifyRoutes?: boolean;
}

export interface BestEffortRepairReport {
  scanned: number;
  /** Candidates by cache state (parent documents only). */
  byState: Partial<Record<BestEffortCacheState, number>>;
  /** Selected for repair: recompute needed, complete route, inside the bounds. */
  eligible: number;
  skippedPartial: number;
  skippedNoRoute: number;
  skippedOutsideBounds: number;
  estimatedRouteDocumentReads: number;
  estimatedParentWrites: number;
  routeReads: number;
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
        // Parent-only selection: just the fields the integrity policy needs (document reads are unchanged; payload is smaller).
        .select("startDate", "hasRoute", "routeComplete", "distanceMiles", "durationSeconds", "bestEfforts")
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

const startIso = (data: Record<string, unknown>): string => toIsoTimestamp(data.startDate);

/** Testable core; production callers use repairBestEffortsFreshness below. */
export async function repairBestEffortsFreshnessWithStore(
  options: BestEffortRepairOptions,
  store: BestEffortRepairStore
): Promise<BestEffortRepairReport> {
  if (!options.dryRun && options.limit === undefined && options.since === undefined) {
    throw new Error("Commit mode requires an explicit bound: set `limit` and/or `since` (a full-history backfill is never implicit).");
  }
  if (options.limit !== undefined && !(Number.isInteger(options.limit) && options.limit > 0)) throw new RangeError("limit must be a positive integer");
  const uid = await store.resolveUid(options.uid);
  const workouts = (await store.listRunWorkouts(uid)).slice().sort((a, b) => startIso(b.data).localeCompare(startIso(a.data)));
  const report: BestEffortRepairReport = {
    scanned: 0, byState: {}, eligible: 0, skippedPartial: 0, skippedNoRoute: 0, skippedOutsideBounds: 0,
    estimatedRouteDocumentReads: 0, estimatedParentWrites: 0, routeReads: 0, stale: 0, missing: 0, repaired: 0, diffs: [],
  };
  const repairedIds: string[] = [];
  const touch = !options.dryRun || options.verifyRoutes === true;

  for (const workout of workouts) {
    report.scanned += 1;
    const { workoutId, data } = workout;
    if (data.hasRoute === false) { report.skippedNoRoute += 1; continue; }
    const existing = parseStoredBestEfforts(data.bestEfforts);
    const routeComplete = data.routeComplete !== false;
    const facts: WorkoutRouteFacts = { distanceMiles: finiteNumber(data.distanceMiles), durationSeconds: finiteNumber(data.durationSeconds) };
    const assessment = assessBestEffortsCache(existing, routeComplete, facts);
    report.byState[assessment.state] = (report.byState[assessment.state] ?? 0) + 1;
    if (!assessment.recompute) continue;
    if (!routeComplete) {
      console.log(`[best-efforts-repair] SKIP_PARTIAL ${workoutId}`);
      report.skippedPartial += 1;
      continue;
    }
    if ((options.since !== undefined && startIso(data).slice(0, 10) < options.since)
      || (options.limit !== undefined && report.eligible >= options.limit)) { report.skippedOutsideBounds += 1; continue; }
    report.eligible += 1;
    report.stale += 1;
    if (assessment.state === "missing_recoverable") report.missing += 1;
    // ~1 route document per second of workout time (observed on real data: documents ≈ duration).
    report.estimatedRouteDocumentReads += Math.round(facts.durationSeconds ?? 0);
    report.estimatedParentWrites += 1;
    if (!touch) continue;

    let points: RoutePoint[];
    try {
      points = await store.readRoute(uid, workoutId);
      report.routeReads += 1;
    } catch (error) {
      console.warn(`[best-efforts-repair] SKIP_ROUTE_ERROR ${workoutId}`, error);
      continue;
    }
    if (points.length < 2) {
      console.log(`[best-efforts-repair] SKIP_NO_ROUTE ${workoutId}`);
      continue;
    }
    const computed = computeBestEfforts(points);
    const base = withBestEffortsFreshness(computed, true, points.length, { routeDistanceMeters: routeDistanceMeters(points) });
    const fresh = withBestEffortsFreshness(computed, true, points.length, {
      routeDistanceMeters: routeDistanceMeters(points), verificationAttempts: nextVerificationAttempts(existing, base, facts) });
    const oldValue = finiteNumber(rawBestEfforts(data.bestEfforts)["1mi"]);
    const newValue = finiteNumber(fresh["1mi"]);
    if (newValue !== null) report.diffs.push({ workoutId, oldValue, newValue, deltaSeconds: newValue - (oldValue ?? 0) });
    if (options.dryRun) continue;
    if (!shouldReplaceBestEfforts(existing, fresh)) { console.log(`[best-efforts-repair] KEEP_BETTER_EXISTING ${workoutId}`); continue; }
    await store.writeBestEfforts(uid, workoutId, fresh);
    report.repaired += 1;
    repairedIds.push(workoutId);
  }

  if (!options.dryRun && repairedIds.length > 0) {
    const confirmations = [];
    for (const workoutId of repairedIds.slice(0, CONFIRMATION_SAMPLE_SIZE)) {
      const persisted = rawBestEfforts(await store.readBestEfforts(uid, workoutId));
      confirmations.push({
        workoutId,
        value1mi: finiteNumber(persisted["1mi"]),
        computedFromRouteComplete: persisted.computedFromRouteComplete === true,
        computedFromPointCount: finiteNumber(persisted.computedFromPointCount),
        computationVersion: finiteNumber(persisted.computationVersion),
      });
    }
    console.log("[best-efforts-repair] POST_WRITE_CONFIRMATION", JSON.stringify(confirmations, null, 2));
  }

  console.log("[best-efforts-repair] REPORT", JSON.stringify({ ...report, diffs: report.diffs.length }, null, 2));
  return report;
}

export function repairBestEffortsFreshness(
  options: BestEffortRepairOptions
): Promise<BestEffortRepairReport> {
  return repairBestEffortsFreshnessWithStore(options, createAdminStore());
}
