import { describe, it, expect } from "vitest";
import { buildHrZoneDistribution, type MileSplitSample } from "./hrZoneDistribution";

describe("buildHrZoneDistribution", () => {
  const MAX_HR = 185;

  it("handles a run with no HR data", () => {
    const runsMileSplits: MileSplitSample[][] = [
      [], // no HR data
    ];
    const result = buildHrZoneDistribution(runsMileSplits, MAX_HR);
    
    expect(result.runsCounted).toBe(0);
    expect(result.totalMiles).toBe(0);
    expect(result.zoneMiles[1]).toBe(0);
  });

  it("handles zone boundary edges per shared thresholds", () => {
    // Zone 1: < 60% (< 111 bpm)
    // Zone 2: 60-70% (111 - 129 bpm)
    // Zone 3: 70-80% (130 - 148 bpm)
    // Zone 4: 80-90% (149 - 166 bpm)
    // Zone 5: >= 90% (>= 167 bpm)
    const runsMileSplits: MileSplitSample[][] = [
      [
        { mile: 1, bpm: 110, distance: 1.0 }, // Zone 1
        { mile: 2, bpm: 111, distance: 1.0 }, // Zone 2
        { mile: 3, bpm: 130, distance: 1.0 }, // Zone 3
        { mile: 4, bpm: 149, distance: 1.0 }, // Zone 4
        { mile: 5, bpm: 167, distance: 1.0 }, // Zone 5
      ]
    ];
    const result = buildHrZoneDistribution(runsMileSplits, MAX_HR);
    
    expect(result.runsCounted).toBe(1);
    expect(result.totalMiles).toBe(5.0);
    expect(result.zoneMiles[1]).toBe(1.0);
    expect(result.zoneMiles[2]).toBe(1.0);
    expect(result.zoneMiles[3]).toBe(1.0);
    expect(result.zoneMiles[4]).toBe(1.0);
    expect(result.zoneMiles[5]).toBe(1.0);
  });

  it("regression test: produces identical output to previous inline logic", () => {
    const runsMileSplits: MileSplitSample[][] = [
      [
        { mile: 1, bpm: 120, distance: 1.0 }, // Zone 2
        { mile: 2, bpm: 140, distance: 0.5 }, // Zone 3
      ],
      [
        { mile: 1, bpm: 150, distance: 1.0 }, // Zone 4
      ]
    ];
    const result = buildHrZoneDistribution(runsMileSplits, MAX_HR);
    
    expect(result).toEqual({
      runsCounted: 2,
      totalMiles: 2.5,
      zoneMiles: {
        1: 0,
        2: 1.0,
        3: 0.5,
        4: 1.0,
        5: 0,
      }
    });
  });
});
