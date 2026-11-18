import { describe, it, expect } from "vitest";
import type { PlannedRunEntry, PlanWeek } from "@/types/plan";
import {
  buildReplacedWeeks,
  validateReplacedWeeks,
  plannedEntryIsoDate,
  deepEqual,
  type NewPlanEntrySpec,
} from "@/utils/planReplace";

// Tiny plan: start Mon 2026-09-28; week 8 = 2026-11-16..22; cutoff Wed 2026-11-18.
const START = "2026-09-28";
const CUTOFF = "2026-11-18";

function old(id: string, weekIndex: number, weekday: number, miles = 3): PlannedRunEntry {
  return {
    id,
    weekIndex,
    weekday,
    dayOfWeek: weekday - 1,
    distanceMiles: miles,
    runType: "outdoor",
    workoutType: "easy",
    paceTarget: "10:30",
    targetPaceSecondsPerMile: 630,
    targetHeartRate: null,
  };
}

function oldWeeks(): PlanWeek[] {
  return [
    { weekNumber: 7, entries: [old("w7-a", 6, 2)], notes: "week 7 note" },
    {
      weekNumber: 8,
      entries: [old("w8-mon", 7, 1), old("w8-tue", 7, 2), old("w8-wed", 7, 3), old("w8-sat", 7, 6, 8)],
      notes: "week 8 note",
    },
    { weekNumber: 9, entries: [old("w9-a", 8, 1)], notes: "old w9" },
    { weekNumber: 10, entries: [old("w10-a", 9, 2)] },
  ];
}

function spec(date: string, weekNumber: number, weekday: number, extra: Partial<NewPlanEntrySpec> = {}): NewPlanEntrySpec {
  return {
    date,
    weekNumber,
    weekday,
    distanceMiles: 4,
    runType: "outdoor",
    workoutType: "easy",
    paceTarget: "10:30+",
    targetPaceSecondsPerMile: 630,
    targetHeartRate: 135,
    description: "4 miles easy",
    ...extra,
  };
}

let n = 0;
const newId = () => `new-${++n}`;

describe("plannedEntryIsoDate", () => {
  it("derives start + weekIndex*7 + (weekday-1)", () => {
    expect(plannedEntryIsoDate(START, 7, 1)).toBe("2026-11-16");
    expect(plannedEntryIsoDate(START, 24, 6)).toBe("2027-03-20");
  });
});

describe("buildReplacedWeeks", () => {
  it("keeps pre-cutoff entries deep-equal and handles a mid-week cutoff (week 8)", () => {
    const before = oldWeeks();
    const snapshot = JSON.parse(JSON.stringify(before));
    const r = buildReplacedWeeks(
      before, START, CUTOFF,
      [spec("2026-11-18", 8, 3), spec("2026-11-21", 8, 6, { distanceMiles: 9 })],
      {}, newId
    );
    const w8 = r.weeks.find((w) => w.weekNumber === 8)!;
    // Mon + Tue kept byte-identical, old Wed + Sat removed, 2 new added.
    expect(w8.entries.slice(0, 2)).toEqual(snapshot[1].entries.slice(0, 2));
    expect(r.keptEntries.map((e) => e.id)).toEqual(["w7-a", "w8-mon", "w8-tue"]);
    expect(r.removedEntries.map((e) => e.id).sort()).toEqual(["w10-a", "w8-sat", "w8-wed", "w9-a"].sort());
    expect(w8.entries).toHaveLength(4);
    expect(w8.notes).toBe("week 8 note");
    // The input is not mutated.
    expect(before).toEqual(snapshot);
  });

  it("applies week notes to weeks that begin on/after the cutoff only", () => {
    const r = buildReplacedWeeks(
      oldWeeks(), START, CUTOFF,
      [spec("2026-11-23", 9, 1)],
      { 7: "SHOULD NOT APPLY", 8: "SHOULD NOT APPLY", 9: "Holiday 3-run week", 10: "4-run week" },
      newId
    );
    const note = (wk: number) => r.weeks.find((w) => w.weekNumber === wk)?.notes;
    expect(note(7)).toBe("week 7 note");
    expect(note(8)).toBe("week 8 note");
    expect(note(9)).toBe("Holiday 3-run week");
    expect(note(10)).toBe("4-run week");
  });

  it("rejects a spec whose stated date does not match its week/weekday", () => {
    // 2026-11-19 is weekIndex 7 weekday 4 — not weekday 3.
    expect(() =>
      buildReplacedWeeks(oldWeeks(), START, CUTOFF, [spec("2026-11-19", 8, 3)], {}, newId)
    ).toThrow(/date mismatch/);
  });

  it("rejects a spec dated before the cutoff", () => {
    expect(() =>
      buildReplacedWeeks(oldWeeks(), START, CUTOFF, [spec("2026-11-17", 8, 2)], {}, newId)
    ).toThrow(/before the cutoff/);
  });

  it("writes no targetPaceSecondsPerMile key (not 0, not NaN) when the spec omits it", () => {
    const race = spec("2026-11-26", 9, 4, { paceTarget: "race effort", targetPaceSecondsPerMile: undefined });
    delete race.targetPaceSecondsPerMile;
    const r = buildReplacedWeeks(oldWeeks(), START, CUTOFF, [race], {}, newId);
    const e = r.addedEntries[0];
    expect("targetPaceSecondsPerMile" in e).toBe(false);
    expect(e.paceTarget).toBe("race effort");
    expect(e.dayOfWeek).toBe(3); // weekday - 1
    expect("notes" in e).toBe(false);
  });
});

