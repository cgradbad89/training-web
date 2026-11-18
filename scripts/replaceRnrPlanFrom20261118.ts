/**
 * One-off content update: replace every entry dated 2026-11-18 or later in the
 * active "Rock and Roll 1/2 Marathon" RunningPlan with the revised 62-entry plan.
 * Entries before 2026-11-18 (including Mon 11-16 and Tue 11-17 of week 8) are left
 * byte-identical.
 *
 * Firestore shape: users/{uid}/plans/{planId} is one doc holding `weeks:
 * PlanWeek[]`; an entry's date is startDate + weekIndex*7 + (weekday-1). Firestore
 * field paths can't address array indexes, so the whole `weeks` array is
 * rewritten — the ONLY write is `ref.update({ weeks, updatedAt })`. name,
 * status, isActive, startDate, linkedRaceId and travelRevision are never touched.
 *
 * Pure logic lives in src/utils/planReplace.ts (unit-tested). Driven by an
 * env-gated Vitest entry (scripts/replaceRnrPlanFrom20261118.test.ts), same
 * convention as scripts/updatePlanWeeks13to18.ts:
 *
 *   Dry-run (writes NOTHING):  npm run plan:replace-rnr:dry
 *   Commit (performs the write): npm run plan:replace-rnr:commit
 *
 * Credentials: FIREBASE_SERVICE_ACCOUNT_JSON (a service-account JSON string) is read
 * IN CODE from process.env first, else from the `FIREBASE_SERVICE_ACCOUNT_JSON=`
 * line of `.env.local` in the current working directory (what
 * updatePlanWeeks13to18.ts does). It is never printed.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import admin from "firebase-admin";
import type { PlannedRunEntry, PlanWeek } from "../src/types/plan";
import {
  buildReplacedWeeks,
  validateReplacedWeeks,
  deepEqual,
  plannedEntryIsoDate,
  type NewPlanEntrySpec,
} from "../src/utils/planReplace";
import {
  computePlanEasyPaceBaseline,
  planEntryToSyntheticEffort,
} from "../src/utils/riegelFit";

export const TARGET_UID = "eR9gJQK1eBflP9syhPRtPbiF6Kh2";
export const PLAN_NAME = "Rock and Roll 1/2 Marathon";
/** Documented in PRD.md; asserted against the live doc, never trusted. */
export const EXPECTED_PLAN_ID = "e1296747-78fc-48a7-b5de-da12f2bbb1e2";
export const EXPECTED_START_DATE = "2026-09-28";
export const CUTOFF_DATE = "2026-11-18";

// ─── Replacement entries (62) ────────────────────────────────────────────────

const HR_CAP = "HR cap 135 — slow down or walk hills to stay under";
const SPLIT = "10:30+ / 9:30";

/** Easy run: outdoor / easy / "10:30+" (630) / HR cap 135. */
function easy(date: string, wk: number, weekday: number, miles: number, description: string, notes = HR_CAP): NewPlanEntrySpec {
  return { date, weekNumber: wk, weekday, distanceMiles: miles, runType: "outdoor", workoutType: "easy", paceTarget: "10:30+", targetPaceSecondsPerMile: 630, targetHeartRate: 135, description, notes };
}
/** Easy long run: longRun / long / "10:30+" (630) / HR cap 135, no notes unless given. */
function long(date: string, wk: number, miles: number, notes?: string): NewPlanEntrySpec {
  return { date, weekNumber: wk, weekday: 6, distanceMiles: miles, runType: "longRun", workoutType: "long", paceTarget: "10:30+", targetPaceSecondsPerMile: 630, targetHeartRate: 135, description: "Long run, easy pace", ...(notes ? { notes } : {}) };
}
/** Goal-pace-finish long run: stored at the EASY pace (630); the finish is text only. */
function splitLong(date: string, wk: number, miles: number, description: string, notes: string): NewPlanEntrySpec {
  return { date, weekNumber: wk, weekday: 6, distanceMiles: miles, runType: "longRun", workoutType: "long", paceTarget: SPLIT, targetPaceSecondsPerMile: 630, targetHeartRate: null, description, notes };
}
/** Quality session: outdoor / tempo, work pace stored as the entry pace. */
function tempo(date: string, wk: number, weekday: number, miles: number, pace: string, seconds: number, description: string, notes: string): NewPlanEntrySpec {
  return { date, weekNumber: wk, weekday, distanceMiles: miles, runType: "outdoor", workoutType: "tempo", paceTarget: pace, targetPaceSecondsPerMile: seconds, targetHeartRate: null, description, notes };
}

