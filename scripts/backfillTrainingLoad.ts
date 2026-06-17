/**
 * Admin backfill: compute & STORE trainingLoadV2 + trainingLoadMethod for ALL
 * of the user's HR-bearing workouts over the last 12 months (not runs-only).
 *
 * Selection (widened in this follow-up): every healthWorkouts doc with
 * startDate within the last 365 days that has a usable HR basis —
 * hasRoute || hasHRStream || a finite positive avgHeartRate. Firestore can't
 * cleanly OR those three predicates with the date inequality, so the query is
 * the date window only (startDate >= cutoff, newest-first) and the OR is applied
 * in memory; docs with NO basis are counted as skipped(no-HR-basis) and never
 * compute (they could only yield a null load). The per-workout 3-tier compute
 * (route → hrStream → avg-HR) is UNCHANGED — selection decides which workouts
 * are iterated, the chain decides each workout's method.
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

import { readFileSync, writeFileSync } from "node:fs";
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
  /** When true (commit only), restrict writes to STALE-flagged docs (see
   *  isStaleLoad) instead of every processed doc. Opt-in; does NOT change the
   *  default commit behavior. Used by the targeted two-pass-collapse repair. */
  staleOnly?: boolean;
  /** When true (commit only), restrict writes to docs whose stored load is
   *  MISSING (null/0) but which have an HR basis — i.e. the audit's MISSING_LOAD
   *  class. Opt-in; combines with staleOnly (write if stale OR missing). Does NOT
   *  change the default commit behavior. */
  missingOnly?: boolean;
}

export interface BackfillSummary {
  uid: string;
  usedRestingHrDefault: boolean;
  maxHr: number;
  restingHr: number;
  /** Total docs returned by the 365-day date-window query (pre HR-basis filter). */
  selectedInWindow: number;
  /** Docs with a usable HR basis — the ones actually computed. */
  selected: number;
  /** Excluded pre-compute: no route, no hrStream, no finite positive avgHR. */
  skippedNoHrBasis: number;
  processed: number;
  /** method "streamed" sourced from the route subcollection. */
  streamedRoute: number;
  /** method "streamed" sourced from the hrStream subcollection. */
  streamedHrStream: number;
  /** method "avg-hr-fallback" (incl. route/stream that fell back on low coverage). */
  fallback: number;
  /** Computed but load was null (not written; UI falls back to "—"). */
  skipped: number;
  /** READ-ONLY report metric: docs whose stored "streamed" load is a stale
   *  two-pass collapse vs the fresh recompute (see isStaleLoad). */
  staleFlagged: number;
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

export function getDb(): admin.firestore.Firestore {
  if (!admin.apps.length) {
    const svc = loadServiceAccount();
    admin.initializeApp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      credential: admin.credential.cert(svc as any),
    });
  }
  return admin.firestore();
}

export async function resolveUid(
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
  type: string;
  distanceMiles: number;
  durationMin: number;
  avgHR: number | null;
  /** Which tier's data fed the compute (independent of the resulting method). */
  source: "route" | "hrStream" | "avg-hr";
  method: "streamed" | "avg-hr-fallback" | "none";
  hrCoverage: number;
  load: number | null;
  /** Currently-stored trainingLoadV2 on the doc (what the UI shows today). */
  storedLoad: number | null;
  /** Currently-stored trainingLoadMethod on the doc. */
  storedMethod: string | undefined;
  /** True when the stored value is a two-pass-sync STALE collapse (see isStaleLoad). */
  stale: boolean;
}

// ─── Stale-value detection (READ-ONLY report; does NOT affect commit writes) ──
//
// A two-pass iOS sync can leave a "streamed" trainingLoadV2 computed mid-sync over
// a PARTIAL stream that was never recomputed after the resume completed (e.g. 6/16:
// stored 14, now-complete stream recomputes to 187). We flag such a run when its
// stored method is "streamed" AND the fresh recompute is materially HIGHER than the
// stored value — i.e. a collapse, not normal rounding. The recompute is idempotent
// under unchanged anchors (a healthy run recomputes to within rounding of its stored
// value — see 6/9), so this threshold cleanly separates the collapse class.
export const STALE_ABS_GAP = 25; // recomputed − stored ≥ 25 load points → stale
export const STALE_RATIO = 1.5; // OR recomputed ≥ 1.5× stored …
export const STALE_RATIO_MIN_GAP = 10; // … but only when backed by a ≥10 abs gap

