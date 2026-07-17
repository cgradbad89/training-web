import { describe, it, expect } from "vitest";
import {
  splitsFromCachedDocs,
  cachedGapPerMile,
  mileSplitCacheWrites,
} from "@/utils/mileSplitDocs";
import { type MileSplitDoc } from "@/utils/mileSplitsCache";
import { type MileSplit } from "@/utils/mileSplits";

/** A fully-cached 2.4 mi run: two full miles + a partial. */
function cachedDocs(basis = 2.4): MileSplitDoc[] {
  return [
    {
      id: "ios-1",
      mile: 1,
      distanceMiles: 1,
      paceSecPerMile: 540,
      isPartial: false,
      basisTotalMiles: basis,
      avgBpm: 150,
      sampleCount: 40,
    },
    {
      id: "ios-2",
      mile: 2,
      distanceMiles: 1,
      paceSecPerMile: 555,
      isPartial: false,
      basisTotalMiles: basis,
      avgBpm: 158,
      sampleCount: 1, // below the reliability gate — must NOT surface
    },
    {
      id: "mile_3",
      mile: 3,
      distanceMiles: 0.4,
      paceSecPerMile: 520,
      isPartial: true,
      basisTotalMiles: basis,
    },
  ];
}

describe("splitsFromCachedDocs", () => {
  it("rebuilds MileSplit[] from fully cached docs, merging gated HR", () => {
    const splits = splitsFromCachedDocs(cachedDocs(), 2.4);
    expect(splits).not.toBeNull();
    expect(splits!).toHaveLength(3);
    expect(splits![0]).toEqual({
      mile: 1,
      segmentMiles: 1,
      paceSecPerMile: 540,
      isPartial: false,
      avgBpm: 150,
    });
    // sampleCount < 2 → HR dropped
    expect(splits![1].avgBpm).toBeUndefined();
    expect(splits![2].isPartial).toBe(true);
    expect(splits![2].segmentMiles).toBeCloseTo(0.4);
  });

  it("returns null for empty or HR-only (iOS) docs — lazy fill triggers", () => {
    expect(splitsFromCachedDocs([], 2.4)).toBeNull();
    const iosOnly: MileSplitDoc[] = [
      { id: "a", mile: 1, avgBpm: 150, sampleCount: 30 },
      { id: "b", mile: 2, avgBpm: 155, sampleCount: 30 },
    ];
    expect(splitsFromCachedDocs(iosOnly, 2.4)).toBeNull();
  });

  it("returns null when any mile in 1..N is missing pace (partial cache)", () => {
    const docs = cachedDocs();
    delete docs[1].paceSecPerMile;
    expect(splitsFromCachedDocs(docs, 2.4)).toBeNull();
  });

  it("returns null when miles are non-contiguous", () => {
    const docs = cachedDocs().filter((d) => d.mile !== 2);
    expect(splitsFromCachedDocs(docs, 2.4)).toBeNull();
  });

  it("returns null when the cached basis no longer matches (distance edit)", () => {
    expect(splitsFromCachedDocs(cachedDocs(2.4), 3.1)).toBeNull();
  });

  it("merges duplicate docs for the same mile (iOS HR doc + web pace doc)", () => {
    const docs: MileSplitDoc[] = [
      { id: "ios-1", mile: 1, avgBpm: 149, sampleCount: 25 },
      {
        id: "mile_1",
        mile: 1,
        distanceMiles: 1,
        paceSecPerMile: 600,
        isPartial: true,
        basisTotalMiles: 1.0,
      },
    ];
    const splits = splitsFromCachedDocs(docs, 1.0);
    expect(splits).not.toBeNull();
    expect(splits![0]).toEqual({
      mile: 1,
      segmentMiles: 1,
      paceSecPerMile: 600,
      isPartial: true,
      avgBpm: 149,
    });
  });
});

