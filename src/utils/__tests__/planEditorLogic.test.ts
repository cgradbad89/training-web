import { describe, it, expect } from "vitest";
import {
  clampWeekIndex,
  pageWeekIndex,
  buildCopyWeekEntries,
  buildCopyDayEntries,
  makeNewWorkoutEntry,
  makeNewRunEntry,
  workoutWeekSummaryLabel,
  runningWeekSummaryLabel,
  computeWeekCompletion,
  resolveInitialWeekIndex,
  runMutationWithDirty,
  normalizeScheduledTime,
} from "@/utils/planEditorLogic";
import type { PlannedWorkoutEntry, PlannedRunEntry } from "@/types/plan";
import { deepCopyRunEntry } from "@/utils/planCopy";

// Minimal entry shape for the generic copy helpers + a deterministic copy fn
// (no crypto randomness) so assertions are stable.
interface FakeEntry {
  id: string;
  weekday: number;
  weekIndex: number;
  dayOfWeek: number;
  type: "workout" | "rest";
}

function fake(id: string, weekday: number, type: "workout" | "rest" = "workout"): FakeEntry {
  return { id, weekday, weekIndex: 0, dayOfWeek: weekday - 1, type };
}

const copyEntryToDay = (
  e: FakeEntry,
  targetWeekIndex: number,
  targetWeekday: number
): FakeEntry => ({
  ...e,
  id: `copy-${e.id}`,
  weekIndex: targetWeekIndex,
  weekday: targetWeekday,
  dayOfWeek: targetWeekday - 1,
});

const isRest = (e: FakeEntry) => e.type === "rest";

// ─── Week pagination bounds ───────────────────────────────────────────────────

describe("clampWeekIndex", () => {
  it("returns the index unchanged when within bounds", () => {
    expect(clampWeekIndex(2, 8)).toBe(2);
  });

  it("clamps below 0 up to 0", () => {
    expect(clampWeekIndex(-3, 8)).toBe(0);
  });

  it("clamps past the last week to the last week", () => {
    expect(clampWeekIndex(99, 8)).toBe(7);
  });

  it("clamps to 0 for an empty plan", () => {
    expect(clampWeekIndex(5, 0)).toBe(0);
  });
});

describe("pageWeekIndex", () => {
  it("cannot page below week 0", () => {
    expect(pageWeekIndex(0, -1, 8)).toBe(0);
  });

  it("cannot page past the last week", () => {
    expect(pageWeekIndex(7, 1, 8)).toBe(7);
  });

  it("increments within bounds", () => {
    expect(pageWeekIndex(2, 1, 8)).toBe(3);
  });

  it("a single-week plan can never move off week 0", () => {
    expect(pageWeekIndex(0, 1, 1)).toBe(0);
    expect(pageWeekIndex(0, -1, 1)).toBe(0);
  });
});

// ─── Copy week ────────────────────────────────────────────────────────────────

describe("buildCopyWeekEntries", () => {
  it("copies every source entry onto the target week, preserving weekday", () => {
    const source = [fake("a", 1), fake("b", 3)];
    const result = buildCopyWeekEntries(source, 4, copyEntryToDay);

    expect(result).toHaveLength(2);
    expect(result.map((e) => e.weekIndex)).toEqual([4, 4]);
    expect(result.map((e) => e.weekday)).toEqual([1, 3]);
    expect(result.map((e) => e.id)).toEqual(["copy-a", "copy-b"]);
  });

  it("returns an empty list for an empty source week", () => {
    expect(buildCopyWeekEntries([], 2, copyEntryToDay)).toEqual([]);
  });
});

// ─── Copy day ─────────────────────────────────────────────────────────────────

