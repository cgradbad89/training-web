import { describe, it, expect } from "vitest";
import { routeCachesComplete } from "@/utils/runDetailCacheGate";
import { type OverlayChartCache } from "@/utils/overlayChartCache";
import { type ZoneBreakdownCache } from "@/utils/zoneBreakdown";
import { type HealthWorkout } from "@/types/healthWorkout";

const MAX_HR = 190;
const THRESHOLD = 480;

function overlay(withGap: boolean): OverlayChartCache {
  const len = 5;
  return {
    distancesMiles: [0, 1, 2, 3, 4],
    paceSecPerMile: [500, 500, 500, 500, 500],
    heartRateBpm: [150, 150, 150, 150, 150],
    elevationFt: [0, 1, 2, 3, 4],
    gapSecPerMile: withGap ? new Array(len).fill(490) : [],
    sourcePointCount: 1000,
    computedAt: 1,
  };
}

function zones(maxHr = MAX_HR, threshold: number | null = THRESHOLD): ZoneBreakdownCache {
  return {
    hrZones: [],
    paceZones: [],
    maxHr,
    thresholdPaceSecPerMile: threshold,
    computedAt: 1,
  };
}

// A fully-cached workout (all artifacts present & fresh, incl. the two GAP-KPI
// sublabel signals gapNetRiseM + gapAggregateGradeFlat).
function complete(): Pick<
  HealthWorkout,
  | "gapSecPerMile"
  | "gapNetRiseM"
  | "gapAggregateGradeFlat"
  | "zoneBreakdown"
  | "simplifiedPath"
  | "overlayChartCache"
> {
  return {
    gapSecPerMile: 490,
    gapNetRiseM: -12.4,
    gapAggregateGradeFlat: false,
    zoneBreakdown: zones(),
    simplifiedPath: [
      { lat: 40, lng: -105 },
      { lat: 41, lng: -106 },
    ],
    overlayChartCache: overlay(true),
  };
}

const OPTS = { maxHr: MAX_HR, thresholdPace: THRESHOLD, splitsHaveGap: true };

describe("routeCachesComplete", () => {
  it("is true when every cache is present and fresh", () => {
    expect(routeCachesComplete(complete(), OPTS)).toBe(true);
  });

  it("is false when the GAP KPI is missing", () => {
    expect(
      routeCachesComplete({ ...complete(), gapSecPerMile: undefined }, OPTS)
    ).toBe(false);
  });

  it("is false when the GAP net-rise sublabel field is missing", () => {
    expect(
      routeCachesComplete({ ...complete(), gapNetRiseM: undefined }, OPTS)
    ).toBe(false);
  });

  it("is false when the GAP flat-flag sublabel field is missing", () => {
    expect(
      routeCachesComplete(
        { ...complete(), gapAggregateGradeFlat: undefined },
        OPTS
      )
    ).toBe(false);
  });

  it("treats a gapSecPerMile-only doc (old shape, no sublabel fields) as incomplete", () => {
    // A run cached by the previous build wrote gapSecPerMile but neither
    // sublabel field — it must re-read the route ONCE to backfill them.
    expect(
      routeCachesComplete(
        {
          ...complete(),
          gapNetRiseM: undefined,
          gapAggregateGradeFlat: undefined,
        },
        OPTS
      )
    ).toBe(false);
  });

  it("treats a null gapNetRiseM as present (real geometry, no derivable net rise)", () => {
    // null is a valid cached value — the gate must NOT force a re-read for it.
    expect(
      routeCachesComplete({ ...complete(), gapNetRiseM: null }, OPTS)
    ).toBe(true);
  });

  it("is false when the zone breakdown is missing", () => {
    expect(
      routeCachesComplete({ ...complete(), zoneBreakdown: undefined }, OPTS)
    ).toBe(false);
  });

  it("is false when the simplified path is missing or too short", () => {
    expect(
      routeCachesComplete({ ...complete(), simplifiedPath: undefined }, OPTS)
    ).toBe(false);
    expect(
      routeCachesComplete(
        { ...complete(), simplifiedPath: [{ lat: 40, lng: -105 }] },
        OPTS
      )
    ).toBe(false);
  });

  it("is false when the overlay cache is missing", () => {
    expect(
      routeCachesComplete({ ...complete(), overlayChartCache: undefined }, OPTS)
    ).toBe(false);
  });

  it("treats an old-shape overlay cache (no gap array) as incomplete", () => {
    // Rest of the cache is populated, but gapSecPerMile is empty — a cache
    // written by a build before GAP was cached.
    expect(
      routeCachesComplete({ ...complete(), overlayChartCache: overlay(false) }, OPTS)
    ).toBe(false);
  });

  it("treats a length-mismatched overlay gap array as incomplete", () => {
    const bad = overlay(true);
    bad.gapSecPerMile = [490, 490]; // shorter than distancesMiles
    expect(
      routeCachesComplete({ ...complete(), overlayChartCache: bad }, OPTS)
    ).toBe(false);
  });

  it("is false when the mile-split GAP column is not fully cached", () => {
    expect(
      routeCachesComplete(complete(), { ...OPTS, splitsHaveGap: false })
    ).toBe(false);
  });

  it("treats a stale zone breakdown (settings changed) as incomplete", () => {
    // maxHR moved (age/profile change) → cached HR zones no longer valid.
    expect(
      routeCachesComplete({ ...complete(), zoneBreakdown: zones(185) }, OPTS)
    ).toBe(false);
    // threshold pace changed → cached pace zones no longer valid.
    expect(
      routeCachesComplete({ ...complete(), zoneBreakdown: zones(MAX_HR, 500) }, OPTS)
    ).toBe(false);
  });

  it("matches a null threshold basis when threshold is unset", () => {
    const w = { ...complete(), zoneBreakdown: zones(MAX_HR, null) };
    expect(
      routeCachesComplete(w, { maxHr: MAX_HR, thresholdPace: null, splitsHaveGap: true })
    ).toBe(true);
  });
});