const STRIDES = "+ 4-6 x 20s strides";

export const NEW_ENTRY_SPECS: NewPlanEntrySpec[] = [
  // Week 8 (partial: Wed onward)
  tempo("2026-11-18", 8, 3, 6, "9:10", 550, "6mi total: 1.5mi WU, 2 x 1.5mi @ 9:10 (3 min jog between), CD", "HR 146-155 bpm"),
  easy("2026-11-20", 8, 5, 3, `3 miles easy ${STRIDES}`),
  long("2026-11-21", 8, 9),
  // Week 9
  easy("2026-11-23", 9, 1, 3, `3 miles easy ${STRIDES}`),
  { date: "2026-11-26", weekNumber: 9, weekday: 4, distanceMiles: 5, runType: "outdoor", workoutType: "race", paceTarget: "race effort", targetHeartRate: null, description: "Turkey Trot — RACE IT as a fitness check", notes: "On track for 2:04:30 if 5mi < 44:50 (8:58/mi) or 5K < 27:00. Warm up 1mi first" },
  long("2026-11-28", 9, 7),
  // Week 10
  easy("2026-11-30", 10, 1, 4, "4 miles easy"),
  tempo("2026-12-02", 10, 3, 6, "8:40", 520, "6mi total: 1.5mi WU, 5 x 1K @ 8:40 (2 min jog between), CD", "HR 155-165 bpm"),
  easy("2026-12-04", 10, 5, 3, `3 miles easy ${STRIDES}`),
  long("2026-12-05", 10, 9),
  // Week 11
  easy("2026-12-07", 11, 1, 5, `5 miles easy ${STRIDES}`),
  tempo("2026-12-09", 11, 3, 6, "9:05", 545, "6mi total: 1mi WU, 2 x 2mi @ 9:05 (3 min jog between), CD", "HR 146-155 bpm"),
  long("2026-12-12", 11, 10),
  // Week 12
  easy("2026-12-14", 12, 1, 4, "4 miles easy"),
  tempo("2026-12-16", 12, 3, 6, "9:05", 545, "6mi total: 1.5mi WU, 3mi continuous @ 9:05, CD", "HR 146-155 bpm"),
  easy("2026-12-18", 12, 5, 4, `4 miles easy ${STRIDES}`),
  long("2026-12-19", 12, 10),
  // Week 13
  easy("2026-12-21", 13, 1, 4, "4 miles easy"),
  easy("2026-12-23", 13, 3, 5, `Recovery week — 5 miles easy ${STRIDES}`),
  long("2026-12-26", 13, 8, "Holiday + recovery 3-run week — protect this long run"),
  // Week 14
  easy("2026-12-28", 14, 1, 4, "4 miles easy"),
  tempo("2026-12-30", 14, 3, 6, "8:35", 515, "6mi total: 1.5mi WU, 6 x 1K @ 8:35 (2 min jog between), CD", "HR 155-165 bpm"),
  easy("2026-12-31", 14, 4, 3, `3 miles easy ${STRIDES}`, "Moved off New Year's Day; HR cap 135"),
  splitLong("2027-01-02", 14, 10, "10mi: first 7 easy, last 3 @ 9:30 goal pace", "HR <135 / 145-155 bpm. First goal-pace finish"),
  // Week 15
  easy("2027-01-04", 15, 1, 5, `5 miles easy ${STRIDES}`),
  tempo("2027-01-06", 15, 3, 7, "9:00", 540, "7mi total: 1.5mi WU, 3.5mi continuous @ 9:00, CD", "HR 146-155 bpm"),
  long("2027-01-09", 15, 11),
  // Week 16
  easy("2027-01-11", 16, 1, 4, "4 miles easy"),
  tempo("2027-01-13", 16, 3, 6, "8:45", 525, "6mi total: 1.5mi WU, 3 x 1mi @ 8:45 (3 min jog between), CD", "HR 155-165 bpm"),
  easy("2027-01-15", 16, 5, 4, `4 miles easy ${STRIDES}`),
  splitLong("2027-01-16", 16, 10, "10mi: first 6 easy, last 4 @ 9:30 goal pace", "HR <135 / 145-155 bpm"),
  // Week 17
  easy("2027-01-18", 17, 1, 4, "4 miles easy"),
  tempo("2027-01-20", 17, 3, 5, "9:00", 540, "Recovery week — 5mi total: 1mi @ 9:00 + 6 strides, rest easy", "HR 146-155 bpm"),
  long("2027-01-23", 17, 8),
  // Week 18
  easy("2027-01-25", 18, 1, 4, "4 miles easy"),
  tempo("2027-01-27", 18, 3, 7, "8:55", 535, "7mi total: 1.5mi WU, 2 x 2mi @ 8:55 (3 min jog between), CD", "HR 146-155 bpm"),
  easy("2027-01-29", 18, 5, 4, `4 miles easy ${STRIDES}`),
  long("2027-01-30", 18, 11),
  // Week 19 (source CSV labeled 2027-02-02 "Mon"; that date is a Tuesday — intent is Monday 2027-02-01)
  easy("2027-02-01", 19, 1, 5, `5 miles easy ${STRIDES}`),
  tempo("2027-02-03", 19, 3, 6, "8:30", 510, "6mi total: 1.5mi WU, 6 x 1K @ 8:30 (2 min jog between), CD", "HR 155-165 bpm"),
  splitLong("2027-02-06", 19, 10, "10mi: first 4 easy, last 6 @ 9:30 goal pace", "HR <135 / 145-155 bpm. Practice race fueling (gel at ~45 min)"),
  // Week 20
  easy("2027-02-08", 20, 1, 4, "4 miles easy"),
  tempo("2027-02-10", 20, 3, 7, "8:55", 535, "7mi total: 1.5mi WU, 4mi continuous @ 8:55, CD", "HR 146-155 bpm"),
  easy("2027-02-12", 20, 5, 4, `4 miles easy ${STRIDES}`),
  long("2027-02-13", 20, 12),
  // Week 21
  easy("2027-02-15", 21, 1, 4, "4 miles easy"),
  tempo("2027-02-17", 21, 3, 5, "8:45", 525, "Recovery week — 5mi total: 1mi WU, 3 x 1mi @ 8:45 (3 min jog between), CD", "HR 155-165 bpm"),
  long("2027-02-20", 21, 9),
  // Week 22
  easy("2027-02-22", 22, 1, 4, "4 miles easy"),
  tempo("2027-02-24", 22, 3, 7, "8:50", 530, "7mi total: 1.5mi WU, 4mi continuous @ 8:50, CD", "HR 146-155 bpm"),
  easy("2027-02-26", 22, 5, 4, `4 miles easy ${STRIDES}`),
  splitLong("2027-02-27", 22, 13, "13mi: 4 easy, 8 @ 9:30 goal pace, 1 easy", "HR <135 / 145-155 bpm. Key session — full race dress rehearsal (gear, breakfast, gels)"),
  // Week 23
  easy("2027-03-01", 23, 1, 5, `5 miles easy ${STRIDES}`),
  tempo("2027-03-03", 23, 3, 6, "8:30", 510, "6mi total: 1.5mi WU, 5 x 1K @ 8:30 (2 min jog between), CD", "HR 155-165 bpm"),
  splitLong("2027-03-06", 23, 10, "10mi: first 5 easy, last 5 @ 9:30 goal pace", "HR <135 / 145-155 bpm"),
  // Week 24
  easy("2027-03-08", 24, 1, 3, "3 miles easy"),
  tempo("2027-03-10", 24, 3, 5, "9:30", 570, "Taper — 5mi total: 1mi WU, 3mi @ 9:30, CD", "HR 145-155 bpm"),
  easy("2027-03-12", 24, 5, 3, `3 miles easy ${STRIDES}`),
  long("2027-03-13", 24, 7),
  // Week 25 (race week)
  easy("2027-03-15", 25, 1, 3, "3 miles easy"),
  tempo("2027-03-17", 25, 3, 4, "9:30", 570, "4mi total: 1mi @ 9:30 + 4 strides, rest easy", "HR 145-155 bpm. Optional 15-20 min shakeout Fri"),
  { date: "2027-03-20", weekNumber: 25, weekday: 6, distanceMiles: 13.1, runType: "longRun", workoutType: "race", paceTarget: "9:30", targetPaceSecondsPerMile: 570, targetHeartRate: 160, description: "RACE — Rock and Roll Half Marathon, goal 9:30/mi (2:04:30)", notes: "Miles 1-3 @ 9:35-9:40, miles 4-10 @ 9:28-9:30, push the last 5K if you feel good" },
];