export function isStaleLoad(
  storedLoad: number | null,
  storedMethod: string | undefined,
  recomputed: number | null
): boolean {
  if (storedMethod !== "streamed") return false;
  if (storedLoad == null || !Number.isFinite(storedLoad)) return false;
  if (recomputed == null || !Number.isFinite(recomputed)) return false;
  // Collapse class: the fresh recompute is materially HIGHER than the stored
  // (mid-sync) value — a big absolute jump, OR a clear ratio jump backed by a
  // non-trivial absolute gap. The gap floors are ESSENTIAL: a ratio-only test
  // wrongly flags the degenerate stored == recomputed case (e.g. 0→0, where
  // 1.5×0 = 0 makes "recomputed ≥ 1.5×stored" trivially true). A run that
  // recomputes to the SAME value (no discrepancy) is never stale.
  const gap = recomputed - storedLoad;
  return (
    gap >= STALE_ABS_GAP ||
    (storedLoad > 0 && recomputed >= STALE_RATIO * storedLoad && gap >= STALE_RATIO_MIN_GAP)
  );
}

export interface RecomputeResult {
  load: number | null;
  method: "streamed" | "avg-hr-fallback" | "none";
  /** Which tier's data fed the compute (independent of the resulting method). */
  source: "route" | "hrStream" | "avg-hr";
  /** Fraction of points with finite HR (0 for the avg-HR tier). */
  hrCoverage: number;
  /** Route/hrStream samples actually read (0 for the avg-HR tier). */
  pointCount: number;
}

/**
 * Recompute trainingLoadV2 for ONE doc via the 3-tier chain (route → hrStream →
 * avg-HR), reading the relevant subcollection under the admin SDK. Extracted so
 * both the backfill writer and the read-only audit (scripts/auditRunQuality.ts)
 * share ONE recompute path — same math, no duplication. Pure read; never writes.
 */
export async function recomputeLoadForDoc(
  db: admin.firestore.Firestore,
  uid: string,
  docId: string,
  data: Record<string, unknown>,
  maxHr: number,
  restingHr: number
): Promise<RecomputeResult> {
  const durationSeconds = (data.durationSeconds as number) ?? 0;
  const avgHeartRate = (data.avgHeartRate as number | null) ?? null;
  const activityType = (data.activityType as string) ?? undefined;
  const hasRoute = (data.hasRoute as boolean) ?? false;
  const hasHRStream = (data.hasHRStream as boolean) ?? false;

  // Tier 1 — route runs: per-second integral over route-point HR (UNCHANGED).
  if (hasRoute) {
    const routeSnap = await db
      .collection(`users/${uid}/healthWorkouts/${docId}/route`)
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
      activityType,
      docId
    );
    return {
      load: result.load,
      method: result.method,
      hrCoverage: result.hrCoverage,
      source: "route",
      pointCount: points.length,
    };
  }

  // Tier 2 — non-route workouts with an iOS hrStream subcollection.
  if (hasHRStream) {
    const streamSnap = await db
      .collection(`users/${uid}/healthWorkouts/${docId}/hrStream`)
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
        activityType,
        docId
      );
      return {
        load: result.load,
        method: result.method,
        hrCoverage: result.hrCoverage,
        source: "hrStream",
        pointCount: samples.length,
      };
    }
    // Empty/too-sparse stream despite the flag → avg-HR fallback.
    return {
      load: computeTrainingLoadV2(durationSeconds, avgHeartRate, maxHr, restingHr, activityType),
      method: "avg-hr-fallback",
      hrCoverage: 0,
      source: "avg-hr",
      pointCount: samples.length,
    };
  }

  // Tier 3 — avg-HR Banister baseline.
  return {
    load: computeTrainingLoadV2(durationSeconds, avgHeartRate, maxHr, restingHr, activityType),
    method: "avg-hr-fallback",
    hrCoverage: 0,
    source: "avg-hr",
    pointCount: 0,
  };
}

