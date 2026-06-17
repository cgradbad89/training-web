/**
 * READ-ONLY data-quality audit for run-like workouts over the last 12 months.
 *
 * Flags load-score anomalies (STALE_LOAD / COLLAPSED_LOAD / MISSING_LOAD) and
 * missing/incomplete subcollections (MISSING_ROUTE / MISSING_SPLITS /
 * MISSING_HRSTREAM). Performs NO writes — it only reports. The authorized repairs
 * (STALE_LOAD, MISSING_LOAD) are applied separately by re-running the existing
 * backfill commit (BACKFILL_STALE_ONLY / BACKFILL_MISSING_ONLY).
 *
 * Reuses the existing harness end-to-end — admin SDK setup (getDb/resolveUid),
 * the 3-tier recompute (recomputeLoadForDoc), the stale threshold (isStaleLoad),
 * and the load math (computeTrainingLoadV2/resolveMaxHr/resolveRestingHr). No
 * duplicated compute or Firestore-setup code.
 *
 * Driven by the same env-gated Vitest pattern as the backfill (no TS runner in
 * this repo):
 *   Dry scan + report file:
 *     AUDIT=1 AUDIT_REPORT=/tmp/audit_report.txt npx vitest run scripts/auditRunQuality.test.ts
 *   Optional explicit uid:
 *     AUDIT=1 AUDIT_UID=<uid> npx vitest run scripts/auditRunQuality.test.ts
 *
 * NON-RUN companion (OTF/HIIT, strength, mindful, yoga, …) lives in the same file
 * (runAuditWorkoutQuality / classifyWorkoutFlags / renderWorkoutReport). It scans
 * isRunLike !== true docs over the SAME 12-month window, reusing every helper
 * here; route/splits checks are dropped (non-runs have no GPS), leaving load-score
 * health (STALE/COLLAPSED/MISSING_LOAD) + hrStream presence (MISSING_HRSTREAM):
 *   WORKOUT_AUDIT=1 WORKOUT_AUDIT_REPORT=/tmp/audit_workout_report.txt \
 *     AUDIT_UID=<uid> npx vitest run scripts/auditRunQuality.test.ts
 */

import { writeFileSync } from "node:fs";
import admin from "firebase-admin";
import {
  computeTrainingLoadV2,
  resolveMaxHr,
  resolveRestingHr,
} from "@/utils/trainingLoad";
import {
  getDb,
  resolveUid,
  recomputeLoadForDoc,
  isStaleLoad,
} from "./backfillTrainingLoad";
import { type UserSettings } from "@/types/userSettings";

const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;
/** COLLAPSED_LOAD: stored is < this fraction of the avg-HR-fallback reference. */
export const COLLAPSED_RATIO = 0.3;

export type RunQualityFlag =
  | "STALE_LOAD"
  | "COLLAPSED_LOAD"
  | "MISSING_LOAD"
  | "MISSING_ROUTE"
  | "MISSING_SPLITS"
  | "MISSING_HRSTREAM";

export const ALL_FLAGS: RunQualityFlag[] = [
  "STALE_LOAD",
  "COLLAPSED_LOAD",
  "MISSING_LOAD",
  "MISSING_ROUTE",
  "MISSING_SPLITS",
  "MISSING_HRSTREAM",
];

/** Pure classifier inputs — everything `classifyRunFlags` needs, no Firestore. */
export interface RunFlagInputs {
  activityType?: string;
  distanceMiles: number;
  durationSeconds: number;
  avgHeartRate: number | null;
  hasRoute: boolean;
  hasHRStream: boolean;
  /** Doc count of the mileSplits subcollection (presence, not content). */
  mileSplitsCount: number;
  storedLoad: number | null;
  storedMethod: string | undefined;
  /** Fresh recompute from the CURRENT route/hrStream (recomputeLoadForDoc). */
  recomputedLoad: number | null;
  /** Whole-run avg-HR Banister reference (computeTrainingLoadV2). */
  avgHrFallbackLoad: number | null;
}

