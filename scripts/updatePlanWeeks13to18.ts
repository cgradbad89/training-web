/**
 * One-off content update: rewrite weeks 13-18 (2026-08-10 .. 2026-09-20) of the
 * active RunningPlan for a specific uid to match a source training schedule,
 * including a no-running block override for 2026-09-09/10/12.
 *
 * Firestore shape: users/{uid}/plans/{planId} is a single doc holding a
 * `weeks: PlanWeek[]` array (weeks[].entries[]: PlannedRunEntry[]). There is
 * no per-entry date field — calendar date is derived as
 * startDate + weekIndex*7 + (weekday-1) (see src/utils/icsExport.ts). Firestore
 * field paths don't support array-index updates, so a changed entry requires
 * rewriting the whole `weeks` array; this script still only *mutates* the
 * fields that differ from target, matched entry-by-entry via computed date.
 *
 * paceTarget/targetPaceSecondsPerMile are a companion pair — planActualTable's
 * plannedPaceFor() prefers the numeric field over the string when both are
 * set, so whenever paceTarget changes, targetPaceSecondsPerMile must be kept
 * in sync (single pace -> parsePaceString; range "A-B" -> midpoint, matching
 * how paceRangeTrend/runAnalysisTrend already treat range targets elsewhere
 * in this codebase) to avoid a stale numeric field silently overriding the
 * new string in the UI.
 *
 * Driven by an env-gated Vitest entry (scripts/updatePlanWeeks13to18.test.ts),
 * same convention as scripts/repairHasRoute.ts / backfillTrainingLoad.ts:
 *
 *   Dry-run (writes NOTHING, prints diff table):
 *     UPDATEPLAN=1      npx vitest run scripts/updatePlanWeeks13to18.test.ts
 *   Commit (performs the writes):
 *     UPDATEPLAN=commit npx vitest run scripts/updatePlanWeeks13to18.test.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import admin from "firebase-admin";
import { parsePaceString } from "../src/utils/pace";

export const TARGET_UID = "eR9gJQK1eBflP9syhPRtPbiF6Kh2";

export interface TargetRow {
  date: string; // YYYY-MM-DD
  runType: "outdoor" | "longRun" | "rest";
  distanceMiles: number;
  paceTarget?: string; // e.g. "10:30" or "8:50-9:10"; undefined for rest
  description: string;
}

// ─── Source schedule, weeks 13-18 (2026-08-10 .. 2026-09-20) ──────────────
export const TARGETS: TargetRow[] = [
  // Week 13
  { date: "2026-08-10", runType: "outdoor", distanceMiles: 3, paceTarget: "10:30", description: "3 miles easy" },
  { date: "2026-08-11", runType: "outdoor", distanceMiles: 6, paceTarget: "8:50-9:10", description: "2 miles easy + 4 miles @ 9:00 pace + 1 mile easy" },
  { date: "2026-08-12", runType: "outdoor", distanceMiles: 4, paceTarget: "10:30", description: "4 miles easy" },
  { date: "2026-08-13", runType: "outdoor", distanceMiles: 4, paceTarget: "10:30", description: "4 miles easy" },
  { date: "2026-08-14", runType: "rest", distanceMiles: 0, description: "Rest" },
  { date: "2026-08-15", runType: "longRun", distanceMiles: 11, paceTarget: "10:08", description: "11 miles (last 2 @ 9:00)" },
  { date: "2026-08-16", runType: "rest", distanceMiles: 0, description: "Rest" },

  // Week 14
  { date: "2026-08-17", runType: "outdoor", distanceMiles: 3, paceTarget: "10:30", description: "3 miles easy" },
  { date: "2026-08-18", runType: "outdoor", distanceMiles: 6, paceTarget: "8:50-9:10", description: "2 miles easy + 4 miles @ 9:00 pace + 1 mile easy" },
  { date: "2026-08-19", runType: "outdoor", distanceMiles: 4, paceTarget: "10:30", description: "4 miles easy" },
  { date: "2026-08-20", runType: "outdoor", distanceMiles: 4, paceTarget: "10:30", description: "4 miles easy" },
  { date: "2026-08-21", runType: "rest", distanceMiles: 0, description: "Rest" },
  { date: "2026-08-22", runType: "longRun", distanceMiles: 12, paceTarget: "10:08", description: "12 miles (last 2 @ 9:00)" },
  { date: "2026-08-23", runType: "rest", distanceMiles: 0, description: "Rest" },

  // Week 15
  { date: "2026-08-24", runType: "outdoor", distanceMiles: 3, paceTarget: "10:30", description: "3 miles easy" },
  { date: "2026-08-25", runType: "outdoor", distanceMiles: 7, paceTarget: "8:50-9:10", description: "2 miles easy + 5 miles @ 9:00 pace + 1 mile easy" },
  { date: "2026-08-26", runType: "outdoor", distanceMiles: 4, paceTarget: "10:30", description: "4 miles easy" },
  { date: "2026-08-27", runType: "outdoor", distanceMiles: 4, paceTarget: "10:30", description: "4 miles easy" },
  { date: "2026-08-28", runType: "rest", distanceMiles: 0, description: "Rest" },
  { date: "2026-08-29", runType: "longRun", distanceMiles: 13, paceTarget: "10:08", description: "13 miles (last 3 @ 9:00)" },
  { date: "2026-08-30", runType: "rest", distanceMiles: 0, description: "Rest" },

  // Week 16
  { date: "2026-08-31", runType: "outdoor", distanceMiles: 3, paceTarget: "10:30", description: "3 miles easy" },
  { date: "2026-09-01", runType: "outdoor", distanceMiles: 6, paceTarget: "8:45", description: "2 miles easy + 6x800m hard (8:45 pace) with 400m jog + 1.5 miles easy" },
  { date: "2026-09-02", runType: "outdoor", distanceMiles: 4, paceTarget: "10:30", description: "4 miles easy" },
  { date: "2026-09-03", runType: "outdoor", distanceMiles: 4, paceTarget: "10:30", description: "4 miles easy" },
  { date: "2026-09-04", runType: "rest", distanceMiles: 0, description: "Rest" },
  { date: "2026-09-05", runType: "longRun", distanceMiles: 10, paceTarget: "10:30", description: "10 miles easy" },
  { date: "2026-09-06", runType: "rest", distanceMiles: 0, description: "Rest" },

  // Week 17 — adjusted for the Sep 9-13 no-running block
  { date: "2026-09-07", runType: "outdoor", distanceMiles: 3, paceTarget: "10:30", description: "3 miles easy" },
  { date: "2026-09-08", runType: "outdoor", distanceMiles: 5, paceTarget: "8:50-9:10", description: "2 miles easy + 3 miles @ 9:00 pace + 1 mile easy" },
  { date: "2026-09-09", runType: "rest", distanceMiles: 0, description: "Rest (no-running block)" },
  { date: "2026-09-10", runType: "rest", distanceMiles: 0, description: "Rest (no-running block)" },
  { date: "2026-09-11", runType: "rest", distanceMiles: 0, description: "Rest" },
  { date: "2026-09-12", runType: "rest", distanceMiles: 0, description: "Rest (no-running block)" },
  { date: "2026-09-13", runType: "rest", distanceMiles: 0, description: "Rest" },

  // Week 18 - race week (unchanged from source document; included for full verification coverage)
  { date: "2026-09-14", runType: "rest", distanceMiles: 0, description: "Rest" },
  { date: "2026-09-15", runType: "outdoor", distanceMiles: 3, description: "3 miles easy + 4x30s strides" },
  { date: "2026-09-16", runType: "outdoor", distanceMiles: 3, paceTarget: "10:30", description: "3 miles easy" },
  { date: "2026-09-17", runType: "outdoor", distanceMiles: 2, paceTarget: "10:30", description: "2 miles shakeout" },
  { date: "2026-09-18", runType: "rest", distanceMiles: 0, description: "Rest" },
  { date: "2026-09-19", runType: "rest", distanceMiles: 0, description: "Rest" },
  { date: "2026-09-20", runType: "longRun", distanceMiles: 13.1, paceTarget: "9:00-9:09", description: "Half Marathon — 13.1 miles" },
];

function loadServiceAccount(): Record<string, unknown> {
  const env = readFileSync(".env.local", "utf8");
  const line = env.split("\n").find((l) => l.startsWith("FIREBASE_SERVICE_ACCOUNT_JSON="));
  if (!line) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON not found in .env.local");
  let val = line.slice("FIREBASE_SERVICE_ACCOUNT_JSON=".length).trim();
  if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
    val = val.slice(1, -1);
  }
  return JSON.parse(val);
}

function getDb(): admin.firestore.Firestore {
  if (!admin.apps.length) {
    const svc = loadServiceAccount();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    admin.initializeApp({ credential: admin.credential.cert(svc as any) });
  }
  return admin.firestore();
}

function dateForEntry(startDate: string, weekIndex: number, weekday: number): string {
  const [y, m, d] = startDate.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  start.setUTCDate(start.getUTCDate() + weekIndex * 7 + (weekday - 1));
  return start.toISOString().slice(0, 10);
}

/** Midpoint seconds/mi for a "A-B" range string, else parsePaceString. */
function paceStringToSeconds(pace: string): number | null {
  const rangeMatch = pace.trim().match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (rangeMatch) {
    const lo = parsePaceString(rangeMatch[1]);
    const hi = parsePaceString(rangeMatch[2]);
    if (lo == null || hi == null) return null;
    return Math.round((lo + hi) / 2);
  }
  return parsePaceString(pace);
}