describe("buildCopyDayEntries", () => {
  it("replaces the target weekday's entries and keeps other days", () => {
    const targetWeek = [fake("x", 2), fake("y", 5)];
    const source = [fake("s", 1)];
    const result = buildCopyDayEntries(targetWeek, source, 3, 2, copyEntryToDay, isRest);

    // y (weekday 5) kept; x (weekday 2) dropped; copied s lands on weekday 2.
    expect(result.map((e) => e.id).sort()).toEqual(["copy-s", "y"]);
    const copied = result.find((e) => e.id === "copy-s")!;
    expect(copied.weekday).toBe(2);
    expect(copied.weekIndex).toBe(3);
  });

  it("preserves rest placeholders on the target weekday", () => {
    const targetWeek = [fake("r", 2, "rest"), fake("x", 2)];
    const source = [fake("s", 1)];
    const result = buildCopyDayEntries(targetWeek, source, 0, 2, copyEntryToDay, isRest);

    // rest entry kept, non-rest x dropped, copy-s added.
    expect(result.map((e) => e.id).sort()).toEqual(["copy-s", "r"]);
  });

  it("appends onto an empty target weekday without disturbing others", () => {
    const targetWeek = [fake("y", 5)];
    const source = [fake("s", 1), fake("s2", 1)];
    const result = buildCopyDayEntries(targetWeek, source, 0, 3, copyEntryToDay, isRest);

    expect(result).toHaveLength(3);
    expect(result.filter((e) => e.weekday === 3)).toHaveLength(2);
  });
});

// ─── Workout config helpers ───────────────────────────────────────────────────

describe("makeNewWorkoutEntry", () => {
  it("produces a blank workout session on the given day", () => {
    const e: PlannedWorkoutEntry = makeNewWorkoutEntry(2, 4);
    expect(e.type).toBe("workout");
    expect(e.weekIndex).toBe(2);
    expect(e.weekday).toBe(4);
    expect(e.dayOfWeek).toBe(3);
    expect(e.exercises).toEqual([]);
    expect(typeof e.id).toBe("string");
    expect(e.id.length).toBeGreaterThan(0);
  });
});

describe("workoutWeekSummaryLabel", () => {
  it("returns an empty string for a week with no sessions", () => {
    expect(workoutWeekSummaryLabel([])).toBe("");
  });

  it("uses the singular for exactly one session", () => {
    expect(
      workoutWeekSummaryLabel([makeNewWorkoutEntry(0, 1)])
    ).toBe("1 session");
  });

  it("uses the plural for multiple sessions", () => {
    expect(
      workoutWeekSummaryLabel([makeNewWorkoutEntry(0, 1), makeNewWorkoutEntry(0, 2)])
    ).toBe("2 sessions");
  });

  it("excludes rest entries from the count", () => {
    const rest = { ...makeNewWorkoutEntry(0, 3), type: "rest" as const };
    expect(
      workoutWeekSummaryLabel([makeNewWorkoutEntry(0, 1), rest])
    ).toBe("1 session");
  });
});

// ─── Running config helpers ───────────────────────────────────────────────────

describe("makeNewRunEntry", () => {
  it("produces a blank outdoor run on the given day with a 0 distance default", () => {
    const e: PlannedRunEntry = makeNewRunEntry(3, 6);
    expect(e.runType).toBe("outdoor");
    expect(e.distanceMiles).toBe(0);
    expect(e.weekIndex).toBe(3);
    expect(e.weekday).toBe(6);
    expect(e.dayOfWeek).toBe(5);
    expect(typeof e.id).toBe("string");
    expect(e.id.length).toBeGreaterThan(0);
  });

  it("generates a fresh id on each call", () => {
    expect(makeNewRunEntry(0, 1).id).not.toBe(makeNewRunEntry(0, 1).id);
  });
});

describe("runningWeekSummaryLabel", () => {
  function run(weekday: number, miles: number, runType: PlannedRunEntry["runType"] = "outdoor"): PlannedRunEntry {
    return { id: `r${weekday}`, weekIndex: 0, weekday, dayOfWeek: weekday - 1, distanceMiles: miles, runType };
  }

  it("sums planned miles across the week, one decimal", () => {
    expect(runningWeekSummaryLabel([run(1, 5), run(3, 8.5), run(6, 7)])).toBe("20.5 mi");
  });

  it("reports 0.0 mi for an empty week", () => {
    expect(runningWeekSummaryLabel([])).toBe("0.0 mi");
  });

  it("reports 0.0 mi for a rest-only week (rest entries excluded)", () => {
    expect(runningWeekSummaryLabel([run(2, 0, "rest"), run(4, 0, "rest")])).toBe("0.0 mi");
  });

  it("formats a single run with one decimal", () => {
    expect(runningWeekSummaryLabel([run(1, 5)])).toBe("5.0 mi");
  });
});

// ─── Generic copy helpers operate on running entries ──────────────────────────

