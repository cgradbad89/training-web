import { describe, it, expect } from "vitest";
import type { PlannedRunEntry, PlanWeek } from "@/types/plan";
import {
  EXPECTED_APPLIED_COUNTS,
  EXPECTED_FRESH_COUNTS,
  EXPECTED_TARGET_DISTRIBUTION,
  HR_BACKFILL_CUTOFF_DATE,
  planHrBackfill,
  validateHrBackfill,
} from "@/utils/hrTargetBackfill";
import { deepEqual, plannedEntryIsoDate } from "@/utils/planReplace";

const START = "2026-09-28";
const CUTOFF = HR_BACKFILL_CUTOFF_DATE;

type Shape = Pick<PlannedRunEntry, "workoutType" | "targetHeartRate" | "notes" | "runType">;

/** The 62 in-scope shapes of the live plan (see the investigation breakdown). */
function inScopeShapes(): Shape[] {
  const out: Shape[] = [];
  const HR_CAP_NOTE = "HR cap 135 — slow down or walk hills to stay under";
  for (let i = 0; i < 26; i++) {
    out.push({ workoutType: "easy", runType: "outdoor", targetHeartRate: 135, notes: HR_CAP_NOTE });
  }
  out.push({ workoutType: "easy", runType: "outdoor", targetHeartRate: 135, notes: "Moved off New Year's Day; HR cap 135" });
  for (let i = 0; i < 12; i++) {
    out.push({ workoutType: "long", runType: "longRun", targetHeartRate: 135 });
  }
  out.push({ workoutType: "race", runType: "longRun", targetHeartRate: 160, notes: "Miles 1-3 @ 9:35-9:40" });
  for (let i = 0; i < 8; i++) out.push({ workoutType: "tempo", runType: "outdoor", targetHeartRate: null, notes: "HR 146-155 bpm" });
  for (let i = 0; i < 6; i++) out.push({ workoutType: "tempo", runType: "outdoor", targetHeartRate: null, notes: "HR 155-165 bpm" });
  out.push({ workoutType: "tempo", runType: "outdoor", targetHeartRate: null, notes: "HR 145-155 bpm. Optional 15-20 min shakeout Fri" });
  out.push({ workoutType: "tempo", runType: "outdoor", targetHeartRate: null, notes: "HR 145-155 bpm" });
  for (const tail of ["", ". Practice race fueling (gel at ~45 min)", ". Key session — full race dress rehearsal", ". First goal-pace finish", ""]) {
    out.push({ workoutType: "long", runType: "longRun", targetHeartRate: null, notes: `HR <135 / 145-155 bpm${tail}` });
  }
  out.push({ workoutType: "race", runType: "outdoor", targetHeartRate: null, notes: "On track for 2:04:30 if 5mi < 44:50" });
  return out;
}

function makeEntry(id: string, weekIndex: number, weekday: number, shape: Partial<PlannedRunEntry>): PlannedRunEntry {
  return {
    id,
    weekIndex,
    weekday,
    dayOfWeek: weekday - 1,
    distanceMiles: 5,
    paceTarget: "10:30+",
    targetPaceSecondsPerMile: 630,
    description: `entry ${id}`,
    ...shape,
  };
}

/** Pre-cutoff entries (incl. one that LOOKS backfillable) + the 62 in-scope ones. */
function fixtureWeeks(): PlanWeek[] {
  const byWeek = new Map<number, PlannedRunEntry[]>();
  const push = (e: PlannedRunEntry) => byWeek.set(e.weekIndex, [...(byWeek.get(e.weekIndex) ?? []), e]);

  push(makeEntry("pre-0", 0, 2, { runType: "outdoor", workoutType: "easy", targetHeartRate: 135, notes: "HR cap 135" }));
  push(makeEntry("pre-range", 6, 3, { runType: "outdoor", workoutType: "tempo", targetHeartRate: null, notes: "HR 146-155 bpm" }));
  push(makeEntry("pre-mon", 7, 1, { runType: "outdoor", workoutType: "easy", targetHeartRate: 135, notes: "HR cap 135" }));
  push(makeEntry("pre-tue", 7, 2, { runType: "outdoor", workoutType: "easy", targetHeartRate: null }));

  inScopeShapes().forEach((shape, i) => {
    const offset = i + 2; // index 0 → Wed 2026-11-18 (week 8, weekday 3)
    push(makeEntry(`in-${i}`, 7 + Math.floor(offset / 7), (offset % 7) + 1, shape));
  });

  return [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([weekIndex, entries]) => ({ weekNumber: weekIndex + 1, entries, notes: `note ${weekIndex + 1}` }));
}