/** PlanWeek.notes for weeks 9-25 (week 8 is a partial week and keeps its notes). */
export const WEEK_NOTES: Record<number, string> = {
  9: "Holiday 3-run week",
  10: "4-run week",
  11: "3-run week",
  12: "4-run week",
  13: "Holiday + recovery 3-run week",
  14: "4-run week",
  15: "3-run week",
  16: "4-run week",
  17: "Recovery 3-run week",
  18: "4-run week",
  19: "3-run week",
  20: "4-run week",
  21: "Recovery 3-run week",
  22: "Peak 4-run week",
  23: "3-run week",
  24: "Taper 4-run week",
  25: "Race week",
};

/** Validation input: new-entry miles per week. */
export const EXPECTED_WEEKLY_NEW_MILES: Record<number, number> = {
  8: 18, 9: 15, 10: 22, 11: 21, 12: 24, 13: 17, 14: 23, 15: 23, 16: 24,
  17: 17, 18: 26, 19: 21, 20: 27, 21: 18, 22: 28, 23: 21, 24: 18, 25: 20.1,
};

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

// ─── Reporting helpers ───────────────────────────────────────────────────────

const fmt = (v: unknown) => (v === undefined ? "-" : JSON.stringify(v));

function weeklyMiles(weeks: PlanWeek[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const w of weeks) {
    out[w.weekNumber] = Math.round(
      w.entries.filter((e) => e.runType !== "rest").reduce((s, e) => s + e.distanceMiles, 0) * 100
    ) / 100;
  }
  return out;
}