export interface FieldDiff {
  field: string;
  before: unknown;
  after: unknown;
}

export interface EntryResult {
  date: string;
  found: boolean;
  entryId?: string;
  weekArrIndex?: number;
  entryArrIndex?: number;
  diffs: FieldDiff[];
}

export interface RunResult {
  planId: string;
  planName: string;
  startDate: string;
  results: EntryResult[];
  failures: { date: string; error: string }[];
  committed: boolean;
}

/** Read-only: dump every stored entry whose computed date falls in [from, to]. */
export async function dumpRawRange(from: string, to: string): Promise<void> {
  const db = getDb();
  const planSnap = await db.collection(`users/${TARGET_UID}/plans`).get();
  const activeDoc = planSnap.docs.find((d) => {
    const data = d.data();
    const planType = (data.planType as string | undefined) ?? "running";
    if (planType !== "running") return false;
    if (typeof data.status === "string") return data.status === "active";
    return data.isActive === true;
  });
  if (!activeDoc) throw new Error(`No active RunningPlan found for uid=${TARGET_UID}`);
  const plan = activeDoc.data() as {
    name?: string;
    startDate: string;
    travelRevision?: string;
    weeks: Array<{ weekNumber: number; notes?: string; entries: Record<string, unknown>[] }>;
  };
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };
  log(`[dumpRawRange] plan=${activeDoc.id} name=${plan.name} startDate=${plan.startDate} weeks.length=${plan.weeks.length} travelRevision=${plan.travelRevision}`);
  for (const w of plan.weeks) {
    if (w.weekNumber >= 13 && w.weekNumber <= 18) {
      log(`  week#${w.weekNumber} notes=${JSON.stringify(w.notes)} entryCount=${w.entries.length}`);
    }
  }
  const rows: { date: string; weekNumber: number; weekIndex: unknown; weekday: unknown; runType: unknown; distanceMiles: unknown; paceTarget: unknown; description: unknown; notes: unknown }[] = [];
  for (let wi = 0; wi < plan.weeks.length; wi++) {
    const week = plan.weeks[wi];
    for (const entry of week.entries) {
      const date = dateForEntry(plan.startDate, entry.weekIndex as number, entry.weekday as number);
      if (date < from || date > to) continue;
      rows.push({
        date,
        weekNumber: week.weekNumber,
        weekIndex: entry.weekIndex,
        weekday: entry.weekday,
        runType: entry.runType,
        distanceMiles: entry.distanceMiles,
        paceTarget: entry.paceTarget,
        description: entry.description,
        notes: entry.notes,
      });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  for (const r of rows) {
    log(
      `  ${r.date}  wk#${r.weekNumber} weekIndex=${r.weekIndex} weekday=${r.weekday} runType=${r.runType} dist=${r.distanceMiles} pace=${JSON.stringify(r.paceTarget)} desc=${JSON.stringify(r.description)} notes=${JSON.stringify(r.notes)}`
    );
  }
  log(`[dumpRawRange] total entries in range: ${rows.length}`);
  const reportPath = process.env.UPDATEPLAN_REPORT;
  if (reportPath) writeFileSync(reportPath, lines.join("\n"), "utf8");
}

// ─── Phase 2 (follow-up session): restore 7 entries stripped by the prior
// reduced-travel-v1 migration. Values cross-checked against
// src/lib/seedData.ts's SEPT_HM_PLAN_ENTRIES (the canonical source this plan
// was seeded from) — all match exactly except 2026-09-08's paceTarget, where
// the live sibling convention (established on 8/11, 8/18, 8/25 in the prior
// session) stores the literal "8:50-9:10" range string rather than the seed's
// collapsed single-value midpoint "9:00"; both agree on the underlying
// targetPaceSecondsPerMile (540).
//
// IDs deliberately do NOT reuse the seed's "sept-hm-w{weekIndex}-d{weekday}"
// convention: sept-hm-w16-d2 already exists in the live plan but was
// repurposed to weekday=5 (Fri 9/11) by an earlier edit without renaming its
// id, so generating that id for the new weekday=2 (9/8) entry would collide.
// crypto.randomUUID() (matching createPlan's own id scheme in
// src/services/plans.ts) sidesteps that risk entirely for all 7 inserts. ────

export interface InsertRow {
  date: string;
  weekNumber: number;
  weekday: number;
  runType: "outdoor";
  distanceMiles: number;
  paceTarget?: string;
  description: string;
}

export const INSERTS: InsertRow[] = [
  { date: "2026-08-19", weekNumber: 14, weekday: 3, runType: "outdoor", distanceMiles: 4, paceTarget: "10:30", description: "4 miles easy" },
  { date: "2026-08-24", weekNumber: 15, weekday: 1, runType: "outdoor", distanceMiles: 3, paceTarget: "10:30", description: "3 miles easy" },
  { date: "2026-08-26", weekNumber: 15, weekday: 3, runType: "outdoor", distanceMiles: 4, paceTarget: "10:30", description: "4 miles easy" },
  { date: "2026-09-02", weekNumber: 16, weekday: 3, runType: "outdoor", distanceMiles: 4, paceTarget: "10:30", description: "4 miles easy" },
  { date: "2026-09-08", weekNumber: 17, weekday: 2, runType: "outdoor", distanceMiles: 5, paceTarget: "8:50-9:10", description: "2 miles easy + 3 miles @ 9:00 pace + 1 mile easy" },
  { date: "2026-09-15", weekNumber: 18, weekday: 2, runType: "outdoor", distanceMiles: 3, description: "3 miles easy + 4x30s strides" },
  { date: "2026-09-17", weekNumber: 18, weekday: 4, runType: "outdoor", distanceMiles: 2, paceTarget: "10:30", description: "2 miles shakeout" },
];

export interface InsertResult {
  date: string;
  weekNumber: number;
  weekday: number;
  inserted: boolean;
  insertedAtArrayIndex?: number;
  entryId?: string;
  entry?: Record<string, unknown>;
  error?: string;
}

export interface InsertRunResult {
  planId: string;
  planName: string;
  startDate: string;
  entryCountBefore: number;
  entryCountAfter: number;
  results: InsertResult[];
  committed: boolean;
}

export async function runInsertMissingEntries(opts: { commit?: boolean } = {}): Promise<InsertRunResult> {
  const commit = opts.commit === true;
  const db = getDb();

  const planSnap = await db.collection(`users/${TARGET_UID}/plans`).get();
  const activeDoc = planSnap.docs.find((d) => {
    const data = d.data();
    const planType = (data.planType as string | undefined) ?? "running";
    if (planType !== "running") return false;
    if (typeof data.status === "string") return data.status === "active";
    return data.isActive === true;
  });
  if (!activeDoc) throw new Error(`No active RunningPlan found for uid=${TARGET_UID}`);

  const plan = activeDoc.data() as {
    name?: string;
    startDate: string;
    weeks: Array<{ weekNumber: number; entries: Record<string, unknown>[] }>;
  };

  const entryCountBefore = plan.weeks.reduce((sum, w) => sum + w.entries.length, 0);
  const results: InsertResult[] = [];

  for (const target of INSERTS) {
    try {
      const week = plan.weeks.find((w) => w.weekNumber === target.weekNumber);
      if (!week) {
        results.push({ date: target.date, weekNumber: target.weekNumber, weekday: target.weekday, inserted: false, error: `week ${target.weekNumber} not found in plan` });
        continue;
      }

      // Safety check: an entry already computing to this date would mean our
      // Phase 1 gap analysis is stale — do not silently overwrite.
      const already = week.entries.find((e) => {
        const d = dateForEntry(plan.startDate, e.weekIndex as number, e.weekday as number);
        return d === target.date;
      });
      if (already) {
        results.push({ date: target.date, weekNumber: target.weekNumber, weekday: target.weekday, inserted: false, error: `an entry already exists for this date (id=${already.id})` });
        continue;
      }

      const weekIndexForWeek = target.weekNumber - 1;
      // Verify weekIndex against a sibling in this same week rather than
      // assuming weekNumber-1 (Phase 1 requirement).
      const siblingWeekIndex = week.entries.length > 0 ? (week.entries[0].weekIndex as number) : weekIndexForWeek;
      if (siblingWeekIndex !== weekIndexForWeek) {
        results.push({ date: target.date, weekNumber: target.weekNumber, weekday: target.weekday, inserted: false, error: `weekIndex mismatch: sibling has weekIndex=${siblingWeekIndex}, expected ${weekIndexForWeek}` });
        continue;
      }

      const newEntry: Record<string, unknown> = {
        id: crypto.randomUUID(),
        weekIndex: weekIndexForWeek,
        weekday: target.weekday,
        dayOfWeek: target.weekday - 1,
        distanceMiles: target.distanceMiles,
        runType: target.runType,
        description: target.description,
        targetHeartRate: null,
      };
      if (target.paceTarget) {
        newEntry.paceTarget = target.paceTarget;
        newEntry.targetPaceSecondsPerMile = paceStringToSeconds(target.paceTarget) ?? undefined;
      }

      // Insert sorted by weekday ascending, matching the existing convention
      // in every week's entries array (date calc itself is field-driven, not
      // position-driven, but this keeps display order consistent).
      let insertAt = week.entries.length;
      for (let i = 0; i < week.entries.length; i++) {
        if ((week.entries[i].weekday as number) > target.weekday) {
          insertAt = i;
          break;
        }
      }

      if (commit) {
        week.entries.splice(insertAt, 0, newEntry);
      }

      results.push({
        date: target.date,
        weekNumber: target.weekNumber,
        weekday: target.weekday,
        inserted: true,
        insertedAtArrayIndex: insertAt,
        entryId: newEntry.id as string,
        entry: newEntry,
      });
    } catch (e) {
      results.push({ date: target.date, weekNumber: target.weekNumber, weekday: target.weekday, inserted: false, error: String(e) });
    }
  }

  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };
  log(`[insertMissingEntries] plan=${activeDoc.id} name=${plan.name} startDate=${plan.startDate} mode=${commit ? "COMMIT" : "DRY-RUN"}`);
  for (const r of results) {
    if (r.inserted) {
      log(`  ${r.date} (wk${r.weekNumber} weekday=${r.weekday}) -> INSERT at arrayIndex=${r.insertedAtArrayIndex}: ${JSON.stringify(r.entry)}`);
    } else {
      log(`  ${r.date} (wk${r.weekNumber} weekday=${r.weekday}) -> FAILED: ${r.error}`);
    }
  }

  const insertedCount = results.filter((r) => r.inserted).length;
  const entryCountAfter = commit
    ? plan.weeks.reduce((sum, w) => sum + w.entries.length, 0)
    : entryCountBefore;
  log(`[insertMissingEntries] entryCountBefore=${entryCountBefore} entryCountAfter=${entryCountAfter} inserted=${insertedCount}/${INSERTS.length}`);

  const reportPath = process.env.UPDATEPLAN_REPORT;
  if (reportPath) writeFileSync(reportPath, lines.join("\n"), "utf8");

  if (commit && insertedCount > 0) {
    await activeDoc.ref.update({ weeks: plan.weeks, updatedAt: new Date().toISOString() });
    log(`[insertMissingEntries] COMMIT complete — wrote weeks field on plan ${activeDoc.id}.`);
  }

  return {
    planId: activeDoc.id,
    planName: (plan.name as string) ?? "",
    startDate: plan.startDate,
    entryCountBefore,
    entryCountAfter,
    results,
    committed: commit && insertedCount > 0,
  };
}

