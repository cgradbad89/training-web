import { describe, it, expect } from "vitest";
import type { PlannedRunEntry, TargetHeartRate } from "@/types/plan";
import {
  HR_TARGET_GRACE_BPM,
  computeWeekHrCounters,
  evaluateHrTarget,
  formatHrTarget,
  isMileOverTarget,
  isValidHrTarget,
  parseHrTargetFromNotes,
  resolveHrTarget,
  toLegacyTargetHeartRate,
} from "@/utils/hrTarget";

function entry(overrides: Partial<PlannedRunEntry> = {}): PlannedRunEntry {
  return {
    id: "e1",
    weekIndex: 0,
    weekday: 1,
    dayOfWeek: 0,
    distanceMiles: 5,
    runType: "outdoor",
    workoutType: "easy",
    ...overrides,
  };
}

const CAP_135: TargetHeartRate = { minBpm: null, maxBpm: 135 };
const RANGE_146_155: TargetHeartRate = { minBpm: 146, maxBpm: 155 };

describe("HR_TARGET_GRACE_BPM", () => {
  it("is the owner-approved 2 bpm", () => {
    expect(HR_TARGET_GRACE_BPM).toBe(2);
  });
});

describe("isValidHrTarget", () => {
  it("accepts a cap, a range and a floor", () => {
    expect(isValidHrTarget(CAP_135)).toBe(true);
    expect(isValidHrTarget(RANGE_146_155)).toBe(true);
    expect(isValidHrTarget({ minBpm: 140, maxBpm: null })).toBe(true);
  });
  it("rejects null, empty, out-of-range and inverted targets", () => {
    expect(isValidHrTarget(null)).toBe(false);
    expect(isValidHrTarget(undefined)).toBe(false);
    expect(isValidHrTarget({ minBpm: null, maxBpm: null })).toBe(false);
    expect(isValidHrTarget({ minBpm: null, maxBpm: 39 })).toBe(false);
    expect(isValidHrTarget({ minBpm: null, maxBpm: 221 })).toBe(false);
    expect(isValidHrTarget({ minBpm: 160, maxBpm: 150 })).toBe(false);
    expect(isValidHrTarget({ minBpm: NaN, maxBpm: 150 })).toBe(false);
  });
  it("accepts the 40 and 220 boundaries and min === max", () => {
    expect(isValidHrTarget({ minBpm: 40, maxBpm: 220 })).toBe(true);
    expect(isValidHrTarget({ minBpm: 150, maxBpm: 150 })).toBe(true);
  });
});

describe("resolveHrTarget", () => {
  it("prefers a valid targetHr over the legacy cap", () => {
    expect(resolveHrTarget(entry({ targetHr: RANGE_146_155, targetHeartRate: 135 }))).toEqual(
      RANGE_146_155
    );
  });
  it("falls back to the legacy cap", () => {
    expect(resolveHrTarget(entry({ targetHeartRate: 135 }))).toEqual(CAP_135);
  });
  it("falls back to the legacy cap when targetHr is invalid", () => {
    expect(
      resolveHrTarget(entry({ targetHr: { minBpm: 160, maxBpm: 150 }, targetHeartRate: 135 }))
    ).toEqual(CAP_135);
  });
  it("returns null with no usable target", () => {
    expect(resolveHrTarget(entry())).toBeNull();
    expect(resolveHrTarget(entry({ targetHr: null, targetHeartRate: null }))).toBeNull();
    expect(resolveHrTarget(entry({ targetHeartRate: 0 }))).toBeNull();
  });
});

describe("formatHrTarget", () => {
  it("formats a cap, a range and a floor", () => {
    expect(formatHrTarget(CAP_135)).toBe("≤ 135");
    expect(formatHrTarget(RANGE_146_155)).toBe("146–155");
    expect(formatHrTarget({ minBpm: 140, maxBpm: null })).toBe("≥ 140");
  });
});