describe("cachedGapPerMile", () => {
  function gapDocs(basis = 2.4): MileSplitDoc[] {
    return [
      { id: "m1", mile: 1, gapSecPerMile: 520, basisTotalMiles: basis },
      { id: "m2", mile: 2, gapSecPerMile: 505, basisTotalMiles: basis },
    ];
  }

  it("returns the per-mile GAP array (index = mile-1) when fully cached", () => {
    expect(cachedGapPerMile(gapDocs(), 2.4)).toEqual([520, 505]);
  });

  it("counts a 0 GAP (all-stopped mile) as cached", () => {
    const docs: MileSplitDoc[] = [
      { id: "m1", mile: 1, gapSecPerMile: 0, basisTotalMiles: 2.4 },
      { id: "m2", mile: 2, gapSecPerMile: 505, basisTotalMiles: 2.4 },
    ];
    expect(cachedGapPerMile(docs, 2.4)).toEqual([0, 505]);
  });

  it("returns null when any mile is missing GAP", () => {
    const docs: MileSplitDoc[] = [
      { id: "m1", mile: 1, gapSecPerMile: 520, basisTotalMiles: 2.4 },
      { id: "m2", mile: 2, basisTotalMiles: 2.4 }, // no gap
    ];
    expect(cachedGapPerMile(docs, 2.4)).toBeNull();
  });

  it("returns null when the basis total no longer matches (override)", () => {
    expect(cachedGapPerMile(gapDocs(2.4), 3.0)).toBeNull();
  });

  it("returns null for empty docs", () => {
    expect(cachedGapPerMile([], 2.4)).toBeNull();
  });
});

describe("mileSplitCacheWrites", () => {
  const computed: MileSplit[] = [
    { mile: 1, segmentMiles: 1, paceSecPerMile: 540, isPartial: false },
    { mile: 2, segmentMiles: 0.4, paceSecPerMile: 520, isPartial: true },
  ];

  it("reuses the existing doc ID per mile and mints mile_<n> otherwise", () => {
    const existing: MileSplitDoc[] = [
      { id: "iosDocA", mile: 1, avgBpm: 150, sampleCount: 20 },
    ];
    const writes = mileSplitCacheWrites(computed, [510, 505], existing, 1.4);
    expect(writes).toHaveLength(2);
    expect(writes[0].docId).toBe("iosDocA");
    expect(writes[1].docId).toBe("mile_2");
    expect(writes[0].data).toEqual({
      mile: 1,
      distanceMiles: 1,
      paceSecPerMile: 540,
      gapSecPerMile: 510,
      isPartial: false,
      basisTotalMiles: 1.4,
    });
  });

  it("drops invalid splits and never emits writes for empty input", () => {
    expect(mileSplitCacheWrites([], [], [], 1.4)).toEqual([]);
    const bad: MileSplit[] = [
      { mile: 1, segmentMiles: 0, paceSecPerMile: 540, isPartial: false },
      { mile: 2, segmentMiles: 1, paceSecPerMile: Number.NaN, isPartial: false },
    ];
    expect(mileSplitCacheWrites(bad, [], [], 1.4)).toEqual([]);
  });

  it("writes a 0 GAP (renders as —) when a mile has no GAP entry", () => {
    const writes = mileSplitCacheWrites(computed, [], [], 1.4);
    expect(writes[0].data.gapSecPerMile).toBe(0);
    expect(writes[1].data.gapSecPerMile).toBe(0);
  });

  it("round-trips: writes read back as the same splits", () => {
    const writes = mileSplitCacheWrites(computed, [510, 505], [], 1.4);
    const docs: MileSplitDoc[] = writes.map((w) => ({ id: w.docId, ...w.data }));
    const splits = splitsFromCachedDocs(docs, 1.4);
    expect(splits).toEqual([
      { mile: 1, segmentMiles: 1, paceSecPerMile: 540, isPartial: false, avgBpm: undefined },
      { mile: 2, segmentMiles: 0.4, paceSecPerMile: 520, isPartial: true, avgBpm: undefined },
    ]);
  });
});