/** Read-only: dump full raw JSON of every entry in the given weekNumbers. */
export async function dumpFullEntriesForWeeks(weekNumbers: number[]): Promise<void> {
  const db = getDb();
  const planSnap = await db.collection(`users/${TARGET_UID}/plans`).get();
  const activeDoc = planSnap.docs.find((d) => {
    const data = d.data();
    const planType = (data.planType as string | undefined) ?? "running";
    if (planType !== "running") return false;
    if (typeof data.status === "string") return data.status === "active";
    return data.isActive === true;
  });
  if (!activeDoc) throw new Error(`No active RunningPlan found for uid=${TARGET_UID}`);
  const plan = activeDoc.data() as { weeks: Array<{ weekNumber: number; entries: Record<string, unknown>[] }> };
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };
  for (const week of plan.weeks) {
    if (!weekNumbers.includes(week.weekNumber)) continue;
    log(`week#${week.weekNumber} entryCount=${week.entries.length}`);
    for (const e of week.entries) {
      log(`  ${JSON.stringify(e)}`);
    }
  }
  const reportPath = process.env.UPDATEPLAN_REPORT;
  if (reportPath) writeFileSync(reportPath, lines.join("\n"), "utf8");
}

export async function runUpdatePlanWeeks(opts: { commit?: boolean } = {}): Promise<RunResult> {
  const commit = opts.commit === true;
  const db = getDb();

  const planSnap = await db.collection(`users/${TARGET_UID}/plans`).get();
  const activeDoc = planSnap.docs.find((d) => {
    const data = d.data();
    const planType = (data.planType as string | undefined) ?? "running";
    if (planType !== "running") return false;
    if (typeof data.status === "string") return data.status === "active";
    return data.isActive === true;
  });

  if (!activeDoc) {
    throw new Error(`No active RunningPlan found for uid=${TARGET_UID}`);
  }

  const plan = activeDoc.data() as {
    name?: string;
    startDate: string;
    weeks: Array<{ weekNumber: number; entries: Record<string, unknown>[]; notes?: string }>;
  };

  const results: EntryResult[] = [];
  const failures: { date: string; error: string }[] = [];

  for (const target of TARGETS) {
    let matched = false;
    try {
      for (let wi = 0; wi < plan.weeks.length && !matched; wi++) {
        const week = plan.weeks[wi];
        for (let ei = 0; ei < week.entries.length; ei++) {
          const entry = week.entries[ei];
          const computedDate = dateForEntry(
            plan.startDate,
            entry.weekIndex as number,
            entry.weekday as number
          );
          if (computedDate !== target.date) continue;
          matched = true;

          const diffs: FieldDiff[] = [];

          if ((entry.runType ?? undefined) !== target.runType) {
            diffs.push({ field: "runType", before: entry.runType, after: target.runType });
          }
          if ((entry.distanceMiles ?? 0) !== target.distanceMiles) {
            diffs.push({
              field: "distanceMiles",
              before: entry.distanceMiles,
              after: target.distanceMiles,
            });
          }
          if ((entry.paceTarget ?? undefined) !== target.paceTarget) {
            diffs.push({ field: "paceTarget", before: entry.paceTarget, after: target.paceTarget });
          }
          if ((entry.description ?? undefined) !== target.description) {
            diffs.push({
              field: "description",
              before: entry.description,
              after: target.description,
            });
          }

          // Keep targetPaceSecondsPerMile in sync with paceTarget only when
          // paceTarget itself is changing (plannedPaceFor() prefers the
          // numeric field, so a stale value would silently override the new
          // string in the UI).
          if (diffs.some((d) => d.field === "paceTarget")) {
            const newSeconds = target.paceTarget ? paceStringToSeconds(target.paceTarget) : undefined;
            const newSecondsVal = newSeconds ?? undefined;
            if ((entry.targetPaceSecondsPerMile ?? undefined) !== newSecondsVal) {
              diffs.push({
                field: "targetPaceSecondsPerMile",
                before: entry.targetPaceSecondsPerMile,
                after: newSecondsVal,
              });
            }
          }

          results.push({
            date: target.date,
            found: true,
            entryId: entry.id as string,
            weekArrIndex: wi,
            entryArrIndex: ei,
            diffs,
          });

          if (commit && diffs.length > 0) {
            for (const d of diffs) {
              if (d.after === undefined) {
                delete (entry as Record<string, unknown>)[d.field];
              } else {
                (entry as Record<string, unknown>)[d.field] = d.after;
              }
            }
          }
        }
      }

      if (!matched) {
        failures.push({ date: target.date, error: "No PlannedRunEntry found for this date in the active plan" });
      }
    } catch (e) {
      failures.push({ date: target.date, error: String(e) });
    }
  }

  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };

  log(`[updatePlanWeeks13to18] plan=${activeDoc.id} name=${plan.name} startDate=${plan.startDate}`);
  for (const r of results) {
    if (r.diffs.length === 0) {
      log(`  ${r.date}  no change`);
    } else {
      log(`  ${r.date}  ${r.diffs.length} field(s) changing:`);
      for (const d of r.diffs) {
        log(`      ${d.field}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`);
      }
    }
  }
  if (failures.length > 0) {
    log(`[updatePlanWeeks13to18] FAILURES:`);
    for (const f of failures) log(`  ${f.date}: ${f.error}`);
  }

  const changedCount = results.filter((r) => r.diffs.length > 0).length;
  log(
    `[updatePlanWeeks13to18] mode=${commit ? "COMMIT" : "DRY-RUN"} matched=${results.length}/${TARGETS.length} changed=${changedCount} failures=${failures.length}`
  );

  const reportPath = process.env.UPDATEPLAN_REPORT;
  if (reportPath) {
    writeFileSync(reportPath, lines.join("\n"), "utf8");
  }

  if (commit && changedCount > 0) {
    await activeDoc.ref.update({
      weeks: plan.weeks,
      updatedAt: new Date().toISOString(),
    });
    console.log(`[updatePlanWeeks13to18] COMMIT complete — wrote weeks field on plan ${activeDoc.id}.`);
  } else if (!commit) {
    console.log(`[updatePlanWeeks13to18] DRY-RUN — wrote 0 docs. Re-run with commit:true to persist.`);
  }

  return {
    planId: activeDoc.id,
    planName: (plan.name as string) ?? "",
    startDate: plan.startDate,
    results,
    failures,
    committed: commit && changedCount > 0,
  };
}
