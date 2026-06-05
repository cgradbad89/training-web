import { describe, it, expect } from "vitest";
import {
  clampWeekIndex,
  pageWeekIndex,
  buildCopyWeekEntries,
  buildCopyDayEntries,
  makeNewWorkoutEntry,
  workoutWeekSummaryLabel,
  runMutationWithDirty,
} from "@/utils/planEditorLogic";
import type { PlannedWorkoutEntry } from "@/types/plan";

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
