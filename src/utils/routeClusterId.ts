/**
 * Deterministic route-cluster ID.
 *
 * `clusterRoutesGeographic` (Routes page) groups runs by greedy PAIRWISE
 * comparison (distance ±0.5 mi AND start points ≤300 m apart), which cannot
 * assign a run a cluster in isolation. This module is the closest
 * single-run-deterministic approximation, used by the run-detail Route
 * Performance card so membership can be resolved with one narrow Firestore
 * query (`where('routeClusterId', '==', id)`) instead of an all-workouts scan:
 *
 *   - distance → nearest-integer mile bucket (members differ by < 1.0 mi,
 *     mirroring the pairwise ±0.5 mi tolerance around the bucket center);
 *   - start point → lat/lng snapped to a 0.003° grid (~333 m of latitude,
 *     approximating the 300 m start-proximity rule).
 *
 * KNOWN APPROXIMATION (flagged for product review): two runs that straddle a
 * bucket or grid-cell boundary can land in different clusters even though the
 * pairwise rule would have grouped them, and vice versa. The ID is stable and
 * version-prefixed (`v1_`) so the scheme can be migrated later.
 */

/** Grid cell size in degrees (~333 m of latitude). */
export const CLUSTER_GRID_DEG = 0.003;

export interface StartPoint {
  lat: number;
  lng: number;
}

function quantize(deg: number): string {
  const snapped = Math.round(deg / CLUSTER_GRID_DEG) * CLUSTER_GRID_DEG;
  // Fixed 4-decimal formatting keeps the ID stable across FP representations
  // (0.003 steps are exactly representable at 4 decimals: 0.0030, 0.0060, …).
  return snapped.toFixed(4);
}

/**
 * Derive the stable, deterministic cluster ID for a run. Same inputs always
 * produce the same ID; no other runs' data is consulted.
 *
 * `start` is the run's first GPS point (null when the route has no points —
 * those runs fall back to a distance-only bucket, mirroring the pairwise
 * algorithm's distance-only fallback for runs without a start point).
 */
export function deriveRouteClusterId(
  distanceMiles: number,
  start: StartPoint | null
): string {
  const safeMiles =
    Number.isFinite(distanceMiles) && distanceMiles > 0 ? distanceMiles : 0;
  const bucket = Math.round(safeMiles);

  if (
    !start ||
    !Number.isFinite(start.lat) ||
    !Number.isFinite(start.lng)
  ) {
    return `v1_d${bucket}_noloc`;
  }

  return `v1_d${bucket}_${quantize(start.lat)}_${quantize(start.lng)}`;
}

/**
 * True for the distance-only fallback IDs. A routed run can carry one only
 * because its start point wasn't resolvable when the ID was written (e.g. a
 * transient read failure) — writers treat such runs as still needing an ID so
 * they self-heal to a geographic ID on a later view.
 */
export function isNolocClusterId(id: string): boolean {
  return id.endsWith("_noloc");
}
