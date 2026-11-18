/**
 * Pure helpers for replacing the tail of a running plan (every entry dated on or
 * after a cutoff) with a new set of entries. No Firestore, no React, no IO — the
 * admin script `scripts/replaceRnrPlanFrom20261118.ts` owns reads/writes.
 *
 * Domain model (PRD §5): a plan stores `startDate` + `weeks: PlanWeek[]`; an
 * entry's calendar date is DERIVED as startDate + weekIndex*7 + (weekday-1) days
 * and `weekIndex = weekNumber - 1`. Nothing persisted references running-plan
 * entry ids (matches are computed client-side), so new entries get fresh ids.
 */

import type { PlannedRunEntry, PlanWeek, PlanRunType } from "@/types/plan";

export interface NewPlanEntrySpec {
  /** YYYY-MM-DD, informational — must equal the computed date. */
  date: string;
  /** 1-based. */
  weekNumber: number;
  /** 1=Mon … 7=Sun. */
  weekday: number;
  distanceMiles: number;
  runType: PlanRunType;
  workoutType: NonNullable<PlannedRunEntry["workoutType"]>;
  paceTarget: string;
  /** Omit = unset (the field is not written at all — never 0/NaN). */
  targetPaceSecondsPerMile?: number;
  targetHeartRate: number | null;
  description: string;
  /** Omit when there are no notes. */
  notes?: string;
}

export interface ReplacePlanResult {
  weeks: PlanWeek[];
  /** Entries dated before the cutoff (untouched). */
  keptEntries: PlannedRunEntry[];
  /** Entries of the OLD plan dated on/after the cutoff. */
  removedEntries: PlannedRunEntry[];
  addedEntries: PlannedRunEntry[];
}

const VALID_RUN_TYPES: readonly PlanRunType[] = [
  "outdoor",
  "treadmill",
  "otf",
  "longRun",
  "rest",
];

/** Defaults for the Rock and Roll replacement; tests override them. */
export const EXPECTED_WEEK_COUNT = 25;
export const EXPECTED_NEW_ENTRY_COUNT = 62;

// ─── Date helpers (UTC arithmetic: independent of the host timezone) ─────────

function isoToUtcMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** startDate + weekIndex*7 + (weekday-1) days, as YYYY-MM-DD. */
export function plannedEntryIsoDate(
  startDate: string,
  weekIndex: number,
  weekday: number
): string {
  const ms = isoToUtcMs(startDate) + (weekIndex * 7 + (weekday - 1)) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function entryDate(startDate: string, e: PlannedRunEntry): string {
  return plannedEntryIsoDate(startDate, e.weekIndex, e.weekday);
}

function weekMondayIso(startDate: string, weekNumber: number): string {
  return plannedEntryIsoDate(startDate, weekNumber - 1, 1);
}

// ─── Deep equality (key-order independent: Firestore re-orders map keys) ─────

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  return ak.length === bk.length && ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}

// ─── Build ───────────────────────────────────────────────────────────────────

function entryFromSpec(spec: NewPlanEntrySpec, id: string): PlannedRunEntry {
  const entry: PlannedRunEntry = {
    id,
    weekIndex: spec.weekNumber - 1,
    weekday: spec.weekday,
    dayOfWeek: spec.weekday - 1, // 0=Mon … 6=Sun (same as makeNewRunEntry / seed data)
    distanceMiles: spec.distanceMiles,
    runType: spec.runType,
    workoutType: spec.workoutType,
    paceTarget: spec.paceTarget,
    targetHeartRate: spec.targetHeartRate,
    description: spec.description,
  };
  // Optional fields are only present when set — never 0, NaN or "".
  if (spec.targetPaceSecondsPerMile != null) {
    entry.targetPaceSecondsPerMile = spec.targetPaceSecondsPerMile;
  }
  if (spec.notes != null && spec.notes !== "") entry.notes = spec.notes;
  return entry;
}

/**
 * Keeps every entry dated before `cutoffDate` byte-identical, drops entries on or
 * after it, and inserts the specs. Sets PlanWeek.notes from `weekNotes` ONLY for
 * weeks that begin on/after the cutoff (a partial week keeps its notes).
 *
 * Throws on a spec whose computed date differs from its `date`, or that is dated
 * before the cutoff. Duplicate dates/ids are NOT thrown here — they are reported
 * by `validateReplacedWeeks` so a dry-run can show every problem at once.
 */