function entryLine(start: string, week: number, e: PlannedRunEntry): string {
  return [
    plannedEntryIsoDate(start, e.weekIndex, e.weekday),
    `wk${week}`,
    `dow=${fmt(e.dayOfWeek)}`,
    `runType=${fmt(e.runType)}`,
    `workoutType=${fmt(e.workoutType)}`,
    `${e.distanceMiles}mi`,
    `pace=${fmt(e.paceTarget)}`,
    `sec=${fmt(e.targetPaceSecondsPerMile)}`,
    `hr=${fmt(e.targetHeartRate)}`,
    `desc=${fmt(e.description)}`,
    `notes=${fmt(e.notes)}`,
  ].join(" | ");
}

/** Infer how existing entries store dayOfWeek relative to weekday. */
export function inferDayOfWeekConvention(
  entries: Pick<PlannedRunEntry, "weekday" | "dayOfWeek">[]
): "weekday-1 (0=Mon)" | "weekday (1=Mon)" | "mixed/other" | "no entries" {
  if (entries.length === 0) return "no entries";
  if (entries.every((e) => e.dayOfWeek === e.weekday - 1)) return "weekday-1 (0=Mon)";
  if (entries.every((e) => e.dayOfWeek === e.weekday)) return "weekday (1=Mon)";
  return "mixed/other";
}

