/**
 * One-off, OWNER-RUN backfill: add the structured `targetHr` field to every
 * entry dated 2026-11-18 or later in the active "Rock and Roll 1/2 Marathon"
 * RunningPlan.
 *
 *   legacy cap (`targetHeartRate`)  → targetHr {null, cap}        (legacy field kept)
 *   notes "HR 146-155 bpm"          → targetHr {146, 155}         (legacy stays null)
 *   notes "HR <135 / 145-155 bpm"   → NOTHING (split long run; text stays in notes)
 *   everything else                 → NOTHING
 * `notes` is never modified; entries before the cutoff are never touched.
 *
 * Firestore shape: users/{uid}/plans/{planId} is one doc holding `weeks:
 * PlanWeek[]`, and a field path cannot address an array index, so the commit
 * rewrites the whole `weeks` array — the ONLY write is `{ weeks, updatedAt }`
 * (stripUndefined), inside a transaction that first re-reads the doc and aborts
 * if it changed since the dry read.
 *
 * Pure logic lives in src/utils/hrTargetBackfill.ts (unit-tested). Driven by the
 * env-gated Vitest entry scripts/backfillHrTargets20261118.test.ts:
 *
 *   Dry-run (writes NOTHING):  npm run plan:backfill-hr:dry
 *   Commit (performs the write): npm run plan:backfill-hr:commit
 *
 * Credentials: FIREBASE_SERVICE_ACCOUNT_JSON (a service-account JSON string) is
 * read IN CODE from process.env first, else from the `FIREBASE_SERVICE_ACCOUNT_JSON=`
 * line of `.env.local` in the current working directory (same as
 * replaceRnrPlanFrom20261118.ts). It is never printed.
 *
 * Re-running after a successful commit is safe: the plan is detected as already
 * applied (56 already-set) and nothing is written.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import admin from "firebase-admin";
import type { PlanWeek } from "../src/types/plan";
import { deepEqual } from "../src/utils/planReplace";
import {
  HR_BACKFILL_CUTOFF_DATE,
  planHrBackfill,
  validateHrBackfill,
  type HrBackfillState,
} from "../src/utils/hrTargetBackfill";
import { formatHrTarget } from "../src/utils/hrTarget";

export const TARGET_UID = "eR9gJQK1eBflP9syhPRtPbiF6Kh2";
export const PLAN_NAME = "Rock and Roll 1/2 Marathon";
/** Documented in PRD.md; asserted against the live doc, never trusted. */
export const EXPECTED_PLAN_ID = "e1296747-78fc-48a7-b5de-da12f2bbb1e2";
export const EXPECTED_START_DATE = "2026-09-28";

// ─── Firestore access (Admin SDK, credentials loaded in code only) ───────────

function loadServiceAccount(): Record<string, unknown> {
  const fromEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (fromEnv) return JSON.parse(fromEnv);
  const env = readFileSync(".env.local", "utf8");
  const line = env.split("\n").find((l) => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON="));
  if (!line) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON not found in the environment or in .env.local (run from the repo root)"
    );
  }
  let val = line.slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length).trim();
  if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
    val = val.slice(1, -1);
  }
  return JSON.parse(val);
}

function getDb(): admin.firestore.Firestore {
  if (!admin.apps.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount() as any) });
  }
  return admin.firestore();
}

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

const fmt = (v: unknown) => (v === undefined ? "-" : JSON.stringify(v));

// ─── Plan lookup ─────────────────────────────────────────────────────────────

