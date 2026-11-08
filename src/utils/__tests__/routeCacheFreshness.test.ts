import { describe, expect, it } from "vitest";
import type { RoutePoint } from "@/services/routes";
import {
  basisBelowExpected,
  expectedRoutePointCount,
  legacySplitsPlausible,
  MIN_PLAUSIBLE_SPLIT_PACE_SEC,
  parentRouteCachesStale,
  routeReadIncomplete,
} from "@/utils/routeCacheFreshness";
import {
  cachedGapPerMile,
  mileSplitCacheWrites,
  splitsFromCachedDocs,
} from "@/utils/mileSplitDocs";
import {
  computeMileSplits,
  MIN_ROUTE_COVERAGE,
  routeDistanceCoverage,
} from "@/utils/mileSplits";
import type { MileSplitDoc } from "@/utils/mileSplitsCache";
import type { ZoneBreakdownCache } from "@/utils/zoneBreakdown";

// The 2026-11-07 run: 9.177 mi, 5,413 s, 5,411 route documents written as 400
// points + a 49-minute suspension + the remaining 5,011.
const TOTAL_MI = 9.177;
const DURATION = 5413;
const FULL_POINTS = 5411;
const PARTIAL_POINTS = 400;

/** A straight 1 Hz route at ~9:50/mi (2.7286 m/s), `count` points long. */
function route(count: number): RoutePoint[] {
  const metersPerSec = 2.7286;
  const degPerMeter = 1 / 111_195;
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    lat: 38.8 + i * metersPerSec * degPerMeter,
    lng: -77.05,
    altitude: 10,
    timestamp: new Date(Date.UTC(2026, 10, 7, 13, 41, 40) + i * 1000).toISOString(),
    speed: metersPerSec,
    hr: 150,
  }));
}

/** The split docs exactly as the 2026-11-07 run left them: ~43 s/mi, unstamped. */
function staleNov7Docs(): MileSplitDoc[] {
  const paces = [43.5, 42.8, 44.6, 43.9, 39.9, 45.0, 44.1, 44.5, 43.5, 42.5];
  return paces.map((p, i) => ({
    id: String(i).padStart(3, "0"),
    mile: i + 1,
    distanceMiles: i === 9 ? 0.177 : 1,
    paceSecPerMile: p,
    gapSecPerMile: i === 0 ? 576 : 0,
    isPartial: i === 9,
    basisTotalMiles: TOTAL_MI,
    avgBpm: 155,
    sampleCount: 110,
  }));
}

function healthyDocs(extra: Record<string, unknown> = {}): MileSplitDoc[] {
  const paces = [604, 591, 600, 613, 587, 589, 589, 562, 565, 556];
  return paces.map((p, i) => ({
    id: String(i).padStart(3, "0"),
    mile: i + 1,
    distanceMiles: i === 9 ? 0.177 : 1,
    paceSecPerMile: p,
    gapSecPerMile: p - 5,
    isPartial: i === 9,
    basisTotalMiles: TOTAL_MI,
    ...extra,
  }));
}

const FRESH = { routePointCount: FULL_POINTS, durationSeconds: DURATION };

function zones(hrSeconds: number, paceSeconds: number): ZoneBreakdownCache {
  return {
    hrZones: [{ zone: 3, label: "Tempo", seconds: hrSeconds, pct: 100 }] as never,
    paceZones: [
      { zone: 3, label: "Threshold", secondsInZone: paceSeconds, percent: 100 },
    ] as never,
    maxHr: 180,
    thresholdPaceSecPerMile: 600,
    computedAt: 1,
  };
}

describe("point-count primitives", () => {
  it("accepts only positive safe integers as the expected count", () => {
    expect(expectedRoutePointCount({ routePointCount: 5411 })).toBe(5411);
    for (const bad of [undefined, null, 0, -3, 1.5, Number.NaN, Infinity]) {
      expect(expectedRoutePointCount({ routePointCount: bad as never })).toBeNull();
    }
    expect(expectedRoutePointCount(undefined)).toBeNull();
  });

  it("calls a basis stale only when strictly below the expected count", () => {
    expect(basisBelowExpected(400, 5411)).toBe(true);
    expect(basisBelowExpected(5411, 5411)).toBe(false);
    expect(basisBelowExpected(6000, 5411)).toBe(false); // can never loop
    expect(basisBelowExpected(undefined, 5411)).toBe(false); // legacy: not judged by count
    expect(basisBelowExpected(400, null)).toBe(false);
  });

  it("flags a read shorter than the parent's count as incomplete", () => {
    expect(routeReadIncomplete(400, 5411)).toBe(true);
    expect(routeReadIncomplete(5411, 5411)).toBe(false);
    expect(routeReadIncomplete(400, null)).toBe(false);
  });
});