/**
 * Pure flag classifier — the heart of the audit, kept side-effect-free so it can
 * be unit-tested without Firestore. A run can earn multiple flags.
 *
 * NB: the brief's MISSING_SPLITS uses a `hasMileHRSplits` boolean, but no such
 * field exists on the doc — presence is detected via the mileSplits doc count
 * (`mileSplitsCount < 1`) instead. MISSING_ROUTE uses the type/distance heuristic
 * (no `isGpsRun` field exists either).
 */
export function classifyRunFlags(i: RunFlagInputs): RunQualityFlag[] {
  const flags: RunQualityFlag[] = [];
  const hasHr =
    i.avgHeartRate != null && Number.isFinite(i.avgHeartRate) && i.avgHeartRate > 0;

  // ── LOAD SCORE FLAGS ──────────────────────────────────────────────────────
  // STALE_LOAD — stored "streamed" but the fresh recompute is materially higher
  // (two-pass collapse). Reuses the exact backfill threshold.
  if (isStaleLoad(i.storedLoad, i.storedMethod, i.recomputedLoad)) {
    flags.push("STALE_LOAD");
  }
  // COLLAPSED_LOAD — stored > 0 but implausibly low vs the avg-HR reference. (A
  // recompute can't necessarily fix this — the stream may be genuinely
  // degenerate — so it is MANUAL-REVIEW, not auto-fixed.)
  if (
    i.storedLoad != null &&
    i.storedLoad > 0 &&
    i.avgHrFallbackLoad != null &&
    i.avgHrFallbackLoad > 0 &&
    i.storedLoad < COLLAPSED_RATIO * i.avgHrFallbackLoad
  ) {
    flags.push("COLLAPSED_LOAD");
  }
  // MISSING_LOAD — no stored load at all (null/0) despite present HR data.
  if ((i.storedLoad == null || i.storedLoad === 0) && hasHr) {
    flags.push("MISSING_LOAD");
  }

  // ── SUBCOLLECTION FLAGS ───────────────────────────────────────────────────
  const isGpsRunByType =
    (i.activityType ?? "").toLowerCase().includes("running") &&
    i.distanceMiles > 0.5;
  // MISSING_ROUTE — a GPS-type run with no route flag.
  if (isGpsRunByType && i.hasRoute !== true) {
    flags.push("MISSING_ROUTE");
  }
  // MISSING_SPLITS — a route run > 5 min with no mileSplits docs.
  if (i.hasRoute === true && i.mileSplitsCount < 1 && i.durationSeconds > 300) {
    flags.push("MISSING_SPLITS");
  }
  // MISSING_HRSTREAM — a route run with no hrStream flag.
  if (i.hasRoute === true && i.hasHRStream !== true) {
    flags.push("MISSING_HRSTREAM");
  }

  return flags;
}

export interface AuditRow {
  workoutId: string;
  date: string;
  type: string;
  distanceMiles: number;
  durationMin: number;
  avgHR: number | null;
  storedLoad: number | null;
  storedMethod: string | undefined;
  recomputedLoad: number | null;
  avgHrFallbackLoad: number | null;
  routeCount: number;
  mileSplitsCount: number;
  hasRoute: boolean;
  hasHRStream: boolean;
  flags: RunQualityFlag[];
}