describe("evaluateHrTarget — cap 135", () => {
  it.each([134, 135, 137])("avg %i is on target", (avg) => {
    expect(evaluateHrTarget(CAP_135, avg).status).toBe("on-target");
  });
  it("is inside the bound (delta 0) at or below the cap", () => {
    expect(evaluateHrTarget(CAP_135, 134)).toEqual({
      kind: "cap",
      status: "on-target",
      avgBpm: 134,
      deltaBpm: 0,
    });
  });
  it("reports the delta within grace (137 → on-target, +2)", () => {
    expect(evaluateHrTarget(CAP_135, 137)).toEqual({
      kind: "cap",
      status: "on-target",
      avgBpm: 137,
      deltaBpm: 2,
    });
  });
  it("is over at 138 (+3)", () => {
    expect(evaluateHrTarget(CAP_135, 138)).toEqual({
      kind: "cap",
      status: "over",
      avgBpm: 138,
      deltaBpm: 3,
    });
  });
  it("judges the ROUNDED average (136.6 → 137)", () => {
    const r = evaluateHrTarget(CAP_135, 136.6);
    expect(r.avgBpm).toBe(137);
    expect(r.status).toBe("on-target");
    expect(evaluateHrTarget(CAP_135, 137.6).status).toBe("over");
  });
  it("is no-data for null, undefined, zero and NaN", () => {
    for (const v of [null, undefined, 0, NaN]) {
      expect(evaluateHrTarget(CAP_135, v)).toEqual({
        kind: "cap",
        status: "no-data",
        avgBpm: null,
        deltaBpm: null,
      });
    }
  });
  it("honors a custom grace", () => {
    expect(evaluateHrTarget(CAP_135, 136, 0).status).toBe("over");
  });
});

describe("evaluateHrTarget — range 146–155", () => {
  it.each([144, 150, 157])("avg %i is on target", (avg) => {
    expect(evaluateHrTarget(RANGE_146_155, avg).status).toBe("on-target");
  });
  it("is over at 158 (+3)", () => {
    expect(evaluateHrTarget(RANGE_146_155, 158)).toMatchObject({
      status: "over",
      deltaBpm: 3,
      kind: "range",
    });
  });
  it("is under-range at 143 (−3)", () => {
    expect(evaluateHrTarget(RANGE_146_155, 143)).toMatchObject({
      status: "under-range",
      deltaBpm: -3,
    });
  });
  it("reports a negative delta within grace below the min (144 → −2, on-target)", () => {
    expect(evaluateHrTarget(RANGE_146_155, 144)).toMatchObject({
      status: "on-target",
      deltaBpm: -2,
    });
  });
});

describe("evaluateHrTarget — floor", () => {
  it("is under-range below the min beyond grace and never over", () => {
    const floor: TargetHeartRate = { minBpm: 140, maxBpm: null };
    expect(evaluateHrTarget(floor, 137)).toMatchObject({ kind: "floor", status: "under-range" });
    expect(evaluateHrTarget(floor, 138).status).toBe("on-target");
    expect(evaluateHrTarget(floor, 190).status).toBe("on-target");
  });
});

describe("isMileOverTarget", () => {
  it("flags a mile above the cap beyond grace", () => {
    expect(isMileOverTarget(CAP_135, 138)).toBe(true);
    expect(isMileOverTarget(RANGE_146_155, 158)).toBe(true);
  });
  it("does not flag a mile within grace or below", () => {
    expect(isMileOverTarget(CAP_135, 137)).toBe(false);
    expect(isMileOverTarget(CAP_135, 120)).toBe(false);
    expect(isMileOverTarget(RANGE_146_155, 140)).toBe(false);
  });
  it("returns null when there is no mile HR", () => {
    expect(isMileOverTarget(CAP_135, null)).toBeNull();
    expect(isMileOverTarget(CAP_135, undefined)).toBeNull();
    expect(isMileOverTarget(CAP_135, 0)).toBeNull();
  });
  it("never flags a floor-only target", () => {
    expect(isMileOverTarget({ minBpm: 140, maxBpm: null }, 190)).toBe(false);
  });
});

