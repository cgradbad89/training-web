/**
 * Run-detail route-fetch gate.
 *
 * The full `route` subcollection is the biggest read on the run-detail page.
 * Once every route-derived artifact the page renders has been cached on the
 * workout doc / mileSplits docs, the route read can be skipped entirely and the
 * page rendered from cache. This module is the single source of truth for
 * "is every one of those caches present and fresh?" — a pure function so it can
 * be unit-tested and reused by the page effect.
 *
 * Fields checked (all must be present & fresh to skip the route read):
 *  - simplifiedPath          (map)                        — Phase 4
 *  - gapSecPerMile           (GAP KPI)                    — Phase 1
 *    PLUS gapNetRiseM + gapAggregateGradeFlat, the GAP KPI "flat" sublabel and
 *    the Total Ascent "Net ±X ft" sublabel signals. A doc carrying only
 *    gapSecPerMile (cached by a build before these two were added) is treated
 *    as INCOMPLETE so the next view re-reads the route ONCE to backfill them.
 *  - zoneBreakdown           (HR + pace zones)            — Phase 2
 *  - overlayChartCache       WITH a gapSecPerMile array   — Phase 3
 *    aligned to distancesMiles (a cache written by a build before GAP was
 *    cached has an empty/short array → treated as incomplete)
 *  - mileSplits per-mile GAP (Mile Splits table)          — Phase 1
 *
 * Point-count freshness (routeCacheFreshness.ts): when the parent reports an
 * iOS `routePointCount`, a cache computed from FEWER points is stale and forces
 * the route read, so a route that grew after the cache was written is recomputed
 * even though the workout's distance never changed. The overlay compares its own
 * `sourcePointCount`; zones/GAP KPI/map path compare `routeCacheBasisPointCount`
 * (or, for unstamped legacy docs, the zone coverage of the workout's duration).
 *
 * zoneBreakdown is settings-dependent, so it is only "fresh" when the maxHR and
 * threshold pace it was computed against still match the current values.
 */

import { type HealthWorkout } from "@/types/healthWorkout";
import {
  basisBelowExpected,
  expectedRoutePointCount,
  parentRouteCachesStale,
} from "@/utils/routeCacheFreshness";

export interface RouteCacheGateOptions {
  /** Current resolved maxHR (must match the cached zone breakdown's basis). */
  maxHr: number;
  /** Current threshold pace, or null when unset (must match the cached basis). */
  thresholdPace: number | null;
  /** Whether every mile in the mileSplits subcollection carries a fresh
   *  per-mile GAP (from cachedGapPerMile(docs, authoritativeMiles) != null). */
  splitsHaveGap: boolean;
}

/**
 * True when every route-derived cache needed to render the run-detail page is
 * present and fresh — i.e. the `route` subcollection read can be skipped.
 *
 * Accepts just the cache-bearing fields of the workout doc so it is trivial to
 * exercise in tests with partial objects.
 */
export function routeCachesComplete(
  w: Pick<
    HealthWorkout,
    | "gapSecPerMile"
    | "gapNetRiseM"
    | "gapAggregateGradeFlat"
    | "zoneBreakdown"
    | "simplifiedPath"
    | "overlayChartCache"
  > &
    Partial<
      Pick<
        HealthWorkout,
        "routePointCount" | "routeCacheBasisPointCount" | "durationSeconds"
      >
    >,
  opts: RouteCacheGateOptions
): boolean {
  const expectedPoints = expectedRoutePointCount(w);
  const overlay = w.overlayChartCache;
  const overlayOk =
    overlay !== undefined &&
    !basisBelowExpected(overlay.sourcePointCount, expectedPoints) &&
    Array.isArray(overlay.gapSecPerMile) &&
    overlay.gapSecPerMile.length > 0 &&
    overlay.gapSecPerMile.length === overlay.distancesMiles.length;

  const zone = w.zoneBreakdown;
  const zoneOk =
    zone !== undefined &&
    zone.maxHr === opts.maxHr &&
    zone.thresholdPaceSecPerMile === opts.thresholdPace;

  // All three GAP-KPI fields must be present: gapSecPerMile (the value) plus the
  // two sublabel signals. undefined on either sublabel field = a legacy
  // gapSecPerMile-only doc → incomplete → one backfilling route read. A null
  // gapNetRiseM counts as present (real geometry, no derivable net rise).
  const gapKpiOk =
    w.gapSecPerMile !== undefined &&
    w.gapNetRiseM !== undefined &&
    w.gapAggregateGradeFlat !== undefined;

  const pathOk =
    w.simplifiedPath !== undefined && w.simplifiedPath.length >= 2;

  return (
    overlayOk &&
    zoneOk &&
    gapKpiOk &&
    pathOk &&
    opts.splitsHaveGap &&
    !parentRouteCachesStale(w)
  );
}
