/**
 * Route-availability resolution for the run detail page.
 *
 * The iOS headless background sync can write a populated `route` subcollection
 * but leave the parent workout doc's `hasRoute` flag false/missing if a short
 * background wake is suspended before the trailing flag write. The web must
 * therefore derive route availability from the DATA (the actual route-point
 * count it reads), not trust the parent flag alone — otherwise the map, mile
 * splits, pace/HR charts, overlay chart, and zone breakdown are all suppressed
 * for runs whose data actually exists.
 *
 * MIN_ROUTE_POINTS — a route needs >= 2 points to draw a polyline and to
 * compute mile splits / grade-adjusted pace; fewer is treated as no-route
 * (unchanged behavior, e.g. genuinely route-less Pilates/strength workouts).
 */
export const MIN_ROUTE_POINTS = 2;

/**
 * True when a route read of `routePointCount` points should be treated as
 * "routed" for downstream rendering and for fetching the dependent
 * subcollections (mileSplits / per-mile HR), regardless of the (possibly
 * stale) parent `hasRoute` flag.
 */
export function isRoutePresent(routePointCount: number): boolean {
  return routePointCount >= MIN_ROUTE_POINTS;
}

/**
 * Effective route flag for ALL downstream rendering on the run detail page:
 * true if the parent flag says routed OR the data proves it (>= 2 points were
 * actually read). A false/missing `hasRoute` no longer suppresses data that
 * exists; a genuinely route-less run (0–1 points) is unchanged.
 */
export function deriveEffectiveHasRoute(
  hasRouteFlag: boolean,
  routePointCount: number
): boolean {
  return hasRouteFlag || isRoutePresent(routePointCount);
}