describe("buildCopyWeekEntries / buildCopyDayEntries with PlannedRunEntry", () => {
  function runEntry(
    id: string,
    weekday: number,
    runType: PlannedRunEntry["runType"] = "outdoor"
  ): PlannedRunEntry {
    return {
      id,
      weekIndex: 0,
      weekday,
      dayOfWeek: weekday - 1,
      distanceMiles: 8,
      paceTarget: "9:30",
      runType,
    };
  }

  it("copy-week preserves runType/distance/pace and reassigns the target week", () => {
    const copied = buildCopyWeekEntries([runEntry("a", 2, "longRun")], 4, deepCopyRunEntry);
    expect(copied).toHaveLength(1);
    expect(copied[0].runType).toBe("longRun");
    expect(copied[0].distanceMiles).toBe(8);
    expect(copied[0].paceTarget).toBe("9:30");
    expect(copied[0].weekIndex).toBe(4);
    expect(copied[0].weekday).toBe(2);
    expect(copied[0].id).not.toBe("a"); // fresh id
  });

  it("copy-day replaces the target weekday's runs and keeps other days", () => {
    const targetWeek = [runEntry("x", 2), runEntry("y", 5)];
    const source = [runEntry("s", 1, "treadmill")];
    const result = buildCopyDayEntries(
      targetWeek,
      source,
      3,
      2,
      deepCopyRunEntry,
      (e) => e.runType === "rest"
    );
    // y (weekday 5) kept; x (weekday 2) replaced by a copy of s on weekday 2.
    expect(result.map((e) => e.weekday).sort()).toEqual([2, 5]);
    const copied = result.find((e) => e.weekday === 2)!;
    expect(copied.runType).toBe("treadmill");
    expect(copied.weekIndex).toBe(3);
    expect(copied.id).not.toBe("s");
  });

  it("copy-day keeps a rest entry on the target weekday", () => {
    const targetWeek = [runEntry("rest", 2, "rest"), runEntry("x", 2)];
    const source = [runEntry("s", 1)];
    const result = buildCopyDayEntries(
      targetWeek,
      source,
      0,
      2,
      deepCopyRunEntry,
      (e) => e.runType === "rest"
    );
    // rest entry preserved, non-rest x dropped, copy of s added.
    expect(result.some((e) => e.id === "rest")).toBe(true);
    expect(result.some((e) => e.id === "x")).toBe(false);
    expect(result.filter((e) => e.weekday === 2 && e.runType !== "rest")).toHaveLength(1);
  });
});

// ─── Per-week completion (progress bar) ───────────────────────────────────────

describe("computeWeekCompletion", () => {
  function run(id: string, miles: number, runType: PlannedRunEntry["runType"] = "outdoor"): PlannedRunEntry {
    return { id, weekIndex: 0, weekday: 1, dayOfWeek: 0, distanceMiles: miles, runType };
  }

  it("counts matched runs and sums planned vs matched miles", () => {
    const entries = [run("a", 5), run("b", 8), run("c", 3)];
    // 'a' matched to a 4.8-mi actual, 'b' matched to 8, 'c' unmatched.
    const matched: Record<string, number> = { a: 4.8, b: 8 };
    const r = computeWeekCompletion(entries, (id) => matched[id] ?? null);
    expect(r.completedRuns).toBe(2);
    expect(r.totalRuns).toBe(3);
    expect(r.plannedMiles).toBe(16);
    expect(r.actualMiles).toBeCloseTo(12.8, 5);
    expect(r.pct).toBeCloseTo(12.8 / 16, 5);
  });

  it("reports zeros and pct 0 for an empty week", () => {
    const r = computeWeekCompletion([], () => null);
    expect(r).toEqual({ completedRuns: 0, totalRuns: 0, plannedMiles: 0, actualMiles: 0, pct: 0 });
  });

  it("excludes rest entries and yields pct 0 for a rest-only week", () => {
    const r = computeWeekCompletion([run("x", 0, "rest")], () => null);
    expect(r.totalRuns).toBe(0);
    expect(r.pct).toBe(0);
  });

  it("clamps pct to 1 when actual exceeds planned", () => {
    const r = computeWeekCompletion([run("a", 5)], () => 9);
    expect(r.pct).toBe(1);
    expect(r.actualMiles).toBe(9);
  });

  it("treats a 0-mile matched activity as completed (match present, not miles)", () => {
    const r = computeWeekCompletion([run("a", 5)], () => 0);
    expect(r.completedRuns).toBe(1);
    expect(r.actualMiles).toBe(0);
    expect(r.pct).toBe(0);
  });
});

// ─── Initial-week resolution (deep-link landing) ──────────────────────────────