export function buildReplacedWeeks(
  currentWeeks: PlanWeek[],
  startDate: string,
  cutoffDate: string,
  specs: NewPlanEntrySpec[],
  weekNotes: Record<number, string>,
  newId: () => string
): ReplacePlanResult {
  for (const spec of specs) {
    if (!(spec.weekday >= 1 && spec.weekday <= 7)) {
      throw new Error(`Spec ${spec.date}: weekday ${spec.weekday} is not 1..7`);
    }
    const computed = plannedEntryIsoDate(startDate, spec.weekNumber - 1, spec.weekday);
    if (computed !== spec.date) {
      throw new Error(
        `Spec date mismatch: week ${spec.weekNumber} weekday ${spec.weekday} is ${computed}, spec says ${spec.date}`
      );
    }
    if (spec.date < cutoffDate) {
      throw new Error(`Spec ${spec.date} is before the cutoff ${cutoffDate}`);
    }
  }

  const keptEntries: PlannedRunEntry[] = [];
  const removedEntries: PlannedRunEntry[] = [];
  for (const week of currentWeeks) {
    for (const e of week.entries) {
      (entryDate(startDate, e) < cutoffDate ? keptEntries : removedEntries).push(e);
    }
  }

  const added = specs
    .map((spec) => ({ spec, entry: entryFromSpec(spec, newId()) }))
    .sort((a, b) => a.spec.date.localeCompare(b.spec.date));
  const addedEntries = added.map((x) => x.entry);

  const weekNumbers = new Set<number>(currentWeeks.map((w) => w.weekNumber));
  for (const spec of specs) weekNumbers.add(spec.weekNumber);

  const weeks: PlanWeek[] = [...weekNumbers]
    .sort((a, b) => a - b)
    .map((weekNumber) => {
      const old = currentWeeks.find((w) => w.weekNumber === weekNumber);
      const week: PlanWeek = old
        ? { ...old, entries: old.entries.filter((e) => entryDate(startDate, e) < cutoffDate) }
        : { weekNumber, entries: [] };
      week.entries = [
        ...week.entries,
        ...addedEntries.filter((e) => e.weekIndex === weekNumber - 1),
      ];
      if (
        weekNumber in weekNotes &&
        weekMondayIso(startDate, weekNumber) >= cutoffDate
      ) {
        week.notes = weekNotes[weekNumber];
      }
      return week;
    });

  return { weeks, keptEntries, removedEntries, addedEntries };
}

// ─── Validate ────────────────────────────────────────────────────────────────

export interface ValidateOptions {
  /** When given, each spec's computed date is cross-checked against its entry. */
  specs?: NewPlanEntrySpec[];
  expectedNewEntryCount?: number;
  expectedWeekCount?: number;
  /** The plan's final entry (default: Rock and Roll Half, 2027-03-20, 13.1 mi). */
  finalRace?: { date: string; distanceMiles: number };
}

