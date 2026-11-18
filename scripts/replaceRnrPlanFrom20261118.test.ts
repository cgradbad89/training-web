/**
 * Tests + env-gated runner for scripts/replaceRnrPlanFrom20261118.ts.
 *
 * The data-integrity tests below always run (no Firestore). The two runners are
 * SKIPPED unless RNR_REPLACE is set, so `npm test` never touches Firestore:
 *
 *   Dry-run (writes nothing):  npm run plan:replace-rnr:dry     (RNR_REPLACE=dry)
 *   Commit (writes the plan):  npm run plan:replace-rnr:commit  (RNR_REPLACE=commit)
 */
import { describe, it, expect } from "vitest";
import type { PlannedRunEntry, PlanWeek } from "../src/types/plan";
import {
  buildReplacedWeeks,
  validateReplacedWeeks,
  plannedEntryIsoDate,
} from "../src/utils/planReplace";
import {
  computePlanEasyPaceBaseline,
  planEntryToSyntheticEffort,
} from "../src/utils/riegelFit";
import {
  NEW_ENTRY_SPECS,
  WEEK_NOTES,
  EXPECTED_WEEKLY_NEW_MILES,
  EXPECTED_START_DATE,
  CUTOFF_DATE,
  inferDayOfWeekConvention,
  runReplaceRnrPlan,
} from "./replaceRnrPlanFrom20261118";

// ─── Data integrity (no Firestore) ───────────────────────────────────────────

function syntheticOldWeeks(): PlanWeek[] {
  const e = (id: string, weekIndex: number, weekday: number): PlannedRunEntry => ({
    id, weekIndex, weekday, dayOfWeek: weekday - 1, distanceMiles: 4,
    runType: "outdoor", workoutType: "easy", paceTarget: "10:30", targetPaceSecondsPerMile: 630, targetHeartRate: null,
  });
  return Array.from({ length: 25 }, (_, i) => ({
    weekNumber: i + 1,
    entries: [e(`old-${i}-1`, i, 1), e(`old-${i}-2`, i, 2), e(`old-${i}-5`, i, 5), e(`old-${i}-6`, i, 6)],
    notes: i + 1 === 8 ? "week 8 note" : `old note ${i + 1}`,
  }));
}