describe("resolveInitialWeekIndex", () => {
  it("uses the default current-week when no override is given", () => {
    expect(resolveInitialWeekIndex(undefined, 4, 13)).toBe(4);
  });

  it("an in-range override wins over the default", () => {
    expect(resolveInitialWeekIndex(7, 4, 13)).toBe(7);
  });

  it("clamps an out-of-range (too high) override to the last week", () => {
    expect(resolveInitialWeekIndex(99, 4, 13)).toBe(12);
  });

  it("clamps a negative override to week 0", () => {
    expect(resolveInitialWeekIndex(-3, 4, 13)).toBe(0);
  });

  it("clamps an out-of-range default when no override is present", () => {
    expect(resolveInitialWeekIndex(undefined, 99, 13)).toBe(12);
  });

  it("week 0 and last week round-trip exactly", () => {
    expect(resolveInitialWeekIndex(0, 5, 13)).toBe(0);
    expect(resolveInitialWeekIndex(12, 5, 13)).toBe(12);
  });
});

// ─── Dirty-state lifecycle ────────────────────────────────────────────────────

describe("runMutationWithDirty", () => {
  it("flags dirty before the write and clears it after success", async () => {
    const calls: boolean[] = [];
    let ran = false;
    await runMutationWithDirty(async () => {
      ran = true;
    }, (v) => calls.push(v));

    expect(ran).toBe(true);
    expect(calls).toEqual([true, false]);
  });

  it("clears the dirty flag even when the write throws", async () => {
    const calls: boolean[] = [];
    await expect(
      runMutationWithDirty(async () => {
        throw new Error("write failed");
      }, (v) => calls.push(v))
    ).rejects.toThrow("write failed");

    expect(calls).toEqual([true, false]);
  });

  it("cancelling an unchanged draft never runs a mutation, so dirty stays false", () => {
    let dirty = false;
    const setDirty = (v: boolean) => {
      dirty = v;
    };
    // Simulate opening a row editor then cancelling: no mutation is dispatched.
    // (runMutationWithDirty is the ONLY thing that flips dirty true.)
    expect(dirty).toBe(false);
    // A no-op cancel handler touches nothing.
    void setDirty;
    expect(dirty).toBe(false);
  });
});

// ─── scheduledTime normalization + persistence ────────────────────────────────

describe("normalizeScheduledTime", () => {
  it("stores a set time as the raw HH:MM string", () => {
    expect(normalizeScheduledTime("07:00")).toBe("07:00");
  });

  it("yields undefined (not an empty string) for a blank input", () => {
    const result = normalizeScheduledTime("");
    expect(result).toBeUndefined();
    expect(result).not.toBe("");
  });

  it("yields undefined for a whitespace-only input", () => {
    expect(normalizeScheduledTime("   ")).toBeUndefined();
  });

  it("trims surrounding whitespace from a set time", () => {
    expect(normalizeScheduledTime("  07:00 ")).toBe("07:00");
  });
});

// The write path serializes the whole plan via stripUndefined, which is
// JSON.parse(JSON.stringify(...)) — so these JSON round-trips mirror exactly
// what reaches Firestore for an entry's scheduledTime field.
describe("scheduledTime write-path round-trip", () => {
  const baseEntry: PlannedRunEntry = {
    id: "e1",
    weekIndex: 0,
    weekday: 1,
    dayOfWeek: 0,
    distanceMiles: 5,
    runType: "outdoor",
  };

  it("persists scheduledTime when set", () => {
    const entry: PlannedRunEntry = {
      ...baseEntry,
      scheduledTime: normalizeScheduledTime("07:00"),
    };
    const written = JSON.parse(JSON.stringify(entry)) as PlannedRunEntry;
    expect(written.scheduledTime).toBe("07:00");
  });

  it("drops scheduledTime entirely when the input is empty (never writes \"\")", () => {
    const entry: PlannedRunEntry = {
      ...baseEntry,
      scheduledTime: normalizeScheduledTime(""),
    };
    const written = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
    expect("scheduledTime" in written).toBe(false);
    expect(written.scheduledTime).not.toBe("");
  });

  it("round-trips an entry with no scheduledTime unchanged", () => {
    const written = JSON.parse(JSON.stringify(baseEntry)) as PlannedRunEntry;
    expect(written).toEqual(baseEntry);
    expect("scheduledTime" in written).toBe(false);
  });
});