/** Look up the plan and assert every identity field; throws with what was found. */
async function loadTargetPlan(db: admin.firestore.Firestore) {
  const snap = await db.collection(`users/${TARGET_UID}/plans`).get();
  const matches = snap.docs.filter((d) => {
    const x = d.data();
    return ((x.planType as string | undefined) ?? "running") === "running" && x.name === PLAN_NAME;
  });
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly 1 running plan named "${PLAN_NAME}", found ${matches.length}: ` +
        snap.docs.map((d) => `${d.id}="${String(d.data().name)}" status=${String(d.data().status)}`).join("; ")
    );
  }
  const doc = matches[0];
  const data = doc.data();
  const rawStart = data.startDate as unknown;
  const startDate =
    typeof rawStart === "string"
      ? rawStart
      : (rawStart as { toDate(): Date }).toDate().toISOString().slice(0, 10);
  const problems: string[] = [];
  if (doc.id !== EXPECTED_PLAN_ID) problems.push(`id ${doc.id} != ${EXPECTED_PLAN_ID}`);
  if (startDate !== EXPECTED_START_DATE) problems.push(`startDate ${startDate} != ${EXPECTED_START_DATE}`);
  if (data.status !== "active") problems.push(`status ${String(data.status)} != "active"`);
  if (data.isActive !== true) problems.push(`isActive ${String(data.isActive)} != true`);
  if (problems.length > 0) {
    throw new Error(
      `Plan identity check failed: ${problems.join("; ")}. Found: ` +
        JSON.stringify({ id: doc.id, name: data.name, status: data.status, isActive: data.isActive, startDate })
    );
  }
  return { doc, data, startDate };
}

// ─── Run ─────────────────────────────────────────────────────────────────────

export interface HrBackfillRunResult {
  planId: string;
  state: HrBackfillState;
  violations: string[];
  committed: boolean;
  backupPath?: string;
}

export async function runBackfillHrTargets(opts: { commit?: boolean } = {}): Promise<HrBackfillRunResult> {
  const commit = opts.commit === true;
  const mode = commit ? "COMMIT" : "DRY-RUN";
  const db = getDb();
  const { doc, data, startDate } = await loadTargetPlan(db);
  const oldWeeks = data.weeks as PlanWeek[];
  const dryUpdatedAt = data.updatedAt as unknown;

  console.log(
    `[backfillHrTargets] mode=${mode} plan=${doc.id} name="${String(data.name)}" status=${String(data.status)} isActive=${String(data.isActive)} startDate=${startDate} weeks=${oldWeeks.length} updatedAt=${fmt(dryUpdatedAt)}`
  );

  const plan = planHrBackfill(oldWeeks, startDate, HR_BACKFILL_CUTOFF_DATE);
  const validation = validateHrBackfill(oldWeeks, plan, startDate, HR_BACKFILL_CUTOFF_DATE);

  console.log(`\n== PER-ENTRY TABLE (entries dated >= ${HR_BACKFILL_CUTOFF_DATE}: ${plan.rows.length}) ==`);
  console.log("  date       | workoutType | reason       | legacy hr | after     | notes");
  for (const r of plan.rows) {
    console.log(
      [
        `  ${r.date}`,
        (r.workoutType ?? "-").padEnd(11),
        r.reason.padEnd(12),
        String(r.before.targetHeartRate ?? "null").padEnd(9),
        (r.after ? formatHrTarget(r.after) : "-").padEnd(9),
        (r.before.notes ?? "-").slice(0, 60),
      ].join(" | ")
    );
  }
  console.log(`\n== COUNTS: ${JSON.stringify(validation.counts)}`);
  console.log(`== TARGET DISTRIBUTION ("min-max", empty min = cap): ${JSON.stringify(validation.distribution)}`);
  console.log(`== STATE: ${validation.state}`);
  console.log(
    `== VALIDATION: ${validation.violations.length === 0 ? "OK (0 violations)" : validation.violations.length + " violation(s)"} ==`
  );
  for (const v of validation.violations) console.log("  VIOLATION: " + v);

  if (validation.violations.length > 0) {
    throw new Error(
      `Aborting (${mode}): ${validation.violations.length} violation(s) — see the table above. Nothing was written.`
    );
  }

  if (!commit) {
    console.log("\n[backfillHrTargets] DRY-RUN — wrote 0 docs.");
    return { planId: doc.id, state: validation.state, violations: [], committed: false };
  }

  if (validation.state === "applied") {
    console.log("\n[backfillHrTargets] COMMIT: the backfill is already applied — nothing to write.");
    return { planId: doc.id, state: "applied", violations: [], committed: false };
  }

  // ── Commit ──
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(homedir(), "training-web-backups");
  mkdirSync(dir, { recursive: true });
  const backupPath = path.join(dir, `hr-backfill-${stamp}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify({ planId: doc.id, capturedAt: new Date().toISOString(), updatedAt: dryUpdatedAt, weeks: oldWeeks }, null, 2),
    "utf8"
  );
  console.log(`\n[backfillHrTargets] backup written: ${backupPath}`);

  const intended = stripUndefined(plan.weeks);
  const dryUpdateTime = doc.updateTime!;
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(doc.ref);
    const freshData = fresh.data();
    if (!fresh.exists || !freshData) throw new Error("Plan doc disappeared before the write");
    if (JSON.stringify(freshData.updatedAt) !== JSON.stringify(dryUpdatedAt)) {
      throw new Error(
        `Plan updatedAt changed since the dry read (${fmt(dryUpdatedAt)} -> ${fmt(freshData.updatedAt)}); aborting — re-run the dry run`
      );
    }
    if (!fresh.updateTime!.isEqual(dryUpdateTime)) {
      throw new Error("Plan doc was modified since the dry read; aborting — re-run the dry run");
    }
    if (!deepEqual(freshData.weeks, oldWeeks)) {
      throw new Error("Plan weeks changed since the dry read; aborting — re-run the dry run");
    }
    tx.update(doc.ref, stripUndefined({ weeks: intended, updatedAt: new Date().toISOString() }));
  });

  const back = await doc.ref.get();
  const backWeeks = back.data()?.weeks as PlanWeek[] | undefined;
  const ok = backWeeks !== undefined && deepEqual(backWeeks, intended);
  console.log(`[backfillHrTargets] read-back deep-equal to intended weeks: ${ok ? "YES" : "NO"}`);
  if (!ok) throw new Error("Read-back does not match the intended weeks");
  const after = back.data()!;
  console.log(
    `[backfillHrTargets] unchanged: name="${String(after.name)}" status=${String(after.status)} isActive=${String(after.isActive)} startDate=${fmt(after.startDate)}`
  );
  console.log("[backfillHrTargets] COMMIT complete.");
  return { planId: doc.id, state: validation.state, violations: [], committed: true, backupPath };
}
