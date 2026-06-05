/**
 * Pure, render-free logic for the shared single-week-paginated plan editor
 * (src/components/PlanEditor.tsx). Extracting these keeps the orchestration
 * unit-testable without mounting React, and lets both the running and workout
 * plan flows share one implementation.
 *
 * Nothing here touches Firestore or React — callers own persistence.
 */

import type { PlannedWorkoutEntry } from "@/types/plan";

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
