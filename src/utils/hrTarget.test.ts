import { describe, it, expect } from "vitest";
import type { PlannedRunEntry, TargetHeartRate } from "@/types/plan";
import {
  HR_TARGET_GRACE_BPM,
  HR_TARGET_INPUT_ERROR,
  computeWeekHrCounters,
  evaluateHrTarget,
  formatHrActualLabel,
  formatHrTarget,
  HR_PAUSE_GAP_SECONDS,
  hrTimedSamplesFromStream,
  isMileOverTarget,
  isTimeAboveCapEligible,
  percentTimeAbove,
  type HrTimedSample,
  isValidHrTarget,
  parseHrTargetFromNotes,
  parseHrTargetInputs,
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

describe("parseHrTargetInputs", () => {
  it("returns no target and no error when both are blank", () => {
    expect(parseHrTargetInputs("", "")).toEqual({ target: null, error: null });
    expect(parseHrTargetInputs("  ", " ")).toEqual({ target: null, error: null });
  });
  it("builds a cap, a floor and a range", () => {
    expect(parseHrTargetInputs("", "135")).toEqual({ target: CAP_135, error: null });
    expect(parseHrTargetInputs("140", "")).toEqual({
      target: { minBpm: 140, maxBpm: null },
      error: null,
    });
    expect(parseHrTargetInputs("146", "155")).toEqual({ target: RANGE_146_155, error: null });
  });
  it("errors on non-numeric, fractional, out-of-range and inverted input", () => {
    for (const [a, b] of [["abc", "150"], ["", "135.5"], ["", "300"], ["", "10"], ["160", "150"]]) {
      const r = parseHrTargetInputs(a, b);
      expect(r.target).toBeNull();
      expect(r.error).toBe(HR_TARGET_INPUT_ERROR);
    }
  });
});

describe("formatHrActualLabel", () => {
  const label = (t: TargetHeartRate, avg: number | null) => formatHrActualLabel(evaluateHrTarget(t, avg));

  it("on target inside the bounds", () => {
    expect(label(CAP_135, 133)).toBe("Avg 133 · on target");
    expect(label(RANGE_146_155, 150)).toBe("Avg 150 · on target");
  });
  it("on target within grace shows the signed delta", () => {
    expect(label(CAP_135, 137)).toBe("Avg 137 · on target (+2)");
    expect(label(RANGE_146_155, 157)).toBe("Avg 157 · on target (+2)");
    expect(label(RANGE_146_155, 144)).toBe("Avg 144 · on target (−2)");
  });
  it("over", () => {
    expect(label(CAP_135, 138)).toBe("Avg 138 · over by 3");
    expect(label(RANGE_146_155, 158)).toBe("Avg 158 · over by 3");
  });
  it("under-range", () => {
    expect(label(RANGE_146_155, 143)).toBe("Avg 143 · under by 3");
  });
  it("is null for no-data", () => {
    expect(label(CAP_135, null)).toBeNull();
  });
  it("uses the rounded average", () => {
    expect(label(CAP_135, 137.6)).toBe("Avg 138 · over by 3");
  });
});

describe("percentTimeAbove", () => {
  /** 1 Hz samples from a bpm list; the last sample only closes the final interval. */
  const at1Hz = (bpms: number[]): HrTimedSample[] => bpms.map((bpm, i) => ({ tSec: i, bpm }));

  it("is 0 when every interval is at or below the cap", () => {
    expect(percentTimeAbove(at1Hz([120, 130, 135, 100, 120]), 135)).toBe(0);
  });
  it("is 100 when every interval is above the cap", () => {
    expect(percentTimeAbove(at1Hz([140, 150, 160, 170, 150]), 135)).toBe(100);
  });
  it("applies the cap literally (equal to the cap is NOT above)", () => {
    expect(percentTimeAbove(at1Hz([135, 135, 136, 135]), 135)).toBeCloseTo(100 / 3, 10);
  });
  it("returns the exact percentage for a mix", () => {
    // intervals attributed to samples 0..3: 120,140,150,130 (last sample closes) → 2 of 4 above
    expect(percentTimeAbove(at1Hz([120, 140, 150, 130, 100]), 135)).toBe(50);
  });
  it("weights by interval length", () => {
    const samples: HrTimedSample[] = [
      { tSec: 0, bpm: 120 }, // 10 s below
      { tSec: 10, bpm: 150 }, // 5 s above
      { tSec: 15, bpm: 120 },
    ];
    expect(percentTimeAbove(samples, 135)).toBeCloseTo((5 / 15) * 100, 10);
  });
  it("skips a 45 s gap", () => {
    const samples: HrTimedSample[] = [
      { tSec: 0, bpm: 150 }, // 45 s pause → skipped entirely
      { tSec: 45, bpm: 120 }, // 5 s below
      { tSec: 50, bpm: 120 },
    ];
    expect(percentTimeAbove(samples, 135)).toBe(0);
  });
  it("counts a gap of exactly 30 s (the boundary)", () => {
    expect(HR_PAUSE_GAP_SECONDS).toBe(30);
    const samples: HrTimedSample[] = [
      { tSec: 0, bpm: 150 }, // exactly 30 s → counted, above
      { tSec: 30, bpm: 120 },
      { tSec: 40, bpm: 120 }, // 10 s below
    ];
    expect(percentTimeAbove(samples, 135)).toBe(75);
  });
  it("skips samples with an out-of-range bpm", () => {
    const samples: HrTimedSample[] = [
      { tSec: 0, bpm: 250 }, // skipped (would be above)
      { tSec: 10, bpm: 30 }, // skipped (would be below)
      { tSec: 20, bpm: 150 }, // 10 s above
      { tSec: 30, bpm: 120 },
    ];
    expect(percentTimeAbove(samples, 135)).toBe(100);
  });
  it("returns null for empty input, a single sample, or no valid time", () => {
    expect(percentTimeAbove([], 135)).toBeNull();
    expect(percentTimeAbove([{ tSec: 0, bpm: 150 }], 135)).toBeNull();
    expect(percentTimeAbove(at1Hz([300, 300, 300]), 135)).toBeNull();
  });
  it("skips intervals with dt <= 0", () => {
    const samples: HrTimedSample[] = [
      { tSec: 5, bpm: 150 },
      { tSec: 5, bpm: 150 }, // dt = 0 skipped
      { tSec: 4, bpm: 120 }, // dt < 0 skipped; then 6 s below
      { tSec: 10, bpm: 120 }, // 6 s below
      { tSec: 16, bpm: 120 },
    ];
    expect(percentTimeAbove(samples, 135)).toBe(0);
  });
  it("honors a custom max gap", () => {
    const samples: HrTimedSample[] = [
      { tSec: 0, bpm: 150 },
      { tSec: 20, bpm: 120 },
    ];
    expect(percentTimeAbove(samples, 135, 10)).toBeNull();
    expect(percentTimeAbove(samples, 135, 20)).toBe(100);
  });
});

describe("hrTimedSamplesFromStream", () => {
  it("maps the real hrStream shape to seconds since the first sample", () => {
    const out = hrTimedSamplesFromStream([
      { timestamp: "2026-11-18T12:00:00.000Z", hr: 120 },
      { timestamp: "2026-11-18T12:00:05.000Z", hr: 130 },
      { timestamp: "2026-11-18T12:01:00.500Z", hr: 140 },
    ]);
    expect(out).toEqual([
      { tSec: 0, bpm: 120 },
      { tSec: 5, bpm: 130 },
      { tSec: 60.5, bpm: 140 },
    ]);
  });
  it("drops samples with an unparseable timestamp and anchors on the first valid one", () => {
    const out = hrTimedSamplesFromStream([
      { timestamp: "", hr: 100 },
      { timestamp: "2026-11-18T12:00:10.000Z", hr: 120 },
      { timestamp: "2026-11-18T12:00:12.000Z", hr: 125 },
    ]);
    expect(out).toEqual([
      { tSec: 0, bpm: 120 },
      { tSec: 2, bpm: 125 },
    ]);
  });
  it("returns [] for an empty stream", () => {
    expect(hrTimedSamplesFromStream([])).toEqual([]);
  });
});

describe("isTimeAboveCapEligible", () => {
  it("is true for an easy or long run with a cap-only target", () => {
    expect(isTimeAboveCapEligible({ workoutType: "easy" }, CAP_135)).toBe(true);
    expect(isTimeAboveCapEligible({ workoutType: "long" }, CAP_135)).toBe(true);
  });
  it("is false for a tempo range, a race cap, a range on an easy run, or no target", () => {
    expect(isTimeAboveCapEligible({ workoutType: "tempo" }, RANGE_146_155)).toBe(false);
    expect(isTimeAboveCapEligible({ workoutType: "tempo" }, CAP_135)).toBe(false);
    expect(isTimeAboveCapEligible({ workoutType: "race" }, { minBpm: null, maxBpm: 160 })).toBe(false);
    expect(isTimeAboveCapEligible({ workoutType: "easy" }, RANGE_146_155)).toBe(false);
    expect(isTimeAboveCapEligible({ workoutType: "easy" }, null)).toBe(false);
    expect(isTimeAboveCapEligible({ workoutType: undefined }, CAP_135)).toBe(false);
  });
});
