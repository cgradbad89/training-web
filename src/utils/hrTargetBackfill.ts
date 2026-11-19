/**
 * Pure logic for the one-off HR-target backfill of the active "Rock and Roll
 * 1/2 Marathon" plan (no Firestore, no React, no IO — the admin script
 * `scripts/backfillHrTargets20261118.ts` owns reads/writes).
 *
 * For every entry dated on/after the cutoff:
 *   - a valid `targetHr` already present      → "already-set" (untouched);
 *   - a legacy plain cap `targetHeartRate`    → "legacy-cap": `targetHr = {null, cap}`,
 *                                               legacy field unchanged;
 *   - notes "HR 146-155 bpm" (no legacy cap)  → "notes-range": `targetHr = {min, max}`,
 *                                               legacy stays null;
 *   - notes "HR <135 / 145-155 bpm"           → "split-skip": NO structured target
 *                                               (split long runs: a whole-run average
 *                                               matches neither half);
 *   - anything else (no HR prefix)            → "no-target".
 * `notes` is never modified. Entries before the cutoff are returned untouched.
 * Any unrecognized "HR …" note THROWS (strict parser) so nothing is mis-read.
 */

import type { PlanWeek, PlannedRunEntry, TargetHeartRate } from "@/types/plan";
import {
  isValidHrTarget,
  parseHrTargetFromNotes,
  resolveHrTarget,
} from "@/utils/hrTarget";
import { deepEqual, plannedEntryIsoDate } from "@/utils/planReplace";

export type HrBackfillReason =
  | "legacy-cap"
  | "notes-range"
  | "split-skip"
  | "no-target"
  | "already-set";

export interface HrBackfillPlanRow {
  date: string;
  entryId: string;
  workoutType: string | undefined;
  before: {
    targetHeartRate: number | null | undefined;
    notes: string | undefined;
  };
  after: TargetHeartRate | null;
  reason: HrBackfillReason;
}

export interface HrBackfillPlan {
  weeks: PlanWeek[];
  rows: HrBackfillPlanRow[];
}

/** Classify one in-scope entry and return its (possibly updated) copy. */
function backfillEntry(entry: PlannedRunEntry): {
  entry: PlannedRunEntry;
  after: TargetHeartRate | null;
  reason: HrBackfillReason;
} {
  if (isValidHrTarget(entry.targetHr)) {
    return { entry, after: entry.targetHr, reason: "already-set" };
  }

  // Legacy plain cap (ignores any invalid `targetHr`).
  const legacy = resolveHrTarget({
    targetHr: null,
    targetHeartRate: entry.targetHeartRate,
  });
  if (legacy) {
    return {
      entry: { ...entry, targetHr: legacy },
      after: legacy,
      reason: "legacy-cap",
    };
  }

  const parsed = parseHrTargetFromNotes(entry.notes);
  if (parsed?.kind === "range") {
    return {
      entry: { ...entry, targetHr: parsed.target },
      after: parsed.target,
      reason: "notes-range",
    };
  }
  if (parsed?.kind === "split") {
    return { entry, after: null, reason: "split-skip" };
  }
  return { entry, after: null, reason: "no-target" };
}

/**
 * Plan the backfill over `weeks` (does not mutate its input). Entries dated
 * before `cutoffDate` (YYYY-MM-DD) are returned as the SAME objects. Rows are
 * sorted by date, in-scope entries only.
 */
export function planHrBackfill(
  weeks: PlanWeek[],
  startDate: string,
  cutoffDate: string
): HrBackfillPlan {
  const rows: HrBackfillPlanRow[] = [];
  const nextWeeks = weeks.map((week) => ({
    ...week,
    entries: week.entries.map((entry) => {
      const date = plannedEntryIsoDate(startDate, entry.weekIndex, entry.weekday);
      if (date < cutoffDate) return entry;
      const result = backfillEntry(entry);
      rows.push({
        date,
        entryId: entry.id,
        workoutType: entry.workoutType,
        before: { targetHeartRate: entry.targetHeartRate, notes: entry.notes },
        after: result.after,
        reason: result.reason,
      });
      return result.entry;
    }),
  }));
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { weeks: nextWeeks, rows };
}

// ─── Validation (exact owner-approved counts) ────────────────────────────────

export const HR_BACKFILL_CUTOFF_DATE = "2026-11-18";

/** Reason counts for the live plan BEFORE the backfill has been applied. */
export const EXPECTED_FRESH_COUNTS: Record<HrBackfillReason, number> = {
  "legacy-cap": 40, // 39 at 135, 1 at 160
  "notes-range": 16, // 8 × 146–155, 6 × 155–165, 2 × 145–155
  "split-skip": 5,
  "no-target": 1, // Turkey Trot
  "already-set": 0,
};

/** Reason counts once the backfill has been applied (idempotent re-run). */
export const EXPECTED_APPLIED_COUNTS: Record<HrBackfillReason, number> = {
  "legacy-cap": 0,
  "notes-range": 0,
  "split-skip": 5,
  "no-target": 1,
  "already-set": 56,
};