export interface AuditSummary {
  uid: string;
  maxHr: number;
  restingHr: number;
  /** Run-like docs scanned in the 12-month window. */
  totalRunLike: number;
  /** Count by flag type (a run may contribute to several). */
  flagCounts: Record<RunQualityFlag, number>;
  /** Run-like docs with ZERO flags. */
  cleanCount: number;
  /** Only the FLAGGED rows (clean rows are summarized by cleanCount). */
  flaggedRows: AuditRow[];
  /** docIds for the two authorized auto-fix classes. */
  staleDocIds: string[];
  missingLoadDocIds: string[];
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function countSub(
  db: admin.firestore.Firestore,
  uid: string,
  docId: string,
  sub: string
): Promise<number> {
  const agg = await db
    .collection(`users/${uid}/healthWorkouts/${docId}/${sub}`)
    .count()
    .get();
  return agg.data().count;
}

export async function runAuditRunQuality(
  opts: { uid?: string; nowMs?: number; reportPath?: string } = {}
): Promise<AuditSummary> {
  const nowMs = opts.nowMs ?? Date.now();
  const db = getDb();
  const uid = await resolveUid(db, opts.uid);

  // Anchors from settings/prefs — same source the backfill uses (no hardcoding).
  const prefsSnap = await db.doc(`users/${uid}/settings/prefs`).get();
  const prefs = (prefsSnap.exists ? prefsSnap.data() : {}) as Partial<UserSettings>;
  const settingsLike = {
    maxHeartRate: prefs.maxHeartRate,
    restingHeartRate: prefs.restingHeartRate,
  } as UserSettings;
  const maxHr = resolveMaxHr(settingsLike);
  const restingHr = resolveRestingHr(settingsLike);

  // 12-month window (date filter only; isRunLike filtered in memory to avoid a
  // composite index — same approach the backfill uses for its HR-basis filter).
  const cutoffTs = admin.firestore.Timestamp.fromMillis(nowMs - TWELVE_MONTHS_MS);
  const snap = await db
    .collection(`users/${uid}/healthWorkouts`)
    .where("startDate", ">=", cutoffTs)
    .orderBy("startDate", "desc")
    .get();

  const flagCounts = Object.fromEntries(
    ALL_FLAGS.map((f) => [f, 0])
  ) as Record<RunQualityFlag, number>;
  const flaggedRows: AuditRow[] = [];
  const staleDocIds: string[] = [];
  const missingLoadDocIds: string[] = [];
  let totalRunLike = 0;
  let cleanCount = 0;

  for (const docSnap of snap.docs) {
    const data = docSnap.data() as Record<string, unknown>;
    if (data.isRunLike !== true) continue; // run-like only
    totalRunLike += 1;

    const durationSeconds = (data.durationSeconds as number) ?? 0;
    const avgHeartRate = (data.avgHeartRate as number | null) ?? null;
    const activityType = (data.activityType as string) ?? undefined;
    const hasRoute = (data.hasRoute as boolean) ?? false;
    const hasHRStream = (data.hasHRStream as boolean) ?? false;
    const distanceMiles = (data.distanceMiles as number) ?? 0;
    const displayType = (data.displayType as string) ?? (activityType ?? "Workout");
    const startDate =
      data.startDate &&
      typeof (data.startDate as { toDate?: () => Date }).toDate === "function"
        ? (data.startDate as { toDate: () => Date }).toDate()
        : new Date(0);
    const storedLoad =
      typeof data.trainingLoadV2 === "number" &&
      Number.isFinite(data.trainingLoadV2)
        ? (data.trainingLoadV2 as number)
        : null;
    const storedMethod =
      data.trainingLoadMethod === "streamed" ||
      data.trainingLoadMethod === "avg-hr-fallback"
        ? (data.trainingLoadMethod as string)
        : undefined;

    // Fresh recompute (reads route/hrStream) + the avg-HR reference.
    const rc = await recomputeLoadForDoc(db, uid, docSnap.id, data, maxHr, restingHr);
    const avgHrFallbackLoad = computeTrainingLoadV2(
      durationSeconds,
      avgHeartRate,
      maxHr,
      restingHr,
      activityType
    );

    // Subcollection presence (cheap server-side aggregations — read no points).
    const mileSplitsCount = await countSub(db, uid, docSnap.id, "mileSplits");
    // recomputeLoadForDoc already read the route when hasRoute → reuse its count;
    // otherwise probe (catches "route exists but hasRoute flag is stale").
    const routeCount =
      rc.source === "route"
        ? rc.pointCount
        : await countSub(db, uid, docSnap.id, "route");

    const flags = classifyRunFlags({
      activityType,
      distanceMiles,
      durationSeconds,
      avgHeartRate,
      hasRoute,
      hasHRStream,
      mileSplitsCount,
      storedLoad,
      storedMethod,
      recomputedLoad: rc.load,
      avgHrFallbackLoad,
    });

    for (const f of flags) flagCounts[f] += 1;
    if (flags.includes("STALE_LOAD")) staleDocIds.push(docSnap.id);
    if (flags.includes("MISSING_LOAD")) missingLoadDocIds.push(docSnap.id);

    if (flags.length === 0) {
      cleanCount += 1;
      continue;
    }

    flaggedRows.push({
      workoutId: docSnap.id,
      date: fmtDate(startDate),
      type: displayType,
      distanceMiles: Math.round(distanceMiles * 100) / 100,
      durationMin: Math.round((durationSeconds / 60) * 10) / 10,
      avgHR: avgHeartRate == null ? null : Math.round(avgHeartRate),
      storedLoad,
      storedMethod,
      recomputedLoad: rc.load,
      avgHrFallbackLoad,
      routeCount,
      mileSplitsCount,
      hasRoute,
      hasHRStream,
      flags,
    });
  }

  const summary: AuditSummary = {
    uid,
    maxHr,
    restingHr,
    totalRunLike,
    flagCounts,
    cleanCount,
    flaggedRows,
    staleDocIds,
    missingLoadDocIds,
  };

  console.log(
    `[audit] uid=${uid} maxHr=${maxHr} restingHr=${restingHr} window=12mo ` +
      `totalRunLike=${totalRunLike} clean=${cleanCount} flagged=${flaggedRows.length}`
  );
  console.log(`[audit] flagCounts=${JSON.stringify(flagCounts)}`);

  const reportPath = opts.reportPath ?? process.env.AUDIT_REPORT;
  if (reportPath) writeFileSync(reportPath, renderReport(summary), "utf8");

  return summary;
}

/** Human-readable report: per-flag sections + summary + clean count. */
export function renderReport(s: AuditSummary): string {
  const lines: string[] = [];
  lines.push(
    `[audit] uid=${s.uid} maxHr=${s.maxHr} restingHr=${s.restingHr} window=12mo`
  );
  lines.push(
    `totalRunLike=${s.totalRunLike} cleanCount=${s.cleanCount} flaggedRuns=${s.flaggedRows.length}`
  );
  lines.push("");
  lines.push("SUMMARY (count by flag type):");
  for (const f of ALL_FLAGS) lines.push(`  ${f.padEnd(16)} ${s.flagCounts[f]}`);
  lines.push("");
  lines.push(
    "AUTO-FIX candidates (authorized): " +
      `STALE_LOAD=${s.staleDocIds.length} MISSING_LOAD=${s.missingLoadDocIds.length}`
  );
  lines.push(
    "MANUAL-REVIEW: COLLAPSED_LOAD + MISSING_ROUTE/SPLITS/HRSTREAM (see sections)"
  );
  lines.push("");

  // FULL TABLE — one row per (run, flag).
  lines.push("FLAG TABLE (one row per flag; a run may appear multiple times):");
  for (const f of ALL_FLAGS) {
    const rows = s.flaggedRows.filter((r) => r.flags.includes(f));
    lines.push(`\n== ${f} (${rows.length}) ==`);
    if (rows.length === 0) {
      lines.push("  (none)");
      continue;
    }
    for (const r of rows) {
      lines.push(
        `  ${r.date} ${r.workoutId} ` +
          `miles=${r.distanceMiles} durMin=${r.durationMin} avgHR=${r.avgHR} ` +
          `stored=${r.storedLoad} recomputed=${r.recomputedLoad} avgHrRef=${r.avgHrFallbackLoad} ` +
          `route#=${r.routeCount} splits#=${r.mileSplitsCount} ` +
          `hasRoute=${r.hasRoute} hasHRStream=${r.hasHRStream}`
      );
    }
  }

  // Machine-readable dump of every flagged row.
  lines.push("");
  lines.push(`FLAGGED ROWS JSON (${s.flaggedRows.length}):`);
  for (const r of s.flaggedRows) lines.push(`  ${JSON.stringify(r)}`);

  return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// NON-RUN WORKOUT AUDIT (OTF/HIIT, strength, mindful, yoga, …)
// ════════════════════════════════════════════════════════════════════════════
//
// The mirror image of the run audit above for every doc with isRunLike !== true.
// Non-runs legitimately have no GPS route, so the MISSING_ROUTE / MISSING_SPLITS
// checks are dropped — only load-score health and hrStream presence matter. It
// reuses the SAME SDK setup (getDb/resolveUid), the SAME 3-tier recompute
// (recomputeLoadForDoc), the SAME stale threshold (isStaleLoad), the SAME load
// math (computeTrainingLoadV2/resolveMaxHr/resolveRestingHr), and the SAME
// COLLAPSED_RATIO — no duplicated compute or Firestore-setup code.
//
// NB: the non-run flag semantics differ from classifyRunFlags by design (per the
// audit brief): COLLAPSED_LOAD and MISSING_LOAD add an `avgHR > restingHr` gate
// (a non-run with HR at/under rest can't be expected to carry a real load), and
// MISSING_HRSTREAM is route-independent (HR present + > 5 min but no stream)
// rather than gated on hasRoute. Hence a sibling classifier, not a reuse of
// classifyRunFlags — the run path stays untouched.

/** The four flags meaningful for non-run workouts (route/splits dropped). */
export type WorkoutQualityFlag =
  | "STALE_LOAD"
  | "COLLAPSED_LOAD"
  | "MISSING_LOAD"
  | "MISSING_HRSTREAM";

export const WORKOUT_FLAGS: WorkoutQualityFlag[] = [
  "STALE_LOAD",
  "COLLAPSED_LOAD",
  "MISSING_LOAD",
  "MISSING_HRSTREAM",
];

/** MISSING_HRSTREAM only fires for sessions longer than this (short efforts
 *  legitimately may not carry a stream). Matches the brief's > 300s rule. */
export const WORKOUT_MIN_STREAM_SECONDS = 300;

/** Pure classifier inputs for the non-run audit — no Firestore. */
export interface WorkoutFlagInputs {
  durationSeconds: number;
  avgHeartRate: number | null;
  /** Resting-HR anchor (settings/prefs) — the floor for "HR data present". */
  restingHr: number;
  hasHRStream: boolean;
  storedLoad: number | null;
  storedMethod: string | undefined;
  /** Fresh recompute from the CURRENT hrStream/route (recomputeLoadForDoc). */
  recomputedLoad: number | null;
  /** Whole-session avg-HR Banister reference (computeTrainingLoadV2). */
  avgHrFallbackLoad: number | null;
}

/**
 * Pure flag classifier for NON-run workouts. Side-effect-free so it can be unit
 * tested without Firestore. A workout can earn multiple flags.
 */
export function classifyWorkoutFlags(i: WorkoutFlagInputs): WorkoutQualityFlag[] {
  const flags: WorkoutQualityFlag[] = [];
  // "HR data present" for a non-run means avgHR above the resting anchor — a
  // session sitting at/under rest can't be expected to carry a real load.
  const hrAboveRest =
    i.avgHeartRate != null &&
    Number.isFinite(i.avgHeartRate) &&
    i.avgHeartRate > i.restingHr;

  // ── LOAD SCORE FLAGS ──────────────────────────────────────────────────────
  // STALE_LOAD — stored "streamed" but the fresh recompute is materially higher
  // (two-pass collapse). Reuses the EXACT backfill threshold (isStaleLoad).
  if (isStaleLoad(i.storedLoad, i.storedMethod, i.recomputedLoad)) {
    flags.push("STALE_LOAD");
  }
  // COLLAPSED_LOAD — stored > 0 but implausibly low vs the avg-HR reference,
  // with HR above resting (so a real load was expected). MANUAL-REVIEW: the
  // stream may be genuinely degenerate, so a recompute can't be trusted to fix.
  if (
    i.storedLoad != null &&
    i.storedLoad > 0 &&
    i.avgHrFallbackLoad != null &&
    i.avgHrFallbackLoad > 0 &&
    i.storedLoad < COLLAPSED_RATIO * i.avgHrFallbackLoad &&
    hrAboveRest
  ) {
    flags.push("COLLAPSED_LOAD");
  }
  // MISSING_LOAD — no stored load at all (null/0) despite HR above resting.
  if ((i.storedLoad == null || i.storedLoad === 0) && hrAboveRest) {
    flags.push("MISSING_LOAD");
  }

  // ── HRSTREAM FLAG (route-independent for non-runs) ────────────────────────
  // MISSING_HRSTREAM — HR data present (avgHR > resting) and the session is long
  // enough (> 5 min) that a per-sample stream should plausibly exist, yet none
  // is recorded. AWARENESS ONLY — not auto-fixable (we can't synthesize a stream).
  if (
    i.hasHRStream !== true &&
    hrAboveRest &&
    i.durationSeconds > WORKOUT_MIN_STREAM_SECONDS
  ) {
    flags.push("MISSING_HRSTREAM");
  }

  return flags;
}

export interface WorkoutAuditRow {
  workoutId: string;
  date: string;
  /** displayType (human-readable), e.g. "Strength", "OTF", "Yoga". */
  type: string;
  /** raw HK activityType string (kept for disambiguation). */
  activityType: string | undefined;
  durationMin: number;
  avgHR: number | null;
  storedLoad: number | null;
  storedMethod: string | undefined;
  recomputedLoad: number | null;
  avgHrFallbackLoad: number | null;
  hasHRStream: boolean;
  flags: WorkoutQualityFlag[];
}

/** Per-workout-type rollup (e.g. "OTF": {total, clean, flagCounts}). */
export interface WorkoutTypeStat {
  /** Non-run docs of this displayType scanned in the window. */
  total: number;
  /** Of those, how many had ZERO flags. */
  clean: number;
  /** Per-flag tally (a doc may add to several). */
  flagCounts: Record<WorkoutQualityFlag, number>;
}

export interface WorkoutAuditSummary {
  uid: string;
  maxHr: number;
  restingHr: number;
  /** Non-run docs scanned in the 12-month window. */
  totalNonRun: number;
  /** Count by flag type across all non-runs (a doc may contribute to several). */
  flagCounts: Record<WorkoutQualityFlag, number>;
  /** Non-run docs with ZERO flags. */
  cleanCount: number;
  /** Breakdown keyed by displayType — total / clean / per-flag. */
  workoutTypeCounts: Record<string, WorkoutTypeStat>;
  /** Only the FLAGGED rows (clean rows are summarized by cleanCount). */
  flaggedRows: WorkoutAuditRow[];
  /** docIds for the two authorized auto-fix classes (backfill stale/missing). */
  staleDocIds: string[];
  missingLoadDocIds: string[];
}

function emptyFlagCounts(): Record<WorkoutQualityFlag, number> {
  return Object.fromEntries(WORKOUT_FLAGS.map((f) => [f, 0])) as Record<
    WorkoutQualityFlag,
    number
  >;
}

export async function runAuditWorkoutQuality(
  opts: { uid?: string; nowMs?: number; reportPath?: string } = {}
): Promise<WorkoutAuditSummary> {
  const nowMs = opts.nowMs ?? Date.now();
  const db = getDb();
  const uid = await resolveUid(db, opts.uid);

  // Anchors from settings/prefs — same source the backfill + run audit use.
  const prefsSnap = await db.doc(`users/${uid}/settings/prefs`).get();
  const prefs = (prefsSnap.exists ? prefsSnap.data() : {}) as Partial<UserSettings>;
  const settingsLike = {
    maxHeartRate: prefs.maxHeartRate,
    restingHeartRate: prefs.restingHeartRate,
  } as UserSettings;
  const maxHr = resolveMaxHr(settingsLike);
  const restingHr = resolveRestingHr(settingsLike);

  // SAME 12-month window as the run audit/backfill (date filter only; isRunLike
  // is filtered in memory — here we keep the INVERSE: non-run docs).
  const cutoffTs = admin.firestore.Timestamp.fromMillis(nowMs - TWELVE_MONTHS_MS);
  const snap = await db
    .collection(`users/${uid}/healthWorkouts`)
    .where("startDate", ">=", cutoffTs)
    .orderBy("startDate", "desc")
    .get();

  const flagCounts = emptyFlagCounts();
  const workoutTypeCounts: Record<string, WorkoutTypeStat> = {};
  const flaggedRows: WorkoutAuditRow[] = [];
  const staleDocIds: string[] = [];
  const missingLoadDocIds: string[] = [];
  let totalNonRun = 0;
  let cleanCount = 0;

  for (const docSnap of snap.docs) {
    const data = docSnap.data() as Record<string, unknown>;
    if (data.isRunLike === true) continue; // NON-run only (inverse of run audit)
    totalNonRun += 1;

    const durationSeconds = (data.durationSeconds as number) ?? 0;
    const avgHeartRate = (data.avgHeartRate as number | null) ?? null;
    const activityType = (data.activityType as string) ?? undefined;
    const hasHRStream = (data.hasHRStream as boolean) ?? false;
    const displayType = (data.displayType as string) ?? (activityType ?? "Workout");
    const startDate =
      data.startDate &&
      typeof (data.startDate as { toDate?: () => Date }).toDate === "function"
        ? (data.startDate as { toDate: () => Date }).toDate()
        : new Date(0);
    const storedLoad =
      typeof data.trainingLoadV2 === "number" &&
      Number.isFinite(data.trainingLoadV2)
        ? (data.trainingLoadV2 as number)
        : null;
    const storedMethod =
      data.trainingLoadMethod === "streamed" ||
      data.trainingLoadMethod === "avg-hr-fallback"
        ? (data.trainingLoadMethod as string)
        : undefined;

    // Fresh recompute (reads hrStream/route when present) + the avg-HR reference.
    // No route/mileSplits aggregation — not meaningful for non-runs.
    const rc = await recomputeLoadForDoc(db, uid, docSnap.id, data, maxHr, restingHr);
    const avgHrFallbackLoad = computeTrainingLoadV2(
      durationSeconds,
      avgHeartRate,
      maxHr,
      restingHr,
      activityType
    );

    const flags = classifyWorkoutFlags({
      durationSeconds,
      avgHeartRate,
      restingHr,
      hasHRStream,
      storedLoad,
      storedMethod,
      recomputedLoad: rc.load,
      avgHrFallbackLoad,
    });

    const stat =
      workoutTypeCounts[displayType] ??
      (workoutTypeCounts[displayType] = {
        total: 0,
        clean: 0,
        flagCounts: emptyFlagCounts(),
      });
    stat.total += 1;

    for (const f of flags) {
      flagCounts[f] += 1;
      stat.flagCounts[f] += 1;
    }
    if (flags.includes("STALE_LOAD")) staleDocIds.push(docSnap.id);
    if (flags.includes("MISSING_LOAD")) missingLoadDocIds.push(docSnap.id);

    if (flags.length === 0) {
      cleanCount += 1;
      stat.clean += 1;
      continue;
    }

    flaggedRows.push({
      workoutId: docSnap.id,
      date: fmtDate(startDate),
      type: displayType,
      activityType,
      durationMin: Math.round((durationSeconds / 60) * 10) / 10,
      avgHR: avgHeartRate == null ? null : Math.round(avgHeartRate),
      storedLoad,
      storedMethod,
      recomputedLoad: rc.load,
      avgHrFallbackLoad,
      hasHRStream,
      flags,
    });
  }

  const summary: WorkoutAuditSummary = {
    uid,
    maxHr,
    restingHr,
    totalNonRun,
    flagCounts,
    cleanCount,
    workoutTypeCounts,
    flaggedRows,
    staleDocIds,
    missingLoadDocIds,
  };

  console.log(
    `[workout-audit] uid=${uid} maxHr=${maxHr} restingHr=${restingHr} window=12mo ` +
      `totalNonRun=${totalNonRun} clean=${cleanCount} flagged=${flaggedRows.length}`
  );
  console.log(`[workout-audit] flagCounts=${JSON.stringify(flagCounts)}`);

  const reportPath = opts.reportPath ?? process.env.WORKOUT_AUDIT_REPORT;
  if (reportPath) writeFileSync(reportPath, renderWorkoutReport(summary), "utf8");

  return summary;
}

/** Human-readable non-run report: flag summary + per-type summary + table. */
export function renderWorkoutReport(s: WorkoutAuditSummary): string {
  const lines: string[] = [];
  lines.push(
    `[workout-audit] uid=${s.uid} maxHr=${s.maxHr} restingHr=${s.restingHr} window=12mo`
  );
  lines.push(
    `totalNonRun=${s.totalNonRun} cleanCount=${s.cleanCount} flaggedWorkouts=${s.flaggedRows.length}`
  );
  lines.push("");
  lines.push("SUMMARY (count by flag type):");
  for (const f of WORKOUT_FLAGS) lines.push(`  ${f.padEnd(16)} ${s.flagCounts[f]}`);
  lines.push("");

  // Per-workout-type breakdown (total / clean / per-flag).
  lines.push("SUMMARY (by workout type — total | clean | flags):");
  const types = Object.keys(s.workoutTypeCounts).sort();
  for (const t of types) {
    const st = s.workoutTypeCounts[t];
    const flagStr = WORKOUT_FLAGS.filter((f) => st.flagCounts[f] > 0)
      .map((f) => `${f}=${st.flagCounts[f]}`)
      .join(" ");
    lines.push(
      `  ${t.padEnd(22)} total=${st.total} clean=${st.clean}` +
        (flagStr ? `  ${flagStr}` : "")
    );
  }
  lines.push("");

  lines.push(
    "AUTO-FIX candidates (authorized): " +
      `STALE_LOAD=${s.staleDocIds.length} MISSING_LOAD=${s.missingLoadDocIds.length}`
  );
  lines.push(
    "MANUAL-REVIEW only: COLLAPSED_LOAD + MISSING_HRSTREAM (not auto-fixed)"
  );
  lines.push("");

  // FULL FLAG TABLE — one row per flagged workout (all its flags on the row).
  lines.push(
    `FLAG TABLE (one row per flagged workout; ${s.flaggedRows.length} rows):`
  );
  if (s.flaggedRows.length === 0) {
    lines.push("  (none)");
  } else {
    for (const r of s.flaggedRows) {
      lines.push(
        `  ${r.date} ${r.workoutId} type=${r.type} ` +
          `durMin=${r.durationMin} avgHR=${r.avgHR} ` +
          `stored=${r.storedLoad} recomputed=${r.recomputedLoad} avgHrRef=${r.avgHrFallbackLoad} ` +
          `hasHRStream=${r.hasHRStream} flags=[${r.flags.join(",")}]`
      );
    }
  }

  // Per-flag grouping (a workout may appear under several flags).
  lines.push("");
  lines.push("BY FLAG (a workout may appear under multiple):");
  for (const f of WORKOUT_FLAGS) {
    const rows = s.flaggedRows.filter((r) => r.flags.includes(f));
    lines.push(`\n== ${f} (${rows.length}) ==`);
    if (rows.length === 0) {
      lines.push("  (none)");
      continue;
    }
    for (const r of rows) {
      lines.push(
        `  ${r.date} ${r.workoutId} type=${r.type} ` +
          `durMin=${r.durationMin} avgHR=${r.avgHR} ` +
          `stored=${r.storedLoad} recomputed=${r.recomputedLoad} avgHrRef=${r.avgHrFallbackLoad}`
      );
    }
  }

  // Machine-readable dump of every flagged row.
  lines.push("");
  lines.push(`FLAGGED ROWS JSON (${s.flaggedRows.length}):`);
  for (const r of s.flaggedRows) lines.push(`  ${JSON.stringify(r)}`);

  return lines.join("\n");
}