export interface ReplaceRunResult {
  planId: string;
  violations: string[];
  committed: boolean;
  backupPath?: string;
}

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
        JSON.stringify({ id: doc.id, name: data.name, status: data.status, isActive: data.isActive, startDate, travelRevision: data.travelRevision, linkedRaceId: data.linkedRaceId })
    );
  }
  return { doc, data, startDate, snapshot: doc };
}

export async function runReplaceRnrPlan(opts: { commit?: boolean } = {}): Promise<ReplaceRunResult> {
  const commit = opts.commit === true;
  const db = getDb();
  const { doc, data, startDate } = await loadTargetPlan(db);
  const oldWeeks = data.weeks as PlanWeek[];
  const mode = commit ? "COMMIT" : "DRY-RUN";

  console.log(`[replaceRnrPlan] mode=${mode} plan=${doc.id} name="${String(data.name)}" status=${String(data.status)} isActive=${String(data.isActive)} startDate=${startDate}`);
  console.log(`[replaceRnrPlan] untouched fields: travelRevision=${fmt(data.travelRevision)} linkedRaceId=${fmt(data.linkedRaceId)} weeks.length=${oldWeeks.length} updatedAt=${fmt(data.updatedAt)}`);

  // 1. Live table: every entry dated on/after 2026-11-16.
  const oldAll = oldWeeks.flatMap((w) => w.entries.map((e) => ({ week: w.weekNumber, e })));
  console.log("\n== LIVE ENTRIES dated >= 2026-11-16 ==");
  const live = oldAll
    .map(({ week, e }) => ({ week, e, date: plannedEntryIsoDate(startDate, e.weekIndex, e.weekday) }))
    .filter((x) => x.date >= "2026-11-16")
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const x of live) console.log("  " + entryLine(startDate, x.week, x.e));
  console.log(`  (${live.length} live entries >= 2026-11-16; ${live.filter((x) => x.date >= CUTOFF_DATE).length} >= ${CUTOFF_DATE})`);
  console.log(`\n== dayOfWeek convention in live entries: ${inferDayOfWeekConvention(oldAll.map((x) => x.e))} (new entries use weekday-1, 0=Mon) ==`);
  console.log(`== live runType tally: ${JSON.stringify(tally(oldAll.map((x) => x.e.runType)))} workoutType tally: ${JSON.stringify(tally(oldAll.map((x) => x.e.workoutType)))} ==`);

  // 2. Build and report.
  const result = buildReplacedWeeks(oldWeeks, startDate, CUTOFF_DATE, NEW_ENTRY_SPECS, WEEK_NOTES, () => randomUUID());
  console.log(`\n== KEPT entries (dated < ${CUTOFF_DATE}): ${result.keptEntries.length}; week 8 kept below ==`);
  for (const e of result.keptEntries.filter((x) => x.weekIndex === 7)) console.log("  " + entryLine(startDate, 8, e));
  console.log(`\n== REMOVED entries (dated >= ${CUTOFF_DATE}): ${result.removedEntries.length} ==`);
  for (const e of result.removedEntries.sort((a, b) => plannedEntryIsoDate(startDate, a.weekIndex, a.weekday).localeCompare(plannedEntryIsoDate(startDate, b.weekIndex, b.weekday)))) {
    console.log("  " + entryLine(startDate, e.weekIndex + 1, e));
  }
  console.log(`\n== ADDED entries: ${result.addedEntries.length} ==`);
  for (const e of result.addedEntries) console.log("  " + entryLine(startDate, e.weekIndex + 1, e));

  const before = weeklyMiles(oldWeeks);
  const after = weeklyMiles(result.weeks);
  console.log("\n== PER-WEEK planned miles (non-rest): before -> after ==");
  for (const wk of [...new Set([...Object.keys(before), ...Object.keys(after)].map(Number))].sort((a, b) => a - b)) {
    if (before[wk] === after[wk] && wk < 8) continue;
    console.log(`  week ${String(wk).padStart(2)}: ${before[wk] ?? "-"} -> ${after[wk] ?? "-"}`);
  }

  // 3. Validate.
  const violations = validateReplacedWeeks(oldWeeks, result, startDate, CUTOFF_DATE, EXPECTED_WEEKLY_NEW_MILES, { specs: NEW_ENTRY_SPECS });
  const convention = inferDayOfWeekConvention(oldAll.map((x) => x.e));
  if (convention !== "weekday-1 (0=Mon)" && convention !== "no entries") {
    violations.push(`Live dayOfWeek convention is "${convention}", new entries use weekday-1 — resolve before committing`);
  }
  console.log(`\n== VALIDATION: ${violations.length === 0 ? "OK (0 violations)" : violations.length + " violation(s)"} ==`);
  for (const v of violations) console.log("  VIOLATION: " + v);

  // 4. Prediction check (client-side logic only — no writes).
  const oldBaseline = computePlanEasyPaceBaseline(oldAll.map((x) => x.e));
  const newAllEntries = result.weeks.flatMap((w) => w.entries);
  const newBaseline = computePlanEasyPaceBaseline(newAllEntries);
  console.log(`\n== PREDICTION CHECK ==\n  computePlanEasyPaceBaseline old=${fmt(oldBaseline)} s/mi, new=${fmt(newBaseline)} s/mi`);
  const tiers = { PLANNED_QUALITY: 0, PLANNED: 0, dropped: 0 };
  const perEntry: string[] = [];
  for (const e of result.addedEntries) {
    const date = plannedEntryIsoDate(startDate, e.weekIndex, e.weekday);
    const d = new Date(`${date}T12:00:00Z`);
    const eff = planEntryToSyntheticEffort(e, d, d, newBaseline);
    const key = eff ? (eff.tier === "PLANNED_QUALITY" ? "PLANNED_QUALITY" : "PLANNED") : "dropped";
    tiers[key]++;
    perEntry.push(`    ${date} ${e.workoutType} ${e.distanceMiles}mi pace=${fmt(e.paceTarget)} -> ${key}`);
  }
  console.log(`  new entries by tier: ${JSON.stringify(tiers)} (total ${result.addedEntries.length})`);
  for (const l of perEntry) console.log(l);

  if (!commit) {
    console.log("\n[replaceRnrPlan] DRY-RUN — wrote 0 docs.");
    return { planId: doc.id, violations, committed: false };
  }

  // ── Commit ──
  if (violations.length > 0) {
    throw new Error(`Aborting commit: ${violations.length} violation(s) — see above`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(homedir(), "training-web-backups");
  mkdirSync(dir, { recursive: true });
  const backupPath = path.join(dir, `rnr-weeks-${stamp}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify({ planId: doc.id, capturedAt: new Date().toISOString(), weeks: oldWeeks }, null, 2),
    "utf8"
  );
  console.log(`\n[replaceRnrPlan] backup written: ${backupPath}`);

  const intended = stripUndefined(result.weeks);
  // Precondition: abort if the doc changed since we read it (e.g. an open browser tab saved).
  await doc.ref.update(stripUndefined({ weeks: intended, updatedAt: new Date().toISOString() }), {
    lastUpdateTime: doc.updateTime!,
  });

  const back = await doc.ref.get();
  const backWeeks = back.data()?.weeks as PlanWeek[] | undefined;
  const ok = backWeeks !== undefined && deepEqual(backWeeks, intended);
  console.log(`[replaceRnrPlan] read-back deep-equal to intended weeks: ${ok ? "YES" : "NO"}`);
  if (!ok) throw new Error("Read-back does not match the intended weeks");
  const after2 = back.data()!;
  console.log(`[replaceRnrPlan] unchanged: name="${String(after2.name)}" status=${String(after2.status)} isActive=${String(after2.isActive)} startDate=${fmt(after2.startDate)} travelRevision=${fmt(after2.travelRevision)} linkedRaceId=${fmt(after2.linkedRaceId)}`);
  return { planId: doc.id, violations, committed: true, backupPath };
}

function tally(values: unknown[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const v of values) m[String(v)] = (m[String(v)] ?? 0) + 1;
  return m;
}
