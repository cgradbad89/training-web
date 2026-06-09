/**
 * Admin repair: fix run-like healthWorkouts docs whose parent `hasRoute` flag is
 * false/missing even though a populated `route` subcollection exists.
 *
 * Root cause: the iOS headless background sync can write the `route`
 * subcollection but be suspended before the trailing `hasRoute: true` flag
 * write lands. The web run-detail page now self-heals by deriving route
 * availability from the data (src/utils/routeAvailability.ts), and iOS
 * self-heals on the next wake (commit 19f647a). This script repairs the parent
 * flag immediately so the affected docs render without waiting for either.
 *
 * Selection: every run-like (`isRunLike == true`) doc whose `hasRoute` is NOT
 * already true AND whose `route` subcollection has >= 1 doc. For each, set
 * `hasRoute: true`, plus `hasRouteHR: true` when the probed route points carry
 * an `hr` field (matching the iOS/backfill probe). Owner field-MERGE write —
 * never overwrites other fields and never deletes anything. Genuinely
 * route-less workouts (empty `route`) are left untouched.
 *
 * KEPT script. There is no TS runner (tsx/ts-node) in this repo, so it is driven
 * by an env-gated Vitest entry (scripts/repairHasRoute.test.ts), reusing
 * Vitest's TS + "@/" alias support — no new dependency:
 *
 *   Dry-run (writes NOTHING, prints the table + summary):
 *     REPAIR=1 npx vitest run scripts/repairHasRoute.test.ts
 *   Apply (performs the merge writes):
 *     REPAIR=commit npx vitest run scripts/repairHasRoute.test.ts
 *   Optional explicit uid:
 *     REPAIR=1 REPAIR_UID=<uid> npx vitest run scripts/repairHasRoute.test.ts
 */

import { readFileSync } from "node:fs";
import admin from "firebase-admin";

/** How many route docs to read to confirm presence + probe for an `hr` field. */
const ROUTE_PROBE_LIMIT = 25;
const WRITE_BATCH_SIZE = 400; // < Firestore's 500-op batch cap

interface RepairOptions {
  commit?: boolean;
  uid?: string;
}

export interface RepairRow {
  workoutId: string;
  date: string;
  type: string;
  hadHasRoute: boolean | undefined;
  routeProbeCount: number;
  setHasRouteHR: boolean;
}

export interface RepairSummary {
  uid: string;
  /** Run-like docs examined. */
  scanned: number;
  /** Run-like docs whose hasRoute was NOT already true (repair candidates). */
  candidates: number;
  /** Candidates with a non-empty `route` subcollection — flagged for write. */
  repaired: number;
  /** Of `repaired`, how many also got hasRouteHR set true (route carries hr). */
  withRouteHR: number;
  /** Candidates whose `route` subcollection was empty — left untouched. */
  skippedNoRoute: number;
  written: number;
  committed: boolean;
  rows: RepairRow[];
}

