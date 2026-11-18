/**
 * Pure merge helpers for editing an EXISTING running-plan entry (no React, no
 * Firestore).
 *
 * Why this exists: the inline `EntryForm` in `RunningPlanDetail.tsx` only
 * exposes some fields (distance, pace text, run type, description, notes, HR,
 * time). It used to build a brand-new entry object from those fields alone, and
 * `PlanEditor.saveEntry` replaced the stored entry wholesale — so every save
 * silently dropped `workoutType`, `targetPaceSecondsPerMile` and any other
 * field the form doesn't show. `mergeEditedEntry` applies only the edited
 * fields onto the existing entry so nothing else is lost.
 */

import type { PlannedRunEntry } from "@/types/plan";
import { parsePaceString } from "@/utils/pace";

/** Fields `EntryForm` lets the user edit (exactly the form's inputs). */
export type PlannedRunEntryEdits = Partial<
  Pick<
    PlannedRunEntry,
    | "distanceMiles"
    | "paceTarget"
    | "runType"
    | "description"
    | "notes"
    | "targetHeartRate"
    | "scheduledTime"
  >
>;

/**
 * First `m:ss` token in a free-text pace string, as seconds per mile:
 * "10:30+" -> 630, "10:30+ / 9:30" -> 630, "8:50-9:10" -> 530. Returns null for
 * empty text or text with no valid token ("race effort"). Reuses
 * `parsePaceString` for the actual m:ss validation.
 */
export function extractLeadingPaceSeconds(paceText: string): number | null {
  const match = paceText.match(/(?<!\d)(\d{1,2}:\d{2})(?!\d)/);
  if (!match) return null;
  return parsePaceString(match[1]);
}

/**
 * Midpoint (seconds/mile) of a range "m:ss-m:ss" — the convention the stored
 * range entries already use (e.g. "8:50-9:10" -> 540). Whitespace around the
 * dash is allowed and the order of the two ends does not matter. Returns null
 * for anything that is not exactly two valid m:ss values joined by a dash
 * ("10:30+", "10:30+ / 9:30", "9:10", "race effort").
 */
export function parsePaceRangeMidpoint(paceText: string): number | null {
  const match = paceText.trim().match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!match) return null;
  const a = parsePaceString(match[1]);
  const b = parsePaceString(match[2]);
  if (a == null || b == null) return null;
  return Math.round((a + b) / 2);
}

/**
 * Resolve a pace string to seconds/mile. Order: strict m:ss, then range
 * midpoint, then leading m:ss token; null if none apply.
 */
function paceSecondsFor(paceText: string | undefined): number | null {
  if (!paceText) return null;
  return (
    parsePaceString(paceText) ??
    parsePaceRangeMidpoint(paceText) ??
    extractLeadingPaceSeconds(paceText)
  );
}

/**
 * Merge `edits` onto `existing`. Every field not named in `edits` is preserved
 * (id, weekIndex, weekday, dayOfWeek, workoutType, targetPaceSecondsPerMile,
 * ...). A key present in `edits` with value `undefined` clears that field.
 *
 * Pace sync: `paceTarget` (text) and `targetPaceSecondsPerMile` (number) are a
 * companion pair and the number wins everywhere it is read. If `paceTarget` is
 * not edited or is unchanged, the stored seconds are kept. If it changed, the
 * seconds are re-derived with `parsePaceString`, then the range midpoint
 * ("8:50-9:10" -> 540), then the leading m:ss token; if none resolves,
 * `targetPaceSecondsPerMile` is removed (never left stale, never 0/NaN).
 *
 * Pure: returns a new object, never mutates `existing`.
 */
export function mergeEditedEntry(
  existing: PlannedRunEntry,
  edits: PlannedRunEntryEdits
): PlannedRunEntry {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(edits)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }

  if ("paceTarget" in edits && edits.paceTarget !== existing.paceTarget) {
    const seconds = paceSecondsFor(edits.paceTarget);
    if (seconds != null) merged.targetPaceSecondsPerMile = seconds;
    else delete merged.targetPaceSecondsPerMile;
  }

  return merged as unknown as PlannedRunEntry;
}
