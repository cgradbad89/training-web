/**
 * Tests + env-gated runner for scripts/backfillHrTargets20261118.ts.
 *
 * The data-integrity test below always runs (no Firestore). The two runners are
 * SKIPPED unless HR_BACKFILL is set, so `npm test` never touches Firestore:
 *
 *   Dry-run (writes nothing):  npm run plan:backfill-hr:dry     (HR_BACKFILL=dry)
 *   Commit (writes the plan):  npm run plan:backfill-hr:commit  (HR_BACKFILL=commit)
 */
import { describe, it, expect } from "vitest";
import type { PlannedRunEntry, PlanWeek } from "../src/types/plan";
import { buildReplacedWeeks } from "../src/utils/planReplace";
import {
  EXPECTED_FRESH_COUNTS,
  EXPECTED_TARGET_DISTRIBUTION,
  HR_BACKFILL_CUTOFF_DATE,
  planHrBackfill,
  validateHrBackfill,
} from "../src/utils/hrTargetBackfill";
import {
  NEW_ENTRY_SPECS,
  WEEK_NOTES,
  EXPECTED_START_DATE as REPLACE_START_DATE,
  CUTOFF_DATE as REPLACE_CUTOFF_DATE,
} from "./replaceRnrPlanFrom20261118";
import {
  EXPECTED_PLAN_ID,
  EXPECTED_START_DATE,
  PLAN_NAME,
  TARGET_UID,
  runBackfillHrTargets,
} from "./backfillHrTargets20261118";

// ─── Data integrity (no Firestore) ───────────────────────────────────────────

function syntheticOldWeeks(): PlanWeek[] {
  const e = (id: string, weekIndex: number, weekday: number): PlannedRunEntry => ({
    id, weekIndex, weekday, dayOfWeek: weekday - 1, distanceMiles: 4,
    runType: "outdoor", workoutType: "easy", paceTarget: "10:30", targetPaceSecondsPerMile: 630, targetHeartRate: null,
  });
  return Array.from({ length: 25 }, (_, i) => ({
    weekNumber: i + 1,
    entries: [e(`old-${i}-1`, i, 1), e(`old-${i}-2`, i, 2), e(`old-${i}-5`, i, 5), e(`old-${i}-6`, i, 6)],
    notes: `old note ${i + 1}`,
  }));
}

describe("HR backfill against the real Rock and Roll replacement specs", () => {
  it("pins the plan identity constants", () => {
    expect(TARGET_UID).toBe("eR9gJQK1eBflP9syhPRtPbiF6Kh2");
    expect(PLAN_NAME).toBe("Rock and Roll 1/2 Marathon");
    expect(EXPECTED_PLAN_ID).toBe("e1296747-78fc-48a7-b5de-da12f2bbb1e2");
    expect(EXPECTED_START_DATE).toBe(REPLACE_START_DATE);
    expect(HR_BACKFILL_CUTOFF_DATE).toBe(REPLACE_CUTOFF_DATE);
  });

  it("classifies the 62 replacement entries into the exact approved counts", () => {
    const before = buildReplacedWeeks(
      syntheticOldWeeks(),
      EXPECTED_START_DATE,
      HR_BACKFILL_CUTOFF_DATE,
      NEW_ENTRY_SPECS,
      WEEK_NOTES,
      (() => {
        let n = 0;
        return () => `id-${++n}`;
      })()
    ).weeks;
    const plan = planHrBackfill(before, EXPECTED_START_DATE, HR_BACKFILL_CUTOFF_DATE);
    const v = validateHrBackfill(before, plan, EXPECTED_START_DATE, HR_BACKFILL_CUTOFF_DATE);
    expect(v.violations).toEqual([]);
    expect(v.state).toBe("fresh");
    expect(v.counts).toEqual(EXPECTED_FRESH_COUNTS);
    expect(v.distribution).toEqual(EXPECTED_TARGET_DISTRIBUTION);
    expect(plan.rows).toHaveLength(62);
  });
});

// ─── Env-gated Firestore runners ─────────────────────────────────────────────

const MODE = process.env.HR_BACKFILL;

it.skipIf(MODE !== "dry")(
  "DRY-RUN: print the per-entry table, counts and validation (writes nothing)",
  async () => {
    const res = await runBackfillHrTargets({ commit: false });
    expect(res.committed).toBe(false);
  },
  120_000
);

it.skipIf(MODE !== "commit")(
  "COMMIT: back up, write targetHr for entries from 2026-11-18, read back",
  async () => {
    const res = await runBackfillHrTargets({ commit: true });
    expect(["fresh", "applied"]).toContain(res.state);
  },
  120_000
);
