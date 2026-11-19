/**
 * Heart-rate TARGET helpers for running-plan entries (pure — no React, no
 * Firestore, no reads).
 *
 * Targets are ABSOLUTE bpm and independent of the %-of-HR-reserve zones in
 * `zones.ts` (a 135 cap falls mid-Z2 at 175/65 — expected). Only the run-level
 * `avgHeartRate` is reliable for every run, so entries are judged on the
 * ROUNDED whole-run average; workouts (warm-up + reps + cool-down) therefore
 * compare the whole-run average too.
 *
 * Owner-approved grace (2026-11-18): `HR_TARGET_GRACE_BPM = 2`. A cap of 135 is
 * on target up to an average of 137 inclusive and over at 138+; a range of
 * 146–155 is on target for averages 144–157 inclusive, over above that and
 * under-range below.
 *
 * Storage: `PlannedRunEntry.targetHr` (structured). The legacy plain-cap field
 * `targetHeartRate` is read as a fallback by `resolveHrTarget` and dual-written
 * for cap-only targets by `toLegacyTargetHeartRate`.
 */

import type { PlannedRunEntry, TargetHeartRate } from "@/types/plan";

/** bpm of slack past a bound before a run counts as off target. */
export const HR_TARGET_GRACE_BPM = 2;

/** Plausible bpm range for a stored target bound (inclusive). */
const MIN_TARGET_BPM = 40;
const MAX_TARGET_BPM = 220;

export interface HrTargetResult {
  kind: "cap" | "range" | "floor";
  status: "on-target" | "over" | "under-range" | "no-data";
  /** Math.round(avg), as displayed. */
  avgBpm: number | null;
  /** Signed distance to the violated or nearest bound: +2 = 2 above max,
   *  -3 = 3 below min, 0 = inside; null when there is no data. Still computed
   *  within grace (137 vs a 135 cap → on-target, +2). */
  deltaBpm: number | null;
}

/** The slice of a matched run the week counters need. */
export interface HrMatchInput {
  avgHeartRate: number | null | undefined;
}

export interface WeekHrCounters {
  /** workoutType easy|long with a cap-only target. */
  easyUnderCap: { met: number; total: number };
  /** workoutType tempo with a min+max target. */
  workoutsInRange: { met: number; total: number };
}

export type ParsedHrNote =
  /** "HR 146-155 bpm" → a structured range. */
  | { kind: "range"; target: TargetHeartRate }
  /** "HR <135 / 145-155 bpm" (split long run) → deliberately NO structured target. */
  | { kind: "split" }
  /** No "HR " prefix in the notes. */
  | null;

function isBound(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v) &&
    v >= MIN_TARGET_BPM &&
    v <= MAX_TARGET_BPM
  );
}

/** At least one bound, each bound a finite 40–220, and min ≤ max when both. */
export function isValidHrTarget(
  t: TargetHeartRate | null | undefined
): t is TargetHeartRate {
  if (t == null || typeof t !== "object") return false;
  const { minBpm, maxBpm } = t;
  if (minBpm == null && maxBpm == null) return false;
  if (minBpm != null && !isBound(minBpm)) return false;
  if (maxBpm != null && !isBound(maxBpm)) return false;
  if (minBpm != null && maxBpm != null && minBpm > maxBpm) return false;
  return true;
}

/**
 * The entry's effective HR target: a valid `targetHr` wins; otherwise the
 * legacy plain cap `{ minBpm: null, maxBpm: targetHeartRate }` when it is a
 * usable number; otherwise null. An invalid `targetHr` falls back to legacy.
 */
export function resolveHrTarget(
  entry: Pick<PlannedRunEntry, "targetHr" | "targetHeartRate">
): TargetHeartRate | null {
  if (isValidHrTarget(entry.targetHr)) return entry.targetHr;
  const legacy = entry.targetHeartRate;
  if (typeof legacy === "number") {
    const cap: TargetHeartRate = { minBpm: null, maxBpm: legacy };
    if (isValidHrTarget(cap)) return cap;
  }
  return null;
}

function kindOf(t: TargetHeartRate): HrTargetResult["kind"] {
  if (t.minBpm == null) return "cap";
  if (t.maxBpm == null) return "floor";
  return "range";
}

/** "≤ 135" (cap), "146–155" (range), "≥ 140" (floor). */
export function formatHrTarget(t: TargetHeartRate): string {
  const kind = kindOf(t);
  if (kind === "cap") return `≤ ${t.maxBpm}`;
  if (kind === "floor") return `≥ ${t.minBpm}`;
  return `${t.minBpm}–${t.maxBpm}`;
}

function usableAvg(avg: number | null | undefined): number | null {
  if (typeof avg !== "number" || !Number.isFinite(avg) || avg <= 0) return null;
  return Math.round(avg);
}

/**
 * Judge a run's (rounded) average HR against a target.
 *  - above max by more than the grace → "over";
 *  - below min by more than the grace → "under-range";
 *  - otherwise "on-target".
 * `deltaBpm` is the signed distance to the violated bound (0 inside the bounds);
 * it is still reported within grace.
 */