describe("legacy plausibility", () => {
  it("rejects the Nov 7 cache (impossible 43 s/mi, 6.6% of the run's time)", () => {
    const splits = staleNov7Docs().map((d) => ({
      paceSecPerMile: d.paceSecPerMile as number,
      segmentMiles: d.distanceMiles as number,
    }));
    expect(legacySplitsPlausible(splits, DURATION)).toBe(false);
  });

  it("accepts a healthy run and a run with real stops", () => {
    const healthy = [{ paceSecPerMile: 590, segmentMiles: 1 }];
    expect(legacySplitsPlausible(healthy, 600)).toBe(true);
    expect(legacySplitsPlausible([...healthy, ...healthy], undefined)).toBe(true);
    expect(legacySplitsPlausible([], DURATION)).toBe(true);
  });

  it("rejects any physically impossible pace even when time coverage looks fine", () => {
    expect(
      legacySplitsPlausible(
        [
          { paceSecPerMile: MIN_PLAUSIBLE_SPLIT_PACE_SEC - 1, segmentMiles: 1 },
          { paceSecPerMile: 600, segmentMiles: 1 },
        ],
        1200
      )
    ).toBe(false);
  });
});

describe("parent-doc route caches", () => {
  it("is never stale when the parent reports no point count (legacy doc)", () => {
    expect(
      parentRouteCachesStale({ durationSeconds: DURATION, zoneBreakdown: zones(391, 399) })
    ).toBe(false);
  });

  it("is stale when the stamped basis is below the parent's count", () => {
    expect(
      parentRouteCachesStale({ routePointCount: FULL_POINTS, routeCacheBasisPointCount: PARTIAL_POINTS })
    ).toBe(true);
  });

  it("is fresh when the stamped basis meets the count, whatever the zone values", () => {
    expect(
      parentRouteCachesStale({
        routePointCount: FULL_POINTS,
        routeCacheBasisPointCount: FULL_POINTS,
        durationSeconds: DURATION,
        zoneBreakdown: zones(1, 1), // trusted: stamped caches are not re-judged
      })
    ).toBe(false);
  });

  it("detects the Nov 7 unstamped zones (391 s of a 5,413 s run)", () => {
    expect(
      parentRouteCachesStale({
        routePointCount: FULL_POINTS,
        durationSeconds: DURATION,
        zoneBreakdown: zones(391, 399),
      })
    ).toBe(true);
  });

  it("accepts unstamped zones that cover the workout", () => {
    expect(
      parentRouteCachesStale({
        routePointCount: FULL_POINTS,
        durationSeconds: DURATION,
        zoneBreakdown: zones(5402, 5400),
      })
    ).toBe(false);
  });

  it("uses the larger of HR and pace coverage (sparse HR alone is not stale)", () => {
    expect(
      parentRouteCachesStale({
        routePointCount: FULL_POINTS,
        durationSeconds: DURATION,
        zoneBreakdown: zones(900, 5400),
      })
    ).toBe(false);
  });
});

describe("mile-split cache validation by route point count", () => {
  it("rejects the stale Nov 7 docs although distance basis matches (regression)", () => {
    const docs = staleNov7Docs();
    // Before the contract this was accepted — and the 43 s/mi values were shown forever.
    expect(splitsFromCachedDocs(docs, TOTAL_MI)).not.toBeNull();
    expect(cachedGapPerMile(docs, TOTAL_MI)).not.toBeNull();
    // With the parent's point count the same docs are a cache miss.
    expect(splitsFromCachedDocs(docs, TOTAL_MI, FRESH)).toBeNull();
    expect(cachedGapPerMile(docs, TOTAL_MI, FRESH)).toBeNull();
  });

  it("rejects an initial partial upload cached under a stamped smaller basis", () => {
    const docs = healthyDocs({ basisRoutePointCount: PARTIAL_POINTS });
    expect(splitsFromCachedDocs(docs, TOTAL_MI, FRESH)).toBeNull();
    expect(cachedGapPerMile(docs, TOTAL_MI, FRESH)).toBeNull();
  });

  it("accepts the same docs once stamped with the complete count (route completion)", () => {
    const docs = healthyDocs({ basisRoutePointCount: FULL_POINTS });
    expect(splitsFromCachedDocs(docs, TOTAL_MI, FRESH)?.length).toBe(10);
    expect(cachedGapPerMile(docs, TOTAL_MI, FRESH)?.length).toBe(10);
  });

  it("does not recompute a healthy cached run: unstamped plausible legacy docs stay valid", () => {
    expect(splitsFromCachedDocs(healthyDocs(), TOTAL_MI, FRESH)?.length).toBe(10);
    expect(cachedGapPerMile(healthyDocs(), TOTAL_MI, FRESH)?.length).toBe(10);
  });

  it("trusts a stamped cache even if its values are odd — recovery cannot loop", () => {
    const docs = staleNov7Docs().map((d) => ({ ...d, basisRoutePointCount: FULL_POINTS }));
    expect(splitsFromCachedDocs(docs, TOTAL_MI, FRESH)).not.toBeNull();
  });

  it("is unchanged when the parent has no point count (legacy doc, treadmill, iOS older)", () => {
    expect(splitsFromCachedDocs(staleNov7Docs(), TOTAL_MI, { durationSeconds: DURATION })).not.toBeNull();
    expect(splitsFromCachedDocs(staleNov7Docs(), TOTAL_MI, { routePointCount: null })).not.toBeNull();
  });

  it("rejects when ANY mile row carries a stale stamp (mixed / duplicate docs)", () => {
    const docs = healthyDocs({ basisRoutePointCount: FULL_POINTS });
    docs.push({ ...docs[3], id: "mile_4", basisRoutePointCount: PARTIAL_POINTS });
    expect(splitsFromCachedDocs(docs, TOTAL_MI, FRESH)).toBeNull();
  });

  it("still returns null for a missing mile regardless of freshness", () => {
    const docs = healthyDocs({ basisRoutePointCount: FULL_POINTS }).filter((d) => d.mile !== 5);
    expect(splitsFromCachedDocs(docs, TOTAL_MI, FRESH)).toBeNull();
  });

  it("an in-place distance change still invalidates a stamped cache", () => {
    const docs = healthyDocs({ basisRoutePointCount: FULL_POINTS });
    expect(splitsFromCachedDocs(docs, TOTAL_MI + 0.5, FRESH)).toBeNull();
  });
});