describe("validateReplacedWeeks", () => {
  const opts = { expectedWeekCount: 10, expectedNewEntryCount: 2, finalRace: { date: "2026-11-21", distanceMiles: 9 } };
  function weeks10(): PlanWeek[] {
    const ws = oldWeeks();
    for (let i = 1; i <= 10; i++) if (!ws.find((w) => w.weekNumber === i)) ws.push({ weekNumber: i, entries: [] });
    return ws.sort((a, b) => a.weekNumber - b.weekNumber);
  }
  const specs = [
    spec("2026-11-18", 8, 3, { distanceMiles: 4 }),
    spec("2026-11-21", 8, 6, { distanceMiles: 9, workoutType: "race", runType: "longRun" }),
  ];

  it("returns no violations for a consistent replacement", () => {
    const before = weeks10();
    const r = buildReplacedWeeks(before, START, CUTOFF, specs, {}, newId);
    expect(validateReplacedWeeks(before, r, START, CUTOFF, { 8: 13 }, { ...opts, specs })).toEqual([]);
  });

  it("flags duplicate dates", () => {
    const dup = [specs[0], { ...specs[0] }, specs[1]];
    const before = weeks10();
    const r = buildReplacedWeeks(before, START, CUTOFF, dup, {}, newId);
    const v = validateReplacedWeeks(before, r, START, CUTOFF, { 8: 17 }, { ...opts, expectedNewEntryCount: 3 });
    expect(v.some((x) => x.startsWith("Duplicate date 2026-11-18"))).toBe(true);
  });

  it("flags a changed pre-cutoff entry, wrong miles, wrong count and a bad final entry", () => {
    const before = weeks10();
    const r = buildReplacedWeeks(before, START, CUTOFF, specs, {}, newId);
    // Tamper with a COPY of the kept Monday (kept entries are shared by reference with `before`).
    const w8 = r.weeks.find((w) => w.weekNumber === 8)!;
    w8.entries[0] = { ...w8.entries[0], distanceMiles: 99 };
    const v = validateReplacedWeeks(before, r, START, CUTOFF, { 8: 14 }, { ...opts, expectedNewEntryCount: 5, finalRace: { date: "2027-03-20", distanceMiles: 13.1 } });
    expect(v.some((x) => x.startsWith("Pre-cutoff entries changed"))).toBe(true);
    expect(v.some((x) => x.includes("Week 8 new miles"))).toBe(true);
    expect(v.some((x) => x.includes("Expected 5 new entries"))).toBe(true);
    expect(v.some((x) => x.startsWith("Final entry must be"))).toBe(true);
  });

  it("flags an invalid runType and a weekIndex that disagrees with its week", () => {
    const before = weeks10();
    const r = buildReplacedWeeks(before, START, CUTOFF, specs, {}, newId);
    (r.addedEntries[0] as unknown as { runType: string }).runType = "workout";
    const w8 = r.weeks.find((w) => w.weekNumber === 8)!;
    w8.entries[w8.entries.length - 1] = { ...w8.entries[w8.entries.length - 1], weekIndex: 3 };
    const v = validateReplacedWeeks(before, r, START, CUTOFF, { 8: 13 }, { ...opts, specs });
    expect(v.some((x) => x.includes('invalid runType "workout"'))).toBe(true);
    expect(v.some((x) => x.includes("has weekIndex 3"))).toBe(true);
  });
});

describe("deepEqual", () => {
  it("ignores key order but not values or extra keys", () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual({ a: null }, { a: undefined })).toBe(false);
  });
});