/** The resulting targets by `minBpm-maxBpm` key ("-135" = cap 135). */
export const EXPECTED_TARGET_DISTRIBUTION: Record<string, number> = {
  "-135": 39,
  "-160": 1,
  "146-155": 8,
  "155-165": 6,
  "145-155": 2,
};

export const EXPECTED_IN_SCOPE_ENTRIES = 62;

export type HrBackfillState = "fresh" | "applied" | "unexpected";

export interface HrBackfillValidation {
  state: HrBackfillState;
  counts: Record<HrBackfillReason, number>;
  distribution: Record<string, number>;
  violations: string[];
}

function targetKey(t: TargetHeartRate): string {
  return `${t.minBpm ?? ""}-${t.maxBpm ?? ""}`;
}

function sameCounts(
  a: Record<HrBackfillReason, number>,
  b: Record<HrBackfillReason, number>
): boolean {
  return (Object.keys(b) as HrBackfillReason[]).every((k) => a[k] === b[k]);
}

function withoutTargetHr(entry: PlannedRunEntry): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...entry };
  delete copy.targetHr;
  return copy;
}

/**
 * Check a backfill plan against the exact approved shape. Pre-cutoff entries
 * must be deep-equal; every in-scope entry must differ at most by `targetHr`
 * (so `notes`, the legacy cap and every other field are unchanged); the reason
 * counts must equal either the FRESH or the already-APPLIED expectation; and
 * the resulting target distribution must match.
 */
export function validateHrBackfill(
  before: PlanWeek[],
  plan: HrBackfillPlan,
  startDate: string,
  cutoffDate: string
): HrBackfillValidation {
  const violations: string[] = [];
  const counts: Record<HrBackfillReason, number> = {
    "legacy-cap": 0,
    "notes-range": 0,
    "split-skip": 0,
    "no-target": 0,
    "already-set": 0,
  };
  for (const row of plan.rows) counts[row.reason] += 1;

  const distribution: Record<string, number> = {};
  for (const row of plan.rows) {
    if (row.after) {
      const k = targetKey(row.after);
      distribution[k] = (distribution[k] ?? 0) + 1;
    }
  }

  // Structure: same weeks, same week-level fields, same entry ids in order.
  if (before.length !== plan.weeks.length) {
    violations.push(`week count changed: ${before.length} -> ${plan.weeks.length}`);
  } else {
    before.forEach((week, wi) => {
      const next = plan.weeks[wi];
      const { entries: be, ...bRest } = week;
      const { entries: ne, ...nRest } = next;
      if (!deepEqual(bRest, nRest)) violations.push(`week ${week.weekNumber}: week-level fields changed`);
      if (be.length !== ne.length || be.some((e, i) => e.id !== ne[i].id)) {
        violations.push(`week ${week.weekNumber}: entry ids/order changed`);
        return;
      }
      be.forEach((e, i) => {
        const date = plannedEntryIsoDate(startDate, e.weekIndex, e.weekday);
        if (date < cutoffDate) {
          if (!deepEqual(e, ne[i])) violations.push(`pre-cutoff entry ${e.id} (${date}) changed`);
        } else if (!deepEqual(withoutTargetHr(e), withoutTargetHr(ne[i]))) {
          violations.push(`entry ${e.id} (${date}) changed beyond targetHr`);
        }
      });
    });
  }

  if (plan.rows.length !== EXPECTED_IN_SCOPE_ENTRIES) {
    violations.push(
      `expected ${EXPECTED_IN_SCOPE_ENTRIES} entries dated >= ${cutoffDate}, found ${plan.rows.length}`
    );
  }

  let state: HrBackfillState = "unexpected";
  if (sameCounts(counts, EXPECTED_FRESH_COUNTS)) state = "fresh";
  else if (sameCounts(counts, EXPECTED_APPLIED_COUNTS)) state = "applied";
  else {
    violations.push(
      `reason counts ${JSON.stringify(counts)} match neither the fresh ${JSON.stringify(
        EXPECTED_FRESH_COUNTS
      )} nor the applied ${JSON.stringify(EXPECTED_APPLIED_COUNTS)} expectation`
    );
  }

  if (!deepEqual(distribution, EXPECTED_TARGET_DISTRIBUTION)) {
    violations.push(
      `resulting target distribution ${JSON.stringify(distribution)} != expected ${JSON.stringify(
        EXPECTED_TARGET_DISTRIBUTION
      )}`
    );
  }

  for (const row of plan.rows) {
    if (row.reason === "legacy-cap") {
      if (row.after?.minBpm !== null || row.after?.maxBpm !== row.before.targetHeartRate) {
        violations.push(`${row.date}: legacy-cap target does not mirror the legacy field`);
      }
    }
    if (row.reason === "notes-range" && row.before.targetHeartRate != null) {
      violations.push(`${row.date}: notes-range entry unexpectedly has a legacy cap`);
    }
  }

  return { state, counts, distribution, violations };
}
