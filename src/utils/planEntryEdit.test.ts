import { describe, it, expect } from "vitest";
import type { PlannedRunEntry } from "@/types/plan";
import { parsePaceString } from "@/utils/pace";
import {
  extractLeadingPaceSeconds,
  mergeEditedEntry,
  parsePaceRangeMidpoint,
} from "@/utils/planEntryEdit";

function entry(overrides: Partial<PlannedRunEntry> = {}): PlannedRunEntry {
  return {
    id: "entry-1",
    weekIndex: 8,
    weekday: 3,
    dayOfWeek: 2,
    distanceMiles: 6,
    runType: "outdoor",
    workoutType: "tempo",
    paceTarget: "9:10",
    targetPaceSecondsPerMile: 550,
    description: "tempo",
    targetHeartRate: null,
    ...overrides,
  };
}

describe("extractLeadingPaceSeconds", () => {
  it("returns null for an empty string", () => {
    expect(extractLeadingPaceSeconds("")).toBeNull();
  });
  it("returns null when there is no m:ss token", () => {
    expect(extractLeadingPaceSeconds("race effort")).toBeNull();
  });
  it("takes the first token of a range", () => {
    expect(extractLeadingPaceSeconds("8:50-9:10")).toBe(530);
  });
  it("handles open-ended and split paces", () => {
    expect(extractLeadingPaceSeconds("10:30+")).toBe(630);
    expect(extractLeadingPaceSeconds("10:30+ / 9:30")).toBe(630);
  });
  it("rejects invalid seconds", () => {
    expect(extractLeadingPaceSeconds("9:75")).toBeNull();
  });
});

describe("parsePaceString precedent (documented behavior)", () => {
  it("does not parse a range itself (the range midpoint step handles it)", () => {
    expect(parsePaceString("8:50-9:10")).toBeNull();
  });
});

describe("parsePaceRangeMidpoint", () => {
  it("returns the midpoint of a range", () => {
    expect(parsePaceRangeMidpoint("8:50-9:10")).toBe(540);
  });
  it("is order-independent", () => {
    expect(parsePaceRangeMidpoint("9:10-8:50")).toBe(540);
  });
  it("tolerates spaces around the dash", () => {
    expect(parsePaceRangeMidpoint("8:50 - 9:10")).toBe(540);
  });
  it.each(["10:30+", "10:30+ / 9:30", "9:10", "race effort", "", "8:50-9:75"])(
    "returns null for non-range %j",
    (text) => {
      expect(parsePaceRangeMidpoint(text)).toBeNull();
    }
  );
});

describe("mergeEditedEntry", () => {
  it("keeps workoutType, targetPaceSecondsPerMile, id and dayOfWeek on a description-only edit", () => {
    const existing = entry();
    const merged = mergeEditedEntry(existing, { description: "new text" });
    expect(merged.description).toBe("new text");
    expect(merged.workoutType).toBe("tempo");
    expect(merged.targetPaceSecondsPerMile).toBe(550);
    expect(merged.id).toBe("entry-1");
    expect(merged.dayOfWeek).toBe(2);
    expect(merged.weekIndex).toBe(8);
    expect(merged.weekday).toBe(3);
  });

  it("keeps the seconds when paceTarget is resubmitted unchanged (even if unparseable)", () => {
    const existing = entry({ paceTarget: "10:30+", targetPaceSecondsPerMile: 630 });
    const merged = mergeEditedEntry(existing, { paceTarget: "10:30+", notes: "x" });
    expect(merged.targetPaceSecondsPerMile).toBe(630);
  });

  it("keeps a range's stored midpoint when the range text is unchanged", () => {
    const existing = entry({ paceTarget: "8:50-9:10", targetPaceSecondsPerMile: 540 });
    const merged = mergeEditedEntry(existing, { paceTarget: "8:50-9:10" });
    expect(merged.targetPaceSecondsPerMile).toBe(540);
  });

  it.each([
    ["9:10", 550],
    ["10:30+", 630],
    ["10:30+ / 9:30", 630],
  ])("re-syncs seconds when paceTarget changes to %s", (pace, seconds) => {
    const existing = entry({ paceTarget: "8:00", targetPaceSecondsPerMile: 480 });
    const merged = mergeEditedEntry(existing, { paceTarget: pace });
    expect(merged.paceTarget).toBe(pace);
    expect(merged.targetPaceSecondsPerMile).toBe(seconds);
  });

  it("stores the midpoint when paceTarget changes to a range", () => {
    const merged = mergeEditedEntry(entry(), { paceTarget: "8:50-9:10" });
    expect(merged.targetPaceSecondsPerMile).toBe(540);
  });

  it("unsets the seconds (no key, not 0/NaN) when the new pace is garbage", () => {
    const merged = mergeEditedEntry(entry(), { paceTarget: "race effort" });
    expect(merged.paceTarget).toBe("race effort");
    expect("targetPaceSecondsPerMile" in merged).toBe(false);
  });

  it("unsets the seconds when the pace is cleared", () => {
    const merged = mergeEditedEntry(entry(), { paceTarget: undefined });
    expect("paceTarget" in merged).toBe(false);
    expect("targetPaceSecondsPerMile" in merged).toBe(false);
  });

  it("clears an optional field edited to undefined and does not mutate the input", () => {
    const existing = entry({ notes: "keep?" });
    const snapshot = JSON.parse(JSON.stringify(existing));
    const merged = mergeEditedEntry(existing, { notes: undefined });
    expect("notes" in merged).toBe(false);
    expect(existing).toEqual(snapshot);
  });
});