export function evaluateHrTarget(
  target: TargetHeartRate,
  avgHr: number | null | undefined,
  graceBpm: number = HR_TARGET_GRACE_BPM
): HrTargetResult {
  const kind = kindOf(target);
  const avg = usableAvg(avgHr);
  if (avg == null) {
    return { kind, status: "no-data", avgBpm: null, deltaBpm: null };
  }
  if (target.maxBpm != null && avg > target.maxBpm) {
    const delta = avg - target.maxBpm;
    return {
      kind,
      status: delta > graceBpm ? "over" : "on-target",
      avgBpm: avg,
      deltaBpm: delta,
    };
  }
  if (target.minBpm != null && avg < target.minBpm) {
    const delta = avg - target.minBpm;
    return {
      kind,
      status: -delta > graceBpm ? "under-range" : "on-target",
      avgBpm: avg,
      deltaBpm: delta,
    };
  }
  return { kind, status: "on-target", avgBpm: avg, deltaBpm: 0 };
}

/**
 * Per-mile flag: true when the mile's (rounded) average HR is above the
 * target's max by more than the grace. A target without a max (floor) can never
 * be "over". null = no usable mile HR.
 */
export function isMileOverTarget(
  target: TargetHeartRate,
  mileAvgBpm: number | null | undefined,
  graceBpm: number = HR_TARGET_GRACE_BPM
): boolean | null {
  const avg = usableAvg(mileAvgBpm);
  if (avg == null) return null;
  if (target.maxBpm == null) return false;
  return avg - target.maxBpm > graceBpm;
}

/**
 * Week counters over COMPLETED entries (the caller returns a match input only
 * for a matched entry — full or partial both count) that have a resolved target
 * AND a usable actual average HR.
 *  - easyUnderCap: workoutType easy|long with a cap-only target.
 *  - workoutsInRange: workoutType tempo with a min+max target.
 * Races, rest days, split long runs (no structured target), unmatched entries
 * and matches without an average HR are excluded.
 */
export function computeWeekHrCounters(
  entries: PlannedRunEntry[],
  matchFor: (entryId: string) => HrMatchInput | null
): WeekHrCounters {
  const counters: WeekHrCounters = {
    easyUnderCap: { met: 0, total: 0 },
    workoutsInRange: { met: 0, total: 0 },
  };
  for (const entry of entries) {
    if (entry.runType === "rest") continue;
    const target = resolveHrTarget(entry);
    if (!target) continue;
    const match = matchFor(entry.id);
    if (!match) continue;
    const result = evaluateHrTarget(target, match.avgHeartRate);
    if (result.status === "no-data") continue;

    const kind = result.kind;
    let bucket: { met: number; total: number } | null = null;
    if ((entry.workoutType === "easy" || entry.workoutType === "long") && kind === "cap") {
      bucket = counters.easyUnderCap;
    } else if (entry.workoutType === "tempo" && kind === "range") {
      bucket = counters.workoutsInRange;
    }
    if (!bucket) continue;
    bucket.total += 1;
    if (result.status === "on-target") bucket.met += 1;
  }
  return counters;
}

const RANGE_NOTE = /^HR (\d{2,3})-(\d{2,3}) bpm/;
const SPLIT_NOTE = /^HR <\d{2,3} \/ \d{2,3}-\d{2,3} bpm/;

/**
 * Parse an HR prefix out of an entry's free-text notes. STRICT: notes that do
 * not start with "HR " → null; "HR 146-155 bpm…" → range; "HR <135 / 145-155
 * bpm…" → split (no structured target); any other "HR …" text THROWS so a
 * backfill can never silently mis-read a note.
 */
export function parseHrTargetFromNotes(
  notes: string | null | undefined
): ParsedHrNote {
  if (notes == null) return null;
  const text = notes.trimStart();
  if (!text.startsWith("HR ")) return null;

  if (SPLIT_NOTE.test(text)) return { kind: "split" };

  const range = RANGE_NOTE.exec(text);
  if (range) {
    const target: TargetHeartRate = {
      minBpm: Number(range[1]),
      maxBpm: Number(range[2]),
    };
    if (!isValidHrTarget(target)) {
      throw new Error(`HR range in notes is not a valid target: "${text.slice(0, 60)}"`);
    }
    return { kind: "range", target };
  }

  throw new Error(`Unrecognized HR note (expected a whitelisted form): "${text.slice(0, 60)}"`);
}

/** The legacy plain-cap value for a target: maxBpm only for a cap (no min); else null. */
export function toLegacyTargetHeartRate(
  t: TargetHeartRate | null | undefined
): number | null {
  if (!t) return null;
  return t.minBpm == null && t.maxBpm != null ? t.maxBpm : null;
}

export const HR_TARGET_INPUT_ERROR =
  "Enter whole-number bpm between 40 and 220; min can't exceed max.";

/**
 * Parse the two EntryForm text inputs ("HR min", "HR max") into a target.
 * Both blank → `{ target: null, error: null }` (no target). A blank min with a
 * max is a cap; a blank max with a min is a floor; both is a range. Anything
 * non-numeric, fractional or failing `isValidHrTarget` returns an `error`.
 */
export function parseHrTargetInputs(
  minText: string,
  maxText: string
): { target: TargetHeartRate | null; error: string | null } {
  const parse = (text: string): number | null | "bad" => {
    const t = text.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isInteger(n) ? n : "bad";
  };
  const minBpm = parse(minText);
  const maxBpm = parse(maxText);
  if (minBpm === "bad" || maxBpm === "bad") {
    return { target: null, error: HR_TARGET_INPUT_ERROR };
  }
  if (minBpm == null && maxBpm == null) return { target: null, error: null };
  const target: TargetHeartRate = { minBpm, maxBpm };
  if (!isValidHrTarget(target)) return { target: null, error: HR_TARGET_INPUT_ERROR };
  return { target, error: null };
}