describe("planHrBackfill — the 62-entry live shape", () => {
  it("fixture sanity: 62 in-scope entries, first dated 2026-11-18", () => {
    const { rows } = planHrBackfill(fixtureWeeks(), START, CUTOFF);
    expect(rows).toHaveLength(62);
    expect(rows[0].date).toBe("2026-11-18");
    expect(new Set(rows.map((r) => r.date)).size).toBe(62);
  });

  it("produces the exact reason counts", () => {
    const { rows } = planHrBackfill(fixtureWeeks(), START, CUTOFF);
    const count = (r: string) => rows.filter((x) => x.reason === r).length;
    expect(count("legacy-cap")).toBe(40);
    expect(count("notes-range")).toBe(16);
    expect(count("split-skip")).toBe(5);
    expect(count("no-target")).toBe(1);
    expect(count("already-set")).toBe(0);
  });

  it("produces the exact target distribution (39 × cap 135, 1 × cap 160, 8/6/2 ranges)", () => {
    const result = planHrBackfill(fixtureWeeks(), START, CUTOFF);
    const v = validateHrBackfill(fixtureWeeks(), result, START, CUTOFF);
    expect(v.distribution).toEqual(EXPECTED_TARGET_DISTRIBUTION);
    expect(v.counts).toEqual(EXPECTED_FRESH_COUNTS);
    expect(v.state).toBe("fresh");
    expect(v.violations).toEqual([]);
  });

  it("legacy caps become {null, cap} and keep the legacy field", () => {
    const { weeks } = planHrBackfill(fixtureWeeks(), START, CUTOFF);
    const all = weeks.flatMap((w) => w.entries);
    const easy = all.find((e) => e.id === "in-0")!;
    expect(easy.targetHr).toEqual({ minBpm: null, maxBpm: 135 });
    expect(easy.targetHeartRate).toBe(135);
    const race = all.find((e) => e.workoutType === "race" && e.targetHeartRate === 160)!;
    expect(race.targetHr).toEqual({ minBpm: null, maxBpm: 160 });
  });

  it("notes ranges become {min, max} and the legacy field stays null", () => {
    const { weeks } = planHrBackfill(fixtureWeeks(), START, CUTOFF);
    const tempo = weeks
      .flatMap((w) => w.entries)
      .filter((e) => e.workoutType === "tempo" && e.id.startsWith("in-"));
    expect(tempo).toHaveLength(16);
    for (const e of tempo) expect(e.targetHeartRate).toBeNull();
    expect(tempo.filter((e) => e.targetHr?.minBpm === 146 && e.targetHr?.maxBpm === 155)).toHaveLength(8);
    expect(tempo.filter((e) => e.targetHr?.minBpm === 155 && e.targetHr?.maxBpm === 165)).toHaveLength(6);
    expect(tempo.filter((e) => e.targetHr?.minBpm === 145 && e.targetHr?.maxBpm === 155)).toHaveLength(2);
  });

  it("split long runs and the Turkey Trot get no targetHr and stay the same objects", () => {
    const input = fixtureWeeks();
    const { weeks, rows } = planHrBackfill(input, START, CUTOFF);
    const skipped = rows.filter((r) => r.reason === "split-skip" || r.reason === "no-target");
    expect(skipped).toHaveLength(6);
    const flatIn = input.flatMap((w) => w.entries);
    const flatOut = weeks.flatMap((w) => w.entries);
    for (const r of skipped) {
      const before = flatIn.find((e) => e.id === r.entryId)!;
      const after = flatOut.find((e) => e.id === r.entryId)!;
      expect(after).toBe(before);
      expect(after.targetHr).toBeUndefined();
      expect(r.after).toBeNull();
    }
  });

  it("never changes notes", () => {
    const input = fixtureWeeks();
    const { weeks } = planHrBackfill(input, START, CUTOFF);
    const inNotes = input.flatMap((w) => w.entries).map((e) => [e.id, e.notes]);
    const outNotes = weeks.flatMap((w) => w.entries).map((e) => [e.id, e.notes]);
    expect(outNotes).toEqual(inNotes);
  });

  it("leaves pre-cutoff entries untouched (same objects), even ones that look backfillable", () => {
    const input = fixtureWeeks();
    const { weeks } = planHrBackfill(input, START, CUTOFF);
    const flatIn = input.flatMap((w) => w.entries);
    const flatOut = weeks.flatMap((w) => w.entries);
    for (const id of ["pre-0", "pre-range", "pre-mon", "pre-tue"]) {
      const a = flatIn.find((e) => e.id === id)!;
      const b = flatOut.find((e) => e.id === id)!;
      expect(b).toBe(a);
      expect(b.targetHr).toBeUndefined();
      expect(plannedEntryIsoDate(START, a.weekIndex, a.weekday) < CUTOFF).toBe(true);
    }
  });

  it("does not mutate its input", () => {
    const input = fixtureWeeks();
    const snapshot = JSON.parse(JSON.stringify(input));
    planHrBackfill(input, START, CUTOFF);
    expect(deepEqual(input, snapshot)).toBe(true);
  });
});

