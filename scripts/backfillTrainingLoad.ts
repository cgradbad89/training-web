/**
 * Admin backfill: compute & STORE trainingLoadV2 + trainingLoadMethod for the
 * user's runs over the last 12 months.
 *
 * KEPT script. There is no TS runner (tsx/ts-node) in this repo, so it is driven
 * by an env-gated Vitest entry (scripts/backfillTrainingLoad.test.ts) which
 * Vitest can run with its TS + "@/" alias support, no new dependency:
 *
 *   Dry-run (writes NOTHING, prints the table + summary):
 *     BACKFILL=1 npx vitest run scripts/backfillTrainingLoad.test.ts
 *   Commit (performs the merge writes):
 *     BACKFILL=commit npx vitest run scripts/backfillTrainingLoad.test.ts
 *   Optional explicit uid:
 *     BACKFILL=1 BACKFILL_UID=<uid> npx vitest run scripts/backfillTrainingLoad.test.ts
 *
 * Reuses the EXACT exported math (computeStreamedTrainingLoad /
 * computeTrainingLoadV2) — the script only does the admin-SDK fetch/store
 * plumbing (the client-SDK computeAndStoreTrainingLoad can't run under admin).
 * Owner field-merge to healthWorkouts is already permitted (Prompt 2 rule check).
 */

import { readFileSync } from "node:fs";
import admin from "firebase-admin";
import {
  computeStreamedTrainingLoad,
  computeTrainingLoadV2,
  resolveMaxHr,
  resolveRestingHr,
  DEFAULT_RESTING_HR,
  STREAMED_HR_COVERAGE_MIN,
  MIN_HRSTREAM_SAMPLES,
} from "@/utils/trainingLoad";
import { type UserSettings } from "@/types/userSettings";

const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;
const WRITE_BATCH_SIZE = 400; // < Firestore's 500-op batch cap

interface BackfillOptions {
  commit?: boolean;
  uid?: string;
  /** Epoch ms for "now" — injectable for determinism; defaults to Date.now(). */
  nowMs?: number;
}

export interface BackfillSummary {
  uid: string;
  usedRestingHrDefault: boolean;
  maxHr: number;
  restingHr: number;
  selected: number;
  processed: number;
  streamed: number;
  fallback: number;
  skipped: number;
  written: number;
  committed: boolean;
}

function loadServiceAccount(): Record<string, unknown> {
  const env = readFileSync(".env.local", "utf8");
  const line = env
    .split("\n")
    .find((l) => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON="));
  if (!line) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON not found in .env.local");
  let val = line.slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length).trim();
  if (
    (val.startsWith("'") && val.endsWith("'")) ||
    (val.startsWith('"') && val.endsWith('"'))
  ) {
    val = val.slice(1, -1);
  }
  return JSON.parse(val);
}

function getDb(): admin.firestore.Firestore {
  if (!admin.apps.length) {
    const svc = loadServiceAccount();
    admin.initializeApp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      credential: admin.credential.cert(svc as any),
    });
  }
  return admin.firestore();
}