/** Returns human-readable violations. An empty array means valid. */
export function validateReplacedWeeks(
  before: PlanWeek[],
  after: ReplacePlanResult,
  startDate: string,
  cutoffDate: string,
  expectedWeeklyNewMiles: Record<number, number>,
  options: ValidateOptions = {}
): string[] {
  const {
    specs,
    expectedNewEntryCount = EXPECTED_NEW_ENTRY_COUNT,
    expectedWeekCount = EXPECTED_WEEK_COUNT,
    finalRace = { date: "2027-03-20", distanceMiles: 13.1 },
  } = options;
  const v: string[] = [];

  const beforeEntries = before.flatMap((w) => w.entries);
  const afterEntries = after.weeks.flatMap((w) => w.entries);

  // 1. Pre-cutoff entries are deep-equal before and after (and nothing was lost).
  const beforePre = beforeEntries.filter((e) => entryDate(startDate, e) < cutoffDate);
  const afterPre = afterEntries.filter((e) => entryDate(startDate, e) < cutoffDate);
  if (!deepEqual(beforePre, afterPre)) {
    v.push(
      `Pre-cutoff entries changed: ${beforePre.length} before vs ${afterPre.length} after (or contents differ)`
    );
  }
  if (!deepEqual(beforePre, after.keptEntries)) {
    v.push("keptEntries differ from the pre-cutoff entries of the old plan");
  }
  if (after.keptEntries.length + after.removedEntries.length !== beforeEntries.length) {
    v.push(
      `kept (${after.keptEntries.length}) + removed (${after.removedEntries.length}) != old entry count (${beforeEntries.length})`
    );
  }
  // Week-level notes of weeks that begin before the cutoff are unchanged.
  for (const w of before) {
    if (weekMondayIso(startDate, w.weekNumber) >= cutoffDate) continue;
    const next = after.weeks.find((x) => x.weekNumber === w.weekNumber);
    if (!next || !deepEqual(w.notes, next.notes)) {
      v.push(`Week ${w.weekNumber} begins before the cutoff but its notes changed`);
    }
  }

  // 2. Weeks 1..N exist and weekIndex = weekNumber - 1.
  const numbers = after.weeks.map((w) => w.weekNumber);
  const wanted = Array.from({ length: expectedWeekCount }, (_, i) => i + 1);
  if (!deepEqual(numbers, wanted)) {
    v.push(`Week numbers are [${numbers.join(",")}], expected 1..${expectedWeekCount} in order`);
  }
  for (const w of after.weeks) {
    for (const e of w.entries) {
      if (e.weekIndex !== w.weekNumber - 1) {
        v.push(`Entry ${e.id} in week ${w.weekNumber} has weekIndex ${e.weekIndex}`);
      }
    }
  }

  // 3. Every spec's computed date equals its stated date.
  if (specs) {
    const sorted = [...specs].sort((a, b) => a.date.localeCompare(b.date));
    sorted.forEach((spec, i) => {
      const computed = plannedEntryIsoDate(startDate, spec.weekNumber - 1, spec.weekday);
      if (computed !== spec.date) v.push(`Spec ${spec.date} computes to ${computed}`);
      const entry = after.addedEntries[i];
      if (!entry || entryDate(startDate, entry) !== spec.date) {
        v.push(`Added entry ${i} does not land on spec date ${spec.date}`);
      }
    });
  }

  // 4. No duplicate ids; no duplicate dates among new entries or against kept ones.
  const idSeen = new Set<string>();
  for (const e of afterEntries) {
    if (idSeen.has(e.id)) v.push(`Duplicate entry id ${e.id}`);
    idSeen.add(e.id);
  }
  const dateSeen = new Set<string>(after.keptEntries.map((e) => entryDate(startDate, e)));
  for (const e of after.addedEntries) {
    const d = entryDate(startDate, e);
    if (dateSeen.has(d)) v.push(`Duplicate date ${d}`);
    dateSeen.add(d);
  }

  // 5. New-entry count.
  if (after.addedEntries.length !== expectedNewEntryCount) {
    v.push(`Expected ${expectedNewEntryCount} new entries, got ${after.addedEntries.length}`);
  }

  // 6. New-entry miles per week.
  const actualMiles: Record<number, number> = {};
  for (const e of after.addedEntries) {
    const wk = e.weekIndex + 1;
    actualMiles[wk] = (actualMiles[wk] ?? 0) + e.distanceMiles;
  }
  for (const wk of new Set([
    ...Object.keys(expectedWeeklyNewMiles).map(Number),
    ...Object.keys(actualMiles).map(Number),
  ])) {
    const want = expectedWeeklyNewMiles[wk];
    const got = actualMiles[wk];
    if (want === undefined || got === undefined || Math.abs(want - got) > 1e-6) {
      v.push(`Week ${wk} new miles: expected ${want ?? "none"}, got ${got ?? "none"}`);
    }
  }

  // 7. No runType outside PlanRunType (all entries, kept included).
  for (const e of afterEntries) {
    if (e.runType !== undefined && !VALID_RUN_TYPES.includes(e.runType)) {
      v.push(`Entry ${e.id} has invalid runType ${JSON.stringify(e.runType)}`);
    }
  }

  // 8. The final entry is the race.
  const last = [...afterEntries].sort((a, b) =>
    entryDate(startDate, a).localeCompare(entryDate(startDate, b))
  ).at(-1);
  if (
    !last ||
    entryDate(startDate, last) !== finalRace.date ||
    last.workoutType !== "race" ||
    last.distanceMiles !== finalRace.distanceMiles
  ) {
    v.push(
      `Final entry must be ${finalRace.date} workoutType "race" ${finalRace.distanceMiles} mi; found ` +
        (last
          ? `${entryDate(startDate, last)} ${String(last.workoutType)} ${last.distanceMiles} mi`
          : "none")
    );
  }

  return v;
}
