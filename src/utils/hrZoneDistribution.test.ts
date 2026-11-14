import { describe, it, expect } from "vitest";
import { buildHrZoneDistribution, type MileSplitSample } from "./hrZoneDistribution";
import { type HrZoneAnchors } from "./zones";

describe("buildHrZoneDistribution (% of HR reserve)", () => {
  // Reserve 115 → cuts at 134 / 145.5 / 157 / 168.5 bpm.
  const ANCHORS: HrZoneAnchors = { maxHr: 180, restingHr: 65 };

  it("handles a run with no HR data", () => {
    const runsMileSplits: MileSplitSample[][] = [
      [], // no HR data
    ];
    const result = buildHrZoneDistribution(runsMileSplits, ANCHORS);

    expect(result.runsCounted).toBe(0);
    expect(result.totalMiles).toBe(0);
    expect(result.zoneMiles[1]).toBe(0);
  });

  it("handles zone boundary edges (on a cut belongs to the higher zone)", () => {
    // Zone 1: < 134 bpm
    // Zone 2: 134 – 145.5 (134 on the cut → Z2)
    // Zone 3: 145.5 – 157 (146 first whole bpm)
    // Zone 4: 157 – 168.5 (157 on the cut → Z4)
    // Zone 5: >= 168.5 (169 first whole bpm)
    const runsMileSplits: MileSplitSample[][] = [
      [
        { mile: 1, bpm: 133, distance: 1.0 }, // Zone 1
        { mile: 2, bpm: 134, distance: 1.0 }, // Zone 2
        { mile: 3, bpm: 146, distance: 1.0 }, // Zone 3
        { mile: 4, bpm: 157, distance: 1.0 }, // Zone 4
        { mile: 5, bpm: 169, distance: 1.0 }, // Zone 5
      ],
    ];
    const result = buildHrZoneDistribution(runsMileSplits, ANCHORS);

    expect(result.runsCounted).toBe(1);
    expect(result.totalMiles).toBe(5.0);
    expect(result.zoneMiles[1]).toBe(1.0);
    expect(result.zoneMiles[2]).toBe(1.0);
    expect(result.zoneMiles[3]).toBe(1.0);
    expect(result.zoneMiles[4]).toBe(1.0);
    expect(result.zoneMiles[5]).toBe(1.0);
  });

  it("a 156 bpm mile at 180/65 lands in Z3 (79.1% of reserve), 157 in Z4", () => {
    const result = buildHrZoneDistribution(
      [
        [
          { mile: 1, bpm: 156, distance: 1.0 },
          { mile: 2, bpm: 157, distance: 1.0 },
        ],
      ],
      ANCHORS
    );
    expect(result.zoneMiles[3]).toBe(1.0);
    expect(result.zoneMiles[4]).toBe(1.0);
  });

  it("weights by mile distance (a partial last mile counts for its fraction)", () => {
    const result = buildHrZoneDistribution(
      [
        [
          { mile: 1, bpm: 140, distance: 1.0 }, // Z2
          { mile: 2, bpm: 150, distance: 0.5 }, // Z3
        ],
        [{ mile: 1, bpm: 160, distance: 1.0 }], // Z4
      ],
      ANCHORS
    );

    expect(result).toEqual({
      runsCounted: 2,
      totalMiles: 2.5,
      zoneMiles: { 1: 0, 2: 1.0, 3: 0.5, 4: 1.0, 5: 0 },
    });
  });

  it("changing only restingHr changes the distribution", () => {
    const miles: MileSplitSample[][] = [[{ mile: 1, bpm: 133, distance: 1.0 }]];
    const at65 = buildHrZoneDistribution(miles, { maxHr: 180, restingHr: 65 });
    const at60 = buildHrZoneDistribution(miles, { maxHr: 180, restingHr: 60 });
    expect(at65.zoneMiles[1]).toBe(1.0); // 133 < 134
    expect(at60.zoneMiles[2]).toBe(1.0); // Z2 cut is 132 at resting 60
  });

  it("invalid anchors (resting >= max) fall back to 185/60 and never produce NaN", () => {
    const result = buildHrZoneDistribution(
      [[{ mile: 1, bpm: 150, distance: 1.0 }]],
      { maxHr: 100, restingHr: 120 }
    );
    expect(result.zoneMiles[3]).toBe(1.0); // 185/60 cuts: 135 / 147.5 / 160 / 172.5
    expect(Number.isFinite(result.totalMiles)).toBe(true);
  });
});
