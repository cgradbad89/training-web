/**
 * Route-derived cache freshness — the point-count contract.
 *
 * iOS uploads a long GPS route in resumable passes (a 9.18 mi run was written as
 * 400 points, a 49-minute suspension, then 5,011 more) while the parent
 * workout's distance, duration and `routeComplete` marker never change in a way
 * a distance-only basis can see. iOS also writes the final number of route
 * documents on the parent as `routePointCount`.
 *
 * Every route-derived cache the web app persists (mile splits, per-mile GAP,
 * GAP KPI, zones, map path, overlay chart) records the number of route points it
 * was computed from. A cache computed from FEWER points than the parent now
 * reports is stale and is recomputed once, automatically, from the full route.
 *
 * Rules (all pure, no I/O):
 *  - Parent has no usable `routePointCount` (legacy / non-iOS) ⇒ nothing can be
 *    judged by count; behaviour is unchanged.
 *  - A cache with a recorded basis is fresh unless basis < routePointCount. A
 *    basis ≥ routePointCount is never stale (a recompute cannot make it more
 *    complete), so the recovery cannot loop.
 *  - A LEGACY cache (no recorded basis) cannot be compared by count, so its
 *    values are checked for physical plausibility against the workout's own
 *    facts (impossible paces; far less time than the workout lasted). A stamped
 *    cache is trusted and never plausibility-checked.
 */

import { type ZoneBreakdownCache } from "@/utils/zoneBreakdown";

/** A mile slower than this is a physically impossible running pace (2:00/mi). */
export const MIN_PLAUSIBLE_SPLIT_PACE_SEC = 120;

/** Cached moving time below this fraction of the workout's duration means the
 *  cache covers only a small part of the run (a truncated route). */
export const MIN_LEGACY_TIME_COVERAGE = 0.5;

/** The parent's iOS-reported route document count, or null when unusable. */
export function expectedRoutePointCount(
  w: { routePointCount?: number | null } | null | undefined
): number | null {
  const n = w?.routePointCount;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A recorded basis smaller than the parent's current count is stale. */
export function basisBelowExpected(
  basis: number | undefined | null,
  expected: number | null
): boolean {
  return (
    expected != null &&
    typeof basis === "number" &&
    Number.isFinite(basis) &&
    basis < expected
  );
}

/** The read returned fewer points than the parent says exist (still uploading,
 *  or a truncated in-memory copy). Nothing computed from it may be persisted. */
export function routeReadIncomplete(
  readCount: number,
  expected: number | null
): boolean {
  return expected != null && readCount < expected;
}

export interface SplitLike {
  paceSecPerMile: number;
  segmentMiles: number;
}

/**
 * Legacy (unstamped) per-mile cache plausibility. False when any mile has an
 * impossible pace, or when the cached moving time covers under half of the
 * workout's duration.
 */
export function legacySplitsPlausible(
  splits: readonly SplitLike[],
  durationSeconds: number | undefined
): boolean {
  if (splits.length === 0) return true;
  let movingSec = 0;
  for (const s of splits) {
    if (!(s.paceSecPerMile >= MIN_PLAUSIBLE_SPLIT_PACE_SEC)) return false;
    movingSec += s.paceSecPerMile * s.segmentMiles;
  }
  if (
    typeof durationSeconds === "number" &&
    durationSeconds > 0 &&
    movingSec < durationSeconds * MIN_LEGACY_TIME_COVERAGE
  ) {
    return false;
  }
  return true;
}

/** Seconds covered by the cached zones: the larger of HR and pace coverage (HR
 *  can be sparse; both being tiny means the route was truncated). */
function zoneCoverageSeconds(z: ZoneBreakdownCache): number {
  const hr = (z.hrZones ?? []).reduce((a, x) => a + (x.seconds || 0), 0);
  const pace = (z.paceZones ?? []).reduce(
    (a, x) => a + (x.secondsInZone || 0),
    0
  );
  return Math.max(hr, pace);
}

export interface ParentCacheFields {
  routePointCount?: number | null;
  routeCacheBasisPointCount?: number;
  durationSeconds?: number;
  zoneBreakdown?: ZoneBreakdownCache;
}

/**
 * True when the parent-doc route caches (zones, GAP KPI, map path) were
 * computed from fewer route points than the parent now reports.
 */
export function parentRouteCachesStale(w: ParentCacheFields): boolean {
  const expected = expectedRoutePointCount(w);
  if (expected == null) return false;
  if (w.routeCacheBasisPointCount !== undefined) {
    return basisBelowExpected(w.routeCacheBasisPointCount, expected);
  }
  // Legacy: no recorded basis. Judge the zone coverage against the workout.
  const z = w.zoneBreakdown;
  const d = w.durationSeconds;
  if (z && typeof d === "number" && d > 0) {
    return zoneCoverageSeconds(z) < d * MIN_LEGACY_TIME_COVERAGE;
  }
  return false;
}