describe("planHrBackfill — idempotence", () => {
  it("a second run reports the 56 targets as already-set and changes nothing", () => {
    const first = planHrBackfill(fixtureWeeks(), START, CUTOFF);
    const second = planHrBackfill(first.weeks, START, CUTOFF);
    const count = (r: string) => second.rows.filter((x) => x.reason === r).length;
    expect(count("already-set")).toBe(56);
    expect(count("legacy-cap") + count("notes-range")).toBe(0);
    expect(count("split-skip")).toBe(5);
    expect(count("no-target")).toBe(1);
    expect(deepEqual(second.weeks, first.weeks)).toBe(true);
    const v = validateHrBackfill(first.weeks, second, START, CUTOFF);
    expect(v.state).toBe("applied");
    expect(v.counts).toEqual(EXPECTED_APPLIED_COUNTS);
    expect(v.violations).toEqual([]);
  });
});

describe("planHrBackfill — edge cases", () => {
  const one = (shape: Partial<PlannedRunEntry>): PlanWeek[] => [
    { weekNumber: 8, entries: [makeEntry("x", 7, 3, shape)] },
  ];

  it("skips an entry that already has a valid targetHr, even with different notes", () => {
    const { rows, weeks } = planHrBackfill(
      one({ targetHr: { minBpm: 150, maxBpm: 160 }, targetHeartRate: null, notes: "HR 146-155 bpm" }),
      START,
      CUTOFF
    );
    expect(rows[0].reason).toBe("already-set");
    expect(weeks[0].entries[0].targetHr).toEqual({ minBpm: 150, maxBpm: 160 });
  });

  it("treats an invalid targetHr as absent and uses the legacy cap", () => {
    const { rows } = planHrBackfill(
      one({ targetHr: { minBpm: 170, maxBpm: 150 }, targetHeartRate: 135 }),
      START,
      CUTOFF
    );
    expect(rows[0].reason).toBe("legacy-cap");
    expect(rows[0].after).toEqual({ minBpm: null, maxBpm: 135 });
  });

  it("throws on an unrecognized HR note in scope (strict)", () => {
    expect(() => planHrBackfill(one({ targetHeartRate: null, notes: "HR cap 135 — slow down" }), START, CUTOFF)).toThrow(
      /Unrecognized HR note/
    );
  });

  it("does not parse notes when a legacy cap exists (HR cap notes are fine there)", () => {
    const { rows } = planHrBackfill(one({ targetHeartRate: 135, notes: "HR cap 135 — slow down" }), START, CUTOFF);
    expect(rows[0].reason).toBe("legacy-cap");
  });

  it("records before/after on each row", () => {
    const { rows } = planHrBackfill(one({ targetHeartRate: null, notes: "HR 146-155 bpm", workoutType: "tempo" }), START, CUTOFF);
    expect(rows[0]).toEqual({
      date: "2026-11-18",
      entryId: "x",
      workoutType: "tempo",
      before: { targetHeartRate: null, notes: "HR 146-155 bpm" },
      after: { minBpm: 146, maxBpm: 155 },
      reason: "notes-range",
    });
  });
});

describe("validateHrBackfill", () => {
  it("flags a changed note, a changed pre-cutoff entry and wrong counts", () => {
    const input = fixtureWeeks();
    const result = planHrBackfill(input, START, CUTOFF);

    const tamperedNotes = structuredClone(result);
    tamperedNotes.weeks[1].entries[0].notes = "edited";
    expect(validateHrBackfill(input, tamperedNotes, START, CUTOFF).violations.join("\n")).toMatch(/changed beyond targetHr|pre-cutoff/);

    const tamperedPre = structuredClone(result);
    tamperedPre.weeks[0].entries[0].targetHr = { minBpm: null, maxBpm: 135 };
    expect(validateHrBackfill(input, tamperedPre, START, CUTOFF).violations.join("\n")).toMatch(/pre-cutoff entry pre-0/);

    const fewer = planHrBackfill(
      input.map((w) => ({ ...w, entries: w.entries.filter((e) => e.id !== "in-61") })),
      START,
      CUTOFF
    );
    const v = validateHrBackfill(input, fewer, START, CUTOFF);
    expect(v.state).toBe("unexpected");
    expect(v.violations.length).toBeGreaterThan(0);
  });
});