describe("computeWeekHrCounters", () => {
  const avg = (n: number | null | undefined) => ({ avgHeartRate: n });

  it("counts an easy cap entry and a tempo range entry", () => {
    const entries = [
      entry({ id: "easy", workoutType: "easy", targetHeartRate: 135 }),
      entry({ id: "tempo", workoutType: "tempo", targetHr: RANGE_146_155 }),
    ];
    const matches: Record<string, ReturnType<typeof avg>> = {
      easy: avg(133),
      tempo: avg(150),
    };
    expect(computeWeekHrCounters(entries, (id) => matches[id] ?? null)).toEqual({
      easyUnderCap: { met: 1, total: 1 },
      workoutsInRange: { met: 1, total: 1 },
    });
  });

  it("counts an over-cap easy run in the total but not in met", () => {
    const entries = [entry({ id: "easy", workoutType: "long", targetHr: CAP_135 })];
    expect(computeWeekHrCounters(entries, () => avg(141)).easyUnderCap).toEqual({
      met: 0,
      total: 1,
    });
  });

  it("excludes a race, a split long run, an unmatched entry and a match with no avg HR", () => {
    const entries = [
      entry({ id: "race", workoutType: "race", targetHeartRate: 160 }),
      entry({ id: "split", workoutType: "long", targetHr: null, targetHeartRate: null }),
      entry({ id: "unmatched", workoutType: "easy", targetHeartRate: 135 }),
      entry({ id: "noavg", workoutType: "easy", targetHeartRate: 135 }),
    ];
    const matches: Record<string, ReturnType<typeof avg>> = {
      race: avg(158),
      split: avg(145),
      noavg: avg(null),
    };
    expect(computeWeekHrCounters(entries, (id) => matches[id] ?? null)).toEqual({
      easyUnderCap: { met: 0, total: 0 },
      workoutsInRange: { met: 0, total: 0 },
    });
  });

  it("includes a partial match (the caller supplies any match)", () => {
    const entries = [entry({ id: "easy", workoutType: "easy", targetHeartRate: 135 })];
    // A partial match is just a match with an average HR — same input shape.
    expect(computeWeekHrCounters(entries, () => avg(130)).easyUnderCap).toEqual({
      met: 1,
      total: 1,
    });
  });

  it("excludes rest entries and mismatched kind/workoutType pairs", () => {
    const entries = [
      entry({ id: "rest", runType: "rest", workoutType: "rest", targetHeartRate: 135 }),
      entry({ id: "easyRange", workoutType: "easy", targetHr: RANGE_146_155 }),
      entry({ id: "tempoCap", workoutType: "tempo", targetHr: CAP_135 }),
    ];
    expect(computeWeekHrCounters(entries, () => avg(140))).toEqual({
      easyUnderCap: { met: 0, total: 0 },
      workoutsInRange: { met: 0, total: 0 },
    });
  });
});

describe("parseHrTargetFromNotes", () => {
  it("parses the three live range forms", () => {
    expect(parseHrTargetFromNotes("HR 146-155 bpm")).toEqual({
      kind: "range",
      target: { minBpm: 146, maxBpm: 155 },
    });
    expect(parseHrTargetFromNotes("HR 155-165 bpm")).toEqual({
      kind: "range",
      target: { minBpm: 155, maxBpm: 165 },
    });
    expect(parseHrTargetFromNotes("HR 145-155 bpm. Optional 15-20 min shakeout Fri")).toEqual({
      kind: "range",
      target: { minBpm: 145, maxBpm: 155 },
    });
  });
  it("recognizes the split long-run form (with trailing text)", () => {
    expect(parseHrTargetFromNotes("HR <135 / 145-155 bpm")).toEqual({ kind: "split" });
    expect(
      parseHrTargetFromNotes("HR <135 / 145-155 bpm. Key session — full race dress rehearsal")
    ).toEqual({ kind: "split" });
  });
  it("returns null with no HR prefix", () => {
    expect(parseHrTargetFromNotes(undefined)).toBeNull();
    expect(parseHrTargetFromNotes(null)).toBeNull();
    expect(parseHrTargetFromNotes("")).toBeNull();
    expect(parseHrTargetFromNotes("Moved off New Year's Day; HR cap 135")).toBeNull();
    expect(parseHrTargetFromNotes("On track for 2:04:30 if 5mi < 44:50")).toBeNull();
  });
  it("throws on a malformed HR note", () => {
    expect(() => parseHrTargetFromNotes("HR abc")).toThrow(/Unrecognized HR note/);
    expect(() => parseHrTargetFromNotes("HR cap 135 — slow down")).toThrow();
  });
  it("throws when the parsed range is not a valid target", () => {
    expect(() => parseHrTargetFromNotes("HR 165-155 bpm")).toThrow(/not a valid target/);
  });
});

describe("toLegacyTargetHeartRate", () => {
  it("returns maxBpm only for a cap", () => {
    expect(toLegacyTargetHeartRate(CAP_135)).toBe(135);
  });
  it("returns null for a range, a floor and null", () => {
    expect(toLegacyTargetHeartRate(RANGE_146_155)).toBeNull();
    expect(toLegacyTargetHeartRate({ minBpm: 140, maxBpm: null })).toBeNull();
    expect(toLegacyTargetHeartRate(null)).toBeNull();
    expect(toLegacyTargetHeartRate(undefined)).toBeNull();
  });
});