describe("persisted split writes carry the point basis", () => {
  const splits = computeMileSplits(route(FULL_POINTS), null, TOTAL_MI);

  it("stamps basisRoutePointCount on every written doc", () => {
    const writes = mileSplitCacheWrites(splits, [], [], TOTAL_MI, FULL_POINTS);
    expect(writes.length).toBe(splits.length);
    expect(writes.every((w) => w.data.basisRoutePointCount === FULL_POINTS)).toBe(true);
  });

  it("omits the stamp when the count is unknown or invalid", () => {
    for (const bad of [undefined, 0, -1, 2.5]) {
      const writes = mileSplitCacheWrites(splits, [], [], TOTAL_MI, bad);
      expect("basisRoutePointCount" in writes[0].data).toBe(false);
    }
  });

  it("round-trips: a fresh stamped write is accepted by the validator", () => {
    const writes = mileSplitCacheWrites(splits, splits.map(() => 590), [], TOTAL_MI, FULL_POINTS);
    const docs: MileSplitDoc[] = writes.map((w) => ({ id: w.docId, ...w.data }));
    expect(splitsFromCachedDocs(docs, TOTAL_MI, FRESH)?.length).toBe(splits.length);
  });
});

describe("computeMileSplits on a partial route", () => {
  it("does not stretch a 400-point route to the full distance (regression: 43 s/mi)", () => {
    const partial = computeMileSplits(route(PARTIAL_POINTS), null, TOTAL_MI);
    expect(partial.length).toBeGreaterThan(0);
    for (const s of partial) {
      expect(s.paceSecPerMile).toBeGreaterThan(560); // ~9:50, not ~0:44
      expect(s.paceSecPerMile).toBeLessThan(620);
      expect(s.segmentMiles).toBeLessThan(1); // 0.66 mi covered, labelled honestly
      expect(s.isPartial).toBe(true);
    }
  });

  it("produces realistic splits from the complete route", () => {
    const full = computeMileSplits(route(FULL_POINTS), null, TOTAL_MI);
    expect(full.length).toBe(10);
    for (const s of full) {
      expect(s.paceSecPerMile).toBeGreaterThan(560);
      expect(s.paceSecPerMile).toBeLessThan(620);
    }
    expect(full[9].isPartial).toBe(true);
    expect(full[9].segmentMiles).toBeCloseTo(0.177, 2);
  });

  it("still anchors a normally-covering route to the authoritative total", () => {
    // GPS 1% short of the watch distance: scaling must still apply.
    const pts = route(FULL_POINTS);
    const raw = routeDistanceCoverage(pts, TOTAL_MI) as number;
    expect(raw).toBeGreaterThan(MIN_ROUTE_COVERAGE);
    const anchored = computeMileSplits(pts, null, raw * TOTAL_MI * 1.01);
    expect(anchored.reduce((a, s) => a + s.segmentMiles, 0)).toBeCloseTo(raw * TOTAL_MI * 1.01, 3);
  });

  it("reports coverage ≈ 0.07 for the partial route and ≈ 1 for the full one", () => {
    expect(routeDistanceCoverage(route(PARTIAL_POINTS), TOTAL_MI) as number).toBeLessThan(0.1);
    expect(routeDistanceCoverage(route(FULL_POINTS), TOTAL_MI) as number).toBeCloseTo(1, 1);
    expect(routeDistanceCoverage(route(1), TOTAL_MI)).toBeNull();
    expect(routeDistanceCoverage(route(10), 0)).toBeNull();
  });
});