async function resolveUid(
  db: admin.firestore.Firestore,
  override?: string
): Promise<string> {
  if (override) return override;
  // Single-user app: find any healthWorkouts doc and read its owner uid.
  const cg = await db.collectionGroup("healthWorkouts").limit(1).get();
  if (cg.empty) throw new Error("No healthWorkouts found; pass BACKFILL_UID=<uid>");
  // path: users/{uid}/healthWorkouts/{id}
  const parts = cg.docs[0].ref.path.split("/");
  return parts[1];
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface Row {
  workoutId: string;
  date: string;
  distanceMiles: number;
  avgHR: number | null;
  method: "streamed" | "avg-hr-fallback";
  hrCoverage: number;
  load: number | null;
}

export async function runBackfillTrainingLoad(
  opts: BackfillOptions = {}
): Promise<BackfillSummary> {
  const commit = opts.commit === true;
  const nowMs = opts.nowMs ?? Date.now();
  const db = getDb();
  const uid = await resolveUid(db, opts.uid);

  // Resolve HR anchors from settings (users/{uid}/settings/prefs).
  const prefsSnap = await db.doc(`users/${uid}/settings/prefs`).get();
  const prefs = (prefsSnap.exists ? prefsSnap.data() : {}) as Partial<UserSettings>;
  const usedRestingHrDefault =
    typeof prefs.restingHeartRate !== "number" ||
    !Number.isFinite(prefs.restingHeartRate);
  const settingsLike = {
    maxHeartRate: prefs.maxHeartRate,
    restingHeartRate: prefs.restingHeartRate,
  } as UserSettings;
  const maxHr = resolveMaxHr(settingsLike);
  const restingHr = resolveRestingHr(settingsLike);

  if (usedRestingHrDefault) {
    console.log(
      `[backfill] restingHeartRate not set — defaulting to DEFAULT_RESTING_HR=${DEFAULT_RESTING_HR}.`
    );
  }

  // Select run-like workouts in the last 12 months.
  const cutoffMs = nowMs - TWELVE_MONTHS_MS;
  const cutoffTs = admin.firestore.Timestamp.fromMillis(cutoffMs);
  const snap = await db
    .collection(`users/${uid}/healthWorkouts`)
    .where("isRunLike", "==", true)
    .where("startDate", ">=", cutoffTs)
    .orderBy("startDate", "desc")
    .get();

  console.log(
    `[backfill] uid=${uid} mode=${commit ? "COMMIT" : "DRY-RUN"} ` +
      `maxHr=${maxHr} restingHr=${restingHr} selected=${snap.size} (last 12mo)`
  );

  const rows: Row[] = [];
  const summary: BackfillSummary = {
    uid,
    usedRestingHrDefault,
    maxHr,
    restingHr,
    selected: snap.size,
    processed: 0,
    streamed: 0,
    fallback: 0,
    skipped: 0,
    written: 0,
    committed: commit,
  };

  // Accumulate writes to batch later (commit mode only).
  const writes: Array<{ ref: admin.firestore.DocumentReference; data: Record<string, unknown> }> =
    [];

  for (const docSnap of snap.docs) {
    const data = docSnap.data() as Record<string, unknown>;
    const durationSeconds = (data.durationSeconds as number) ?? 0;
    const avgHeartRate = (data.avgHeartRate as number | null) ?? null;
    const activityType = (data.activityType as string) ?? undefined;
    const hasRoute = (data.hasRoute as boolean) ?? false;
    const hasHRStream = (data.hasHRStream as boolean) ?? false;
    const distanceMiles = (data.distanceMiles as number) ?? 0;
    const startDate =
      data.startDate && typeof (data.startDate as { toDate?: () => Date }).toDate === "function"
        ? (data.startDate as { toDate: () => Date }).toDate()
        : new Date(0);

    let load: number | null;
    let method: "streamed" | "avg-hr-fallback";
    let hrCoverage = 0;

    // 3-tier method-selection — matches computeAndStoreTrainingLoad:
    //   1. hasRoute    → streamed integral over route-point HR (UNCHANGED).
    //   2. hasHRStream → streamed integral over the iOS hrStream subcollection.
    //   3. else        → avg-HR Banister baseline.
    if (hasRoute) {
      const routeSnap = await db
        .collection(`users/${uid}/healthWorkouts/${docSnap.id}/route`)
        .orderBy("index", "asc")
        .get();
      const points = routeSnap.docs.map((d) => {
        const r = d.data() as Record<string, unknown>;
        const ts = r.timestamp as { toDate?: () => Date } | null;
        return {
          timestamp: ts?.toDate?.()?.toISOString() ?? "",
          hr: (r.hr as number | null) ?? null,
        };
      });
      const result = computeStreamedTrainingLoad(
        points,
        durationSeconds,
        avgHeartRate,
        maxHr,
        restingHr,
        activityType
      );
      load = result.load;
      method = result.method;
      hrCoverage = result.hrCoverage;
    } else if (hasHRStream) {
      // Read users/{uid}/healthWorkouts/{id}/hrStream ascending by chunkIndex;
      // concatenate each doc's samples ({ t: Timestamp, hr: Int }) in order.
      const streamSnap = await db
        .collection(`users/${uid}/healthWorkouts/${docSnap.id}/hrStream`)
        .orderBy("chunkIndex", "asc")
        .get();
      const samples: { timestamp: string; hr: number }[] = [];
      for (const d of streamSnap.docs) {
        const r = d.data() as Record<string, unknown>;
        const chunk = Array.isArray(r.samples)
          ? (r.samples as Array<{ t?: { toDate?: () => Date } | null; hr?: number }>)
          : [];
        for (const s of chunk) {
          samples.push({
            timestamp: s.t?.toDate?.()?.toISOString() ?? "",
            hr: (s.hr as number) ?? 0,
          });
        }
      }
      if (samples.length >= MIN_HRSTREAM_SAMPLES) {
        const result = computeStreamedTrainingLoad(
          samples,
          durationSeconds,
          avgHeartRate,
          maxHr,
          restingHr,
          activityType
        );
        load = result.load;
        method = result.method;
        hrCoverage = result.hrCoverage;
      } else {
        // Empty/too-sparse stream despite the flag → avg-HR fallback.
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
      load = computeTrainingLoadV2(
        durationSeconds,
        avgHeartRate,
        maxHr,
        restingHr,
        activityType
      );
      method = "avg-hr-fallback";
    }

    rows.push({
      workoutId: docSnap.id,
      date: fmtDate(startDate),
      distanceMiles: Math.round(distanceMiles * 100) / 100,
      avgHR: avgHeartRate,
      method,
      hrCoverage: Math.round(hrCoverage * 100) / 100,
      load,
    });

    summary.processed += 1;
    if (load == null) {
      // null load → SKIP (do not write 0). UI falls back to live → "—".
      summary.skipped += 1;
      continue;
    }
    if (method === "streamed") summary.streamed += 1;
    else summary.fallback += 1;

    writes.push({
      ref: docSnap.ref,
      data: { trainingLoadV2: load, trainingLoadMethod: method },
    });
  }

  // Per-run table (dry-run shows the full picture; commit shows it too).
  console.log(
    `[backfill] per-run (${rows.length} rows): date | dist | avgHR | method | cov | load`
  );
  console.table(rows);

  const weeklyTotal = rows
    .map((r) => r.load)
    .filter((v): v is number => v != null)
    .reduce((a, b) => a + b, 0);
  console.log(
    `[backfill] totals: streamed=${summary.streamed} fallback=${summary.fallback} ` +
      `skipped(null)=${summary.skipped} | sum(load)=${weeklyTotal}`
  );

  if (commit && writes.length > 0) {
    for (let i = 0; i < writes.length; i += WRITE_BATCH_SIZE) {
      const batch = db.batch();
      for (const w of writes.slice(i, i + WRITE_BATCH_SIZE)) {
        // stripUndefined-equivalent: load/method are always defined here.
        batch.set(w.ref, w.data, { merge: true });
      }
      await batch.commit();
      summary.written += Math.min(WRITE_BATCH_SIZE, writes.length - i);
    }
    console.log(`[backfill] COMMIT complete — wrote ${summary.written} docs.`);
  } else if (!commit) {
    console.log(
      `[backfill] DRY-RUN — wrote 0 docs (would write ${writes.length}). ` +
        `Re-run with BACKFILL=commit to persist.`
    );
  }

  return summary;
}