export async function runBackfillTrainingLoad(
  opts: BackfillOptions = {}
): Promise<BackfillSummary> {
  const commit = opts.commit === true;
  const staleOnly = opts.staleOnly === true;
  const missingOnly = opts.missingOnly === true;
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

  // Select ALL workouts in the last 12 months by the date window only; the
  // hasRoute || hasHRStream || finite-avgHR basis filter is applied in memory
  // below (Firestore can't OR those field predicates with the date inequality).
  const cutoffMs = nowMs - TWELVE_MONTHS_MS;
  const cutoffTs = admin.firestore.Timestamp.fromMillis(cutoffMs);
  const snap = await db
    .collection(`users/${uid}/healthWorkouts`)
    .where("startDate", ">=", cutoffTs)
    .orderBy("startDate", "desc")
    .get();

  console.log(
    `[backfill] uid=${uid} mode=${commit ? "COMMIT" : "DRY-RUN"}` +
      `${staleOnly ? " [STALE-ONLY]" : ""}${missingOnly ? " [MISSING-ONLY]" : ""} ` +
      `maxHr=${maxHr} restingHr=${restingHr} selectedInWindow=${snap.size} ` +
      `(last 12mo, all types — HR-basis filtered in memory)`
  );

  const rows: Row[] = [];
  const summary: BackfillSummary = {
    uid,
    usedRestingHrDefault,
    maxHr,
    restingHr,
    selectedInWindow: snap.size,
    selected: 0,
    skippedNoHrBasis: 0,
    processed: 0,
    streamedRoute: 0,
    streamedHrStream: 0,
    fallback: 0,
    skipped: 0,
    staleFlagged: 0,
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
    // Currently-stored values (READ-ONLY — for the staleness report only).
    const storedLoad =
      typeof data.trainingLoadV2 === "number" && Number.isFinite(data.trainingLoadV2)
        ? (data.trainingLoadV2 as number)
        : null;
    const storedMethod =
      data.trainingLoadMethod === "streamed" ||
      data.trainingLoadMethod === "avg-hr-fallback"
        ? (data.trainingLoadMethod as string)
        : undefined;
    const displayType = (data.displayType as string) ?? (activityType ?? "Workout");
    const startDate =
      data.startDate && typeof (data.startDate as { toDate?: () => Date }).toDate === "function"
        ? (data.startDate as { toDate: () => Date }).toDate()
        : new Date(0);

    // HR-basis filter (in-memory OR): only compute workouts that can yield a
    // non-null load. No route, no stream, and no finite positive avgHR ⇒ the
    // 3-tier chain could only return null, so exclude pre-compute.
    const hasFiniteAvgHr =
      typeof avgHeartRate === "number" &&
      Number.isFinite(avgHeartRate) &&
      avgHeartRate > 0;
    if (!hasRoute && !hasHRStream && !hasFiniteAvgHr) {
      summary.skippedNoHrBasis += 1;
      continue;
    }
    summary.selected += 1;

    // 3-tier method-selection (route → hrStream → avg-HR) via the shared helper
    // — same recompute path the read-only audit uses.
    const { load, method, source, hrCoverage } = await recomputeLoadForDoc(
      db,
      uid,
      docSnap.id,
      data,
      maxHr,
      restingHr
    );

    const stale = isStaleLoad(storedLoad, storedMethod, load);
    rows.push({
      workoutId: docSnap.id,
      date: fmtDate(startDate),
      type: displayType,
      distanceMiles: Math.round(distanceMiles * 100) / 100,
      durationMin: Math.round((durationSeconds / 60) * 10) / 10,
      avgHR: avgHeartRate == null ? null : Math.round(avgHeartRate),
      source,
      method,
      hrCoverage: Math.round(hrCoverage * 100) / 100,
      load,
      storedLoad,
      storedMethod,
      stale,
    });
    if (stale) summary.staleFlagged += 1;

    summary.processed += 1;
    if (load == null) {
      // null load → SKIP (do not write 0). UI falls back to live → "—".
      summary.skipped += 1;
      continue;
    }
    if (method === "streamed") {
      if (source === "route") summary.streamedRoute += 1;
      else summary.streamedHrStream += 1;
    } else {
      summary.fallback += 1;
    }

    // Write selection. Default (no targeting): queue every processed doc
    // (idempotent). Targeted: queue ONLY the requested repair class —
    //   staleOnly   → two-pass-collapse repairs (stale)
    //   missingOnly → docs with a null/0 stored load (MISSING_LOAD)
    // Both flags combine (write if stale OR missing). Untargeted docs untouched.
    const isMissing = storedLoad == null || storedLoad === 0;
    const targeted = staleOnly || missingOnly;
    const include =
      !targeted || (staleOnly && stale) || (missingOnly && isMissing);
    if (include) {
      writes.push({
        ref: docSnap.ref,
        data: { trainingLoadV2: load, trainingLoadMethod: method },
      });
    }
  }

  // Per-workout table (dry-run shows the full picture; commit shows it too).
  console.log(
    `[backfill] per-workout (${rows.length} rows): date | type | dist | avgHR | source | method | cov | load`
  );
  console.table(rows);

  const totalLoad = rows
    .map((r) => r.load)
    .filter((v): v is number => v != null)
    .reduce((a, b) => a + b, 0);
  console.log(
    `[backfill] method breakdown (of ${summary.selectedInWindow} in window): ` +
      `streamed(route)=${summary.streamedRoute} ` +
      `streamed(hrStream)=${summary.streamedHrStream} ` +
      `avg-hr-fallback=${summary.fallback} ` +
      `skipped(no-HR-basis)=${summary.skippedNoHrBasis} ` +
      `| skipped(null-load)=${summary.skipped} | sum(load)=${totalLoad}`
  );

  // ─── Stale-value REPORT (read-only) ────────────────────────────────────────
  // Flag stored "streamed" loads that the fresh recompute reveals as two-pass
  // collapses. Columns match the repair brief: docId|date|miles|durationMin|
  // avgHR|storedLoad|recomputedLoad|storedMethod.
  const staleRows = rows.filter((r) => r.stale);
  console.log(
    `[backfill] STALE flagged (storedMethod="streamed" AND recomputed >= ${STALE_RATIO}x stored OR gap >= ${STALE_ABS_GAP}): ${staleRows.length}`
  );
  const staleReport = staleRows.map((r) => ({
    docId: r.workoutId,
    date: r.date,
    miles: r.distanceMiles,
    durationMin: r.durationMin,
    avgHR: r.avgHR,
    storedLoad: r.storedLoad,
    recomputedLoad: r.load,
    storedMethod: r.storedMethod,
  }));
  console.table(staleReport);

  // Vitest buffers console output, so optionally dump a plain-text report to a
  // file for reliable capture. Opt-in via BACKFILL_REPORT=<path>; READ-ONLY.
  const reportPath = process.env.BACKFILL_REPORT;
  if (reportPath) {
    const lines: string[] = [];
    lines.push(
      `[backfill] mode=${commit ? "COMMIT" : "DRY-RUN"} uid=${uid} maxHr=${maxHr} restingHr=${restingHr}`
    );
    // NB: this file is written before the commit batch runs, so report the
    // queued write count (what was/will be written) rather than summary.written
    // (still 0 at this point). writesQueued === docs committed in commit mode.
    lines.push(
      `selectedInWindow=${summary.selectedInWindow} selected=${summary.selected} ` +
        `processed=${summary.processed} staleFlagged=${summary.staleFlagged} ` +
        `writesQueued=${writes.length}${commit ? "" : " (DRY-RUN: not written)"}`
    );
    lines.push("");
    lines.push(`ALL stored-"streamed" rows (stored vs recomputed):`);
    for (const r of rows.filter((x) => x.storedMethod === "streamed")) {
      lines.push(
        `  ${r.stale ? "STALE" : " ok  "} ${r.date} ${r.workoutId} ` +
          `miles=${r.distanceMiles} durMin=${r.durationMin} avgHR=${r.avgHR} ` +
          `stored=${r.storedLoad} recomputed=${r.load} method=${r.storedMethod}`
      );
    }
    lines.push("");
    lines.push(`STALE-FLAGGED (${staleReport.length}):`);
    for (const r of staleReport) lines.push(`  ${JSON.stringify(r)}`);
    writeFileSync(reportPath, lines.join("\n"), "utf8");
    console.log(`[backfill] wrote report to ${reportPath}`);
  }

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