function loadServiceAccount(): Record<string, unknown> {
  const env = readFileSync(".env.local", "utf8");
  const line = env
    .split("\n")
    .find((l) => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON="));
  if (!line)
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON not found in .env.local");
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
  if (cg.empty) throw new Error("No healthWorkouts found; pass REPAIR_UID=<uid>");
  // path: users/{uid}/healthWorkouts/{id}
  const parts = cg.docs[0].ref.path.split("/");
  return parts[1];
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function runRepairHasRoute(
  opts: RepairOptions = {}
): Promise<RepairSummary> {
  const commit = opts.commit === true;
  const db = getDb();
  const uid = await resolveUid(db, opts.uid);

  const snap = await db
    .collection(`users/${uid}/healthWorkouts`)
    .where("isRunLike", "==", true)
    .orderBy("startDate", "desc")
    .get();

  console.log(
    `[repairHasRoute] uid=${uid} mode=${commit ? "COMMIT" : "DRY-RUN"} ` +
      `scannedRunLike=${snap.size}`
  );

  const summary: RepairSummary = {
    uid,
    scanned: snap.size,
    candidates: 0,
    repaired: 0,
    withRouteHR: 0,
    skippedNoRoute: 0,
    written: 0,
    committed: commit,
    rows: [],
  };

  const writes: Array<{
    ref: admin.firestore.DocumentReference;
    data: Record<string, unknown>;
  }> = [];

  for (const docSnap of snap.docs) {
    const data = docSnap.data() as Record<string, unknown>;
    const hasRouteRaw = data.hasRoute as boolean | undefined;

    // Candidate = hasRoute not already true (covers false AND missing).
    if (hasRouteRaw === true) continue;
    summary.candidates += 1;

    const displayType =
      (data.displayType as string) ?? (data.activityType as string) ?? "Workout";
    const startDate =
      data.startDate &&
      typeof (data.startDate as { toDate?: () => Date }).toDate === "function"
        ? (data.startDate as { toDate: () => Date }).toDate()
        : new Date(0);

    // Probe the `route` subcollection: confirm presence + look for an `hr` field.
    const routeSnap = await db
      .collection(`users/${uid}/healthWorkouts/${docSnap.id}/route`)
      .limit(ROUTE_PROBE_LIMIT)
      .get();

    if (routeSnap.empty) {
      // Genuinely route-less (or route not yet synced) — leave untouched.
      summary.skippedNoRoute += 1;
      summary.rows.push({
        workoutId: docSnap.id,
        date: fmtDate(startDate),
        type: displayType,
        hadHasRoute: hasRouteRaw,
        routeProbeCount: 0,
        setHasRouteHR: false,
      });
      continue;
    }

    const carriesHr = routeSnap.docs.some((d) => {
      const hr = (d.data() as Record<string, unknown>).hr;
      return typeof hr === "number" && Number.isFinite(hr);
    });

    // Field-merge: set hasRoute, and hasRouteHR only when probed points carry
    // hr (no `undefined` keys are ever written — mirrors stripUndefined).
    const writeData: Record<string, unknown> = { hasRoute: true };
    if (carriesHr) writeData.hasRouteHR = true;

    summary.repaired += 1;
    if (carriesHr) summary.withRouteHR += 1;
    summary.rows.push({
      workoutId: docSnap.id,
      date: fmtDate(startDate),
      type: displayType,
      hadHasRoute: hasRouteRaw,
      routeProbeCount: routeSnap.size,
      setHasRouteHR: carriesHr,
    });

    writes.push({ ref: docSnap.ref, data: writeData });
    console.log(
      `[repairHasRoute] ${commit ? "WILL WRITE" : "would write"} ${docSnap.id} ` +
        `(${fmtDate(startDate)} ${displayType}) hasRoute=true` +
        (carriesHr ? " hasRouteHR=true" : "") +
        ` [probe=${routeSnap.size} pts, prevHasRoute=${String(hasRouteRaw)}]`
    );
  }

  console.table(summary.rows);
  console.log(
    `[repairHasRoute] candidates=${summary.candidates} ` +
      `repaired=${summary.repaired} (withRouteHR=${summary.withRouteHR}) ` +
      `skipped(no-route)=${summary.skippedNoRoute}`
  );

  if (commit && writes.length > 0) {
    for (let i = 0; i < writes.length; i += WRITE_BATCH_SIZE) {
      const batch = db.batch();
      for (const w of writes.slice(i, i + WRITE_BATCH_SIZE)) {
        batch.set(w.ref, w.data, { merge: true });
      }
      await batch.commit();
      summary.written += Math.min(WRITE_BATCH_SIZE, writes.length - i);
    }
    console.log(`[repairHasRoute] COMMIT complete — wrote ${summary.written} docs.`);
  } else if (!commit) {
    console.log(
      `[repairHasRoute] DRY-RUN — wrote 0 docs (would write ${writes.length}). ` +
        `Re-run with REPAIR=commit to persist.`
    );
  }

  return summary;
}
