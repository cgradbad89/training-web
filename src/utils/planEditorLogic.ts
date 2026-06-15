/**
 * Pure, render-free logic for the shared single-week-paginated plan editor
 * (src/components/PlanEditor.tsx). Extracting these keeps the orchestration
 * unit-testable without mounting React, and lets both the running and workout
 * plan flows share one implementation.
 *
 * Nothing here touches Firestore or React — callers own persistence.
 */

import type { PlannedWorkoutEntry, PlannedRunEntry } from "@/types/plan";

/** Minimal shape the generic helpers need: every plan entry knows its weekday. */
export interface WeekdayEntry {
  weekday: number;
}

// ─── Week pagination ──────────────────────────────────────────────────────────

/**
 * Clamp a desired week index to the valid range for a plan of `weekCount`
 * weeks. Empty plans clamp to 0. Used by the prev/next week pager so it can
 * never page below week 0 or past the last week.
 */
export function clampWeekIndex(index: number, weekCount: number): number {
  if (weekCount <= 0) return 0;
  return Math.max(0, Math.min(index, weekCount - 1));
}

/** Apply a paging delta (e.g. -1 / +1) and clamp to valid bounds. */
export function pageWeekIndex(
  current: number,
  delta: number,
  weekCount: number
): number {
  return clampWeekIndex(current + delta, weekCount);
}

// ─── Copy operations ──────────────────────────────────────────────────────────

/**
 * Build the full replacement entry list for a target week when copying an
 * entire source week onto it. Each source entry is deep-copied via the
 * type-specific `copyEntryToDay` (fresh ids, target weekIndex, weekday
 * preserved). The target week's previous entries are fully replaced.
 */
export function buildCopyWeekEntries<T extends WeekdayEntry>(
  sourceEntries: T[],
  targetWeekIndex: number,
  copyEntryToDay: (entry: T, targetWeekIndex: number, targetWeekday: number) => T
): T[] {
  return sourceEntries.map((e) => copyEntryToDay(e, targetWeekIndex, e.weekday));
}

/**
 * Build the replacement entry list for a target week when copying a single
 * day's entries onto a (week, weekday) slot. Existing non-rest entries on the
 * target weekday are dropped; rest placeholders and all other days are kept.
 * The copied entries are appended.
 */
export function buildCopyDayEntries<T extends WeekdayEntry>(
  targetWeekEntries: T[],
  sourceDayEntries: T[],
  targetWeekIndex: number,
  targetWeekday: number,
  copyEntryToDay: (entry: T, targetWeekIndex: number, targetWeekday: number) => T,
  isRest: (entry: T) => boolean
): T[] {
  const copied = sourceDayEntries.map((e) =>
    copyEntryToDay(e, targetWeekIndex, targetWeekday)
  );
  const kept = targetWeekEntries.filter(
    (e) => !(e.weekday === targetWeekday && !isRest(e))
  );
  return [...kept, ...copied];
}

// ─── Workout-specific config helpers ──────────────────────────────────────────

/** Factory for a blank workout session entry on a given weekday (1=Mon..7=Sun). */
export function makeNewWorkoutEntry(
  weekIndex: number,
  weekday: number
): PlannedWorkoutEntry {
  return {
    id: crypto.randomUUID(),
    weekIndex,
    weekday,
    dayOfWeek: weekday - 1,
    type: "workout",
    exercises: [],
  };
}

/** Per-week summary label for workout plans: a session count (empty when 0). */
export function workoutWeekSummaryLabel(entries: PlannedWorkoutEntry[]): string {
  const n = entries.filter((e) => e.type !== "rest").length;
  if (n === 0) return "";
  return `${n} session${n === 1 ? "" : "s"}`;
}

// ─── Running-specific config helpers ──────────────────────────────────────────

/**
 * Factory for a blank running entry on a given weekday (1=Mon..7=Sun).
 * Defaults: runType "outdoor", distanceMiles 0 (the editor's distance field
 * renders empty for a 0 default and blocks save until a positive distance).
 */
export function makeNewRunEntry(
  weekIndex: number,
  weekday: number
): PlannedRunEntry {
  return {
    id: crypto.randomUUID(),
    weekIndex,
    weekday,
    dayOfWeek: weekday - 1,
    runType: "outdoor",
    distanceMiles: 0,
  };
}

/**
 * Normalize an entry-form time input into the value stored on a
 * PlannedRunEntry.scheduledTime. A blank/whitespace-only input becomes
 * `undefined` so stripUndefined drops it on write (never an empty string);
 * a non-blank input is stored trimmed as the raw "HH:MM" string.
 */
export function normalizeScheduledTime(input: string): string | undefined {
  return input.trim() || undefined;
}

/** Per-week summary label for running plans: total planned miles (e.g. "20.5 mi"). */
export function runningWeekSummaryLabel(entries: PlannedRunEntry[]): string {
  const miles = entries
    .filter((e) => e.runType !== "rest")
    .reduce((s, e) => s + e.distanceMiles, 0);
  return `${miles.toFixed(1)} mi`;
}

/** Per-week completion summary for the running progress bar. */
export interface WeekCompletion {
  completedRuns: number;
  totalRuns: number;
  plannedMiles: number;
  actualMiles: number;
  /** Matched-vs-planned miles ratio, clamped to [0, 1]. */
  pct: number;
}

/**
 * Compute a running week's completion from its planned entries and a resolver
 * that returns the matched actual miles for an entry id (null = no match).
 * Mirrors the legacy WeekSummaryBar exactly — a run counts as completed when it
 * has a match; planned/actual mileage drive the percent. Pure (the caller pulls
 * matches from the existing matchPlanToActual map) — no new match logic.
 */
export function computeWeekCompletion(
  entries: PlannedRunEntry[],
  matchedMilesFor: (entryId: string) => number | null
): WeekCompletion {
  const runEntries = entries.filter((e) => e.runType !== "rest");
  const completed = runEntries.filter((e) => matchedMilesFor(e.id) != null);
  const plannedMiles = runEntries.reduce((s, e) => s + e.distanceMiles, 0);
  const actualMiles = completed.reduce(
    (s, e) => s + (matchedMilesFor(e.id) ?? 0),
    0
  );
  const pct = plannedMiles > 0 ? Math.min(actualMiles / plannedMiles, 1) : 0;
  return {
    completedRuns: completed.length,
    totalRuns: runEntries.length,
    plannedMiles,
    actualMiles,
    pct,
  };
}

// ─── Initial week resolution ──────────────────────────────────────────────────

/**
 * Resolve a plan editor's initial week index. An explicit `override` (e.g. a
 * calendar deep-link's target week) wins; otherwise fall back to `defaultWeek`
 * (the active-plan current-week landing). Always clamped to a valid index so an
 * out-of-range deep-link can't land off the plan.
 */
export function resolveInitialWeekIndex(
  override: number | undefined,
  defaultWeek: number,
  weekCount: number
): number {
  return clampWeekIndex(override ?? defaultWeek, weekCount);
}

// ─── Dirty-state lifecycle ────────────────────────────────────────────────────

/**
 * Run a real mutation and reflect it in a dirty flag: mark dirty before the
 * write, clear it once the write settles (success OR failure). Because plan
 * edits autosave immediately, "unsaved" is only ever the brief in-flight
 * window — never the whole edit-mode session. Cancelling an unchanged draft
 * never calls this, so the flag stays false (the bug this replaces).
 */
export async function runMutationWithDirty(
  persist: () => void | Promise<void>,
  setDirty: (value: boolean) => void
): Promise<void> {
  setDirty(true);
  try {
    await persist();
  } finally {
    setDirty(false);
  }
}