describe("Rock and Roll replacement data", () => {
  it("has 62 specs whose stated dates equal their computed dates, with no duplicates", () => {
    expect(NEW_ENTRY_SPECS).toHaveLength(62);
    for (const s of NEW_ENTRY_SPECS) {
      expect(plannedEntryIsoDate(EXPECTED_START_DATE, s.weekNumber - 1, s.weekday)).toBe(s.date);
    }
    expect(new Set(NEW_ENTRY_SPECS.map((s) => s.date)).size).toBe(62);
  });

  it("only uses outdoor/longRun and the allowed workoutTypes", () => {
    for (const s of NEW_ENTRY_SPECS) {
      expect(["outdoor", "longRun"]).toContain(s.runType);
      expect(["easy", "tempo", "long", "race"]).toContain(s.workoutType);
    }
  });

  it("omits targetPaceSecondsPerMile only for the Turkey Trot", () => {
    const unset = NEW_ENTRY_SPECS.filter((s) => s.targetPaceSecondsPerMile === undefined);
    expect(unset.map((s) => s.date)).toEqual(["2026-11-26"]);
    expect(unset[0].paceTarget).toBe("race effort");
  });

  it("spot-checks representative rows against the source table", () => {
    const by = (d: string) => NEW_ENTRY_SPECS.find((s) => s.date === d)!;
    expect(by("2027-02-01")).toMatchObject({ weekNumber: 19, weekday: 1, distanceMiles: 5, workoutType: "easy" });
    expect(by("2027-01-02")).toMatchObject({ paceTarget: "10:30+ / 9:30", targetPaceSecondsPerMile: 630, targetHeartRate: null, distanceMiles: 10 });
    expect(by("2026-12-31").notes).toBe("Moved off New Year's Day; HR cap 135");
    expect(by("2027-03-20")).toMatchObject({ runType: "longRun", workoutType: "race", distanceMiles: 13.1, targetPaceSecondsPerMile: 570, targetHeartRate: 160 });
    expect(by("2026-11-21").notes).toBeUndefined();
    expect(NEW_ENTRY_SPECS.filter((s) => s.paceTarget === "10:30+ / 9:30")).toHaveLength(5);
  });

  it("replaces a synthetic 25-week plan with zero violations", () => {
    const before = syntheticOldWeeks();
    let n = 0;
    const r = buildReplacedWeeks(before, EXPECTED_START_DATE, CUTOFF_DATE, NEW_ENTRY_SPECS, WEEK_NOTES, () => `id-${++n}`);
    expect(validateReplacedWeeks(before, r, EXPECTED_START_DATE, CUTOFF_DATE, EXPECTED_WEEKLY_NEW_MILES, { specs: NEW_ENTRY_SPECS })).toEqual([]);
    // Week 8 keeps its Mon/Tue entries and its notes; weeks 9-25 get the new notes.
    const w8 = r.weeks.find((w) => w.weekNumber === 8)!;
    expect(w8.entries.filter((e) => e.id.startsWith("old-")).map((e) => e.weekday)).toEqual([1, 2]);
    expect(w8.notes).toBe("week 8 note");
    expect(r.weeks.find((w) => w.weekNumber === 25)!.notes).toBe("Race week");
  });

  it("tiers the new entries as documented (baseline 630 s/mi)", () => {
    const before = syntheticOldWeeks();
    const r = buildReplacedWeeks(before, EXPECTED_START_DATE, CUTOFF_DATE, NEW_ENTRY_SPECS, WEEK_NOTES, () => crypto.randomUUID());
    const baseline = computePlanEasyPaceBaseline(r.weeks.flatMap((w) => w.entries));
    expect(baseline).toBe(630);
    const tiers = { PLANNED_QUALITY: 0, PLANNED: 0, dropped: 0 };
    for (const e of r.addedEntries) {
      const d = new Date(`${plannedEntryIsoDate(EXPECTED_START_DATE, e.weekIndex, e.weekday)}T12:00:00Z`);
      const eff = planEntryToSyntheticEffort(e, d, d, baseline);
      tiers[eff ? (eff.tier as "PLANNED_QUALITY" | "PLANNED") : "dropped"]++;
    }
    // 16 tempo sessions + the 13.1 race (570) are 30+ s/mi faster; the Turkey Trot has no pace.
    expect(tiers).toEqual({ PLANNED_QUALITY: 17, PLANNED: 44, dropped: 1 });
  });
});

describe("inferDayOfWeekConvention", () => {
  it("recognizes the conventions", () => {
    expect(inferDayOfWeekConvention([])).toBe("no entries");
    expect(inferDayOfWeekConvention([{ weekday: 1, dayOfWeek: 0 }, { weekday: 7, dayOfWeek: 6 }])).toBe("weekday-1 (0=Mon)");
    expect(inferDayOfWeekConvention([{ weekday: 1, dayOfWeek: 1 }])).toBe("weekday (1=Mon)");
    expect(inferDayOfWeekConvention([{ weekday: 1, dayOfWeek: 0 }, { weekday: 2, dayOfWeek: 2 }])).toBe("mixed/other");
  });
});

// ─── Env-gated Firestore runners ─────────────────────────────────────────────

const MODE = process.env.RNR_REPLACE;

it.skipIf(MODE !== "dry")(
  "DRY-RUN: print the live table, diff, validation and prediction check (writes nothing)",
  async () => {
    const res = await runReplaceRnrPlan({ commit: false });
    expect(res.committed).toBe(false);
  },
  120_000
);

it.skipIf(MODE !== "commit")(
  "COMMIT: back up the current weeks, replace entries from 2026-11-18, read back",
  async () => {
    const res = await runReplaceRnrPlan({ commit: true });
    expect(res.committed).toBe(true);
  },
  120_000
);
